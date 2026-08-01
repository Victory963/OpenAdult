/**
 * HLS 流媒体路由 (framework core / 传输层)
 * ============================================================================
 * 架构定位
 * --------
 * 属于 `server/_core/` 框架核心中的「原始 Express 路由」层 —— 它刻意绕过 tRPC，
 * 因为 HLS 播放器 (hls.js / Safari 原生) 只会发起普通 HTTP GET，需要拿到
 * `application/vnd.apple.mpegurl` 文本与 `video/MP2T` 二进制，无法走 tRPC 的
 * JSON-RPC + superjson 协议。
 *
 * 主要导出物
 * ----------
 * - `default hlsRouter`  —— Express Router，由 `server/_core/index.ts` 挂载在
 *   `/api/hls` 前缀下。对外形成如下端点：
 *     * `GET  /api/hls/key/:videoId`          AES-128 解密密钥分发 (仅 real 模式)
 *     * `POST /api/hls/key/register`          转码服务回调注册密钥 (ADMIN_API_KEY 鉴权)
 *     * `GET  /api/hls/segment/:videoId`      正片分片 (real: 302 到 CDN / pseudo: 302 到 S3)
 *     * `GET  /api/hls/ad-segment/:adId`      广告分片 (同上)
 *     * `GET  /api/hls/manifest/:videoId.m3u8` master / variant playlist 生成 (SSAI 广告拼接)
 *
 * 上下游依赖
 * ----------
 * 上游调用方：浏览器中的 `client/src/components/VideoPlayer.tsx` (hls.js)，
 *            以及 CDN 层的 OpenResty (`deploy/openresty/lua/`) 回源。
 * 下游依赖：  `getDb()` (server/db.ts) 读 videos / ads / ad_placements 表；
 *            `storageGet()` (server/storage.ts) 换取 S3 presigned URL。
 *
 * 关键设计决策与坑
 * ----------------
 * 1. 双模式 (HLS_MODE)：
 *    - `pseudo`（默认，开发/Manus 托管环境）：没有 FFmpeg 预转码产物，manifest 里
 *      每个 `#EXTINF` 分片 URL 都指回 `/api/hls/segment/:videoId`，由该端点 302 到
 *      完整 MP4，实际靠播放器自身的 byte-range seek 工作。属于「伪 HLS」。
 *    - `real`（生产）：FFmpeg 已把视频切成 `seg0000.ts` 并按 360p/480p/720p/1080p
 *      分目录放到 CDN，manifest 直接引用 CDN 绝对 URL。
 * 2. SSAI（服务端广告拼接）在 manifest 生成阶段完成：把广告分片以
 *    `#EXT-X-DISCONTINUITY` 包裹后插进播放列表，客户端无法用广告拦截器过滤掉
 *    （因为广告与正片同源、同一条播放列表）。
 * 3. 密钥服务当前是**简化实现**：密钥写在 `process.env` 而非数据库，见文中 TODO；
 *    这意味着进程重启即丢失、且多实例部署不共享。
 * ============================================================================
 */
import { Router, Request, Response } from "express";
import { getDb } from "../db";
import { videos, ads } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { storageGet } from "../storage";

const hlsRouter = Router();

// === 环境配置 ===
// 注意：这两个常量在模块加载时求值一次，运行时修改 process.env 不会生效
// （与下方 key/register 往 process.env 写密钥的做法不同——那些是按请求读取的）。
const CDN_BASE_URL = process.env.CDN_BASE_URL || ""; // 生产环境: https://cdn.openadult.com
const HLS_MODE = process.env.HLS_MODE || "pseudo"; // "pseudo" | "real"
// pseudo = 开发/Manus环境 (单MP4 byte-range模拟)
// real = 生产环境 (FFmpeg预转码的真实.ts片段, 从S3/CDN提供)
// 只有 real + CDN_BASE_URL 同时具备时才会走 CDN 分支；缺一个就自动降级为 pseudo，
// 这样本地开发无需任何 CDN 配置即可播放。

/**
 * HLS 加密密钥服务
 * GET /api/hls/key/:videoId
 *
 * 生产环境: 返回 AES-128 密钥 (16字节)
 * 开发环境: 返回空密钥 (不加密)
 *
 * ---- 详细说明 ----
 * 权限级别：public（无登录态），仅靠 Referer 白名单做弱防护。播放器在解析到
 * `#EXT-X-KEY:METHOD=AES-128,URI=...` 时会自动请求本端点，且请求由 <video> 元素
 * 底层发出，无法附带自定义 header，因此这里只能用 Referer/Cookie 之类的隐式凭据。
 *
 * @param req.params.videoId 视频 ID（字符串，此处不做数值校验，仅用于拼 env key）
 * @returns real 模式：16 字节二进制密钥（Content-Type: application/octet-stream）；
 *          pseudo 模式：404 JSON（表示本环境不加密，播放器不会请求到这里）
 * @throws  捕获所有异常并返回 500，不向客户端泄露堆栈
 * 副作用：读数据库连接（当前仅做可用性检查，尚未真正查表）
 */
hlsRouter.get("/key/:videoId", async (req: Request, res: Response) => {
  try {
    const videoId = req.params.videoId;
    
    if (HLS_MODE === "real") {
      // 生产环境: 从数据库获取加密密钥
      const db = await getDb();
      if (!db) return res.status(500).json({ error: "DB unavailable" });
      
      // TODO: 从 encryption_keys 表获取密钥
      // 验证 Referer / Token 防止密钥泄露
      //
      // 防盗链思路：密钥一旦泄露，别人拿到 .ts 片段就能自行解密并转存，所以要求
      // 请求必须来自我方站点。ALLOWED_ORIGINS 是逗号分隔的域名白名单。
      const referer = req.headers.referer || "";
      const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",");

      if (allowedOrigins.length > 0 && !allowedOrigins.some(o => referer.includes(o))) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // 返回16字节密钥 (示例: 实际从DB读取)
      // 每个视频一把独立密钥，按 `HLS_KEY_<videoId>` 约定存放在进程环境变量里
      // （由下方 /key/register 端点写入）。32 个 hex 字符 = 16 字节 = AES-128 密钥长度，
      // 全零串只是「未注册密钥」时的占位默认值。
      const keyHex = process.env[`HLS_KEY_${videoId}`] || "00000000000000000000000000000000";
      const keyBuffer = Buffer.from(keyHex, "hex");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(keyBuffer);
    } else {
      // 开发环境: 不加密
      res.status(404).json({ error: "Key service not available in dev mode" });
    }
  } catch (error) {
    console.error("[HLS] Error serving key:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * 密钥注册接口 (供转码服务调用)
 * POST /api/hls/key/register
 *
 * ---- 详细说明 ----
 * 权限级别：机器对机器（M2M），使用 `Authorization: Bearer <ADMIN_API_KEY>` 校验，
 * 不走 OAuth / adminProcedure —— 因为调用方是 Docker 里的 transcoder 容器
 * (`deploy/docker/Dockerfile.transcoder`)，它没有浏览器 Cookie。
 *
 * 调用时机：FFmpeg 完成一个视频的 HLS 加密切片后，把它生成的 AES 密钥回传上来，
 * 之后播放器请求 /api/hls/key/:videoId 才能拿到正确的密钥。
 *
 * @param req.body.videoId 视频 ID（必填）
 * @param req.body.keyHex  32 个 hex 字符的 AES-128 密钥（必填）
 * @param req.body.iv      可选的初始化向量 hex 串；缺省时存空串
 * @returns { success: true }
 * 副作用：写入 `process.env.HLS_KEY_<id>` / `process.env.HLS_IV_<id>`（进程内内存，
 *         重启即丢，且多副本部署时各副本互不可见——见 TODO，应改为落库）
 */
hlsRouter.post("/key/register", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const adminKey = process.env.ADMIN_API_KEY || "";
    
    if (!adminKey || authHeader !== `Bearer ${adminKey}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const { videoId, keyHex, iv } = req.body;
    if (!videoId || !keyHex) {
      return res.status(400).json({ error: "Missing videoId or keyHex" });
    }
    
    // TODO: 存储到 encryption_keys 表
    // 当前简化实现: 存储为环境变量 (生产环境应使用数据库)
    process.env[`HLS_KEY_${videoId}`] = keyHex;
    process.env[`HLS_IV_${videoId}`] = iv || "";
    
    res.json({ success: true });
  } catch (error) {
    console.error("[HLS] Error registering key:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Serve a video segment via byte-range proxy from S3
 * GET /api/hls/segment/:videoId?start=0&duration=6
 *
 * 开发模式: 从S3代理整个MP4 (hls.js处理seeking)
 * 生产模式: 重定向到CDN上的真实.ts片段
 *
 * ---- 详细说明 ----
 * 权限级别：public（视频分片必须可被 <video> 直接拉取，无法带鉴权 header）。
 *
 * @param req.params.videoId 视频 ID，必须能 parseInt 成功，否则 400
 * @param req.query.seg      real 模式下的分片序号，用于拼 `seg0000.ts`（默认 "0"）
 * @param req.query.q        real 模式下的码率标识，如 720p（默认 "720p"）
 * @param req.query.start/dur pseudo 模式下由 manifest 带上的时间偏移，当前**未被使用**
 *                            （见文件顶部说明：伪 HLS 靠播放器自身 seek）
 * @returns 302 重定向到 CDN 绝对 URL（real）或 S3 presigned URL（pseudo）
 *
 * 为什么用 302 而不是自己代理字节流：让流量直接走 CDN / S3，Node 进程不承担带宽，
 * 也避免长连接占满 event loop。代价是 presigned URL 会暴露在浏览器网络面板中。
 */
hlsRouter.get("/segment/:videoId", async (req: Request, res: Response) => {
  try {
    const videoId = parseInt(req.params.videoId);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const db = await getDb();
    if (!db) return res.status(500).json({ error: "DB unavailable" });

    const video = await db
      .select()
      .from(videos)
      .where(eq(videos.id, videoId))
      .limit(1);

    if (video.length === 0) {
      return res.status(404).json({ error: "Video not found" });
    }

    const videoData = video[0];
    const videoUrl = videoData.videoUrl;

    if (!videoUrl) {
      return res.status(404).json({ error: "No video URL" });
    }

    if (HLS_MODE === "real" && CDN_BASE_URL) {
      // 生产模式: 重定向到CDN (真实.ts片段)
      // CDN 上的目录约定由 FFmpeg 转码脚本 (deploy/ffmpeg/) 保证：
      //   {CDN}/videos/{storageKey}/{quality}/seg0000.ts
      // padStart(4,'0') 的 4 位宽度对应 FFmpeg `-hls_segment_filename seg%04d.ts`，
      // 支持最多 10000 个分片（6s/片 ≈ 16.6 小时），足够长片使用。
      // storageKey 缺失时回退用数字 videoId 作为目录名（早期数据没有 storageKey）。
      const segIndex = req.query.seg || "0";
      const quality = req.query.q || "720p";
      const cdnUrl = `${CDN_BASE_URL}/videos/${(videoData as any).storageKey || videoId}/${quality}/seg${String(segIndex).padStart(4, '0')}.ts`;
      return res.redirect(302, cdnUrl);
    }

    // 开发模式: 从S3代理MP4
    // videoUrl 有两种形态：内部相对路径 `/manus-storage/<key>` 需要换成带签名的
    // 临时下载地址；已经是外链的绝对 URL 则原样使用。
    let resolvedUrl: string;
    if (videoUrl.startsWith("/manus-storage/")) {
      const key = videoUrl.replace("/manus-storage/", "");
      const { url } = await storageGet(key);
      resolvedUrl = url;
    } else {
      resolvedUrl = videoUrl;
    }

    res.redirect(302, resolvedUrl);
  } catch (error) {
    console.error("[HLS] Error serving segment:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Serve an ad video segment
 * GET /api/hls/ad-segment/:adId
 *
 * 生产模式: 重定向到CDN上的广告.ts片段
 * 开发模式: 重定向到S3上的广告MP4
 *
 * ---- 详细说明 ----
 * 权限级别：public。与 /segment 完全同构，只是数据源换成 ads 表。
 * 之所以拆成独立端点而不是复用 /segment：广告与正片在 CDN 上分处
 * `/ads/**` 与 `/videos/**` 两棵目录树，且未来广告需要单独统计曝光。
 *
 * @param req.params.adId 广告 ID，必须能 parseInt 成功，否则 400
 * @param req.query.seg   分片序号（默认 "0"）
 * @param req.query.q     码率标识（默认 "720p"）
 * @returns 302 重定向；广告不存在返回 404
 */
hlsRouter.get("/ad-segment/:adId", async (req: Request, res: Response) => {
  try {
    const adId = parseInt(req.params.adId);
    if (isNaN(adId)) {
      return res.status(400).json({ error: "Invalid ad ID" });
    }

    const db = await getDb();
    if (!db) return res.status(500).json({ error: "DB unavailable" });

    const ad = await db
      .select()
      .from(ads)
      .where(eq(ads.id, adId))
      .limit(1);

    if (ad.length === 0) {
      return res.status(404).json({ error: "Ad not found" });
    }

    const adData = ad[0];
    const adVideoUrl = adData.videoUrl;

    if (HLS_MODE === "real" && CDN_BASE_URL) {
      // 生产模式: 重定向到CDN
      // 目录约定：{CDN}/ads/{storageKey|adId}/{quality}/seg%04d.ts，与正片对称。
      const segIndex = req.query.seg || "0";
      const quality = req.query.q || "720p";
      const cdnUrl = `${CDN_BASE_URL}/ads/${(adData as any).storageKey || adId}/${quality}/seg${String(segIndex).padStart(4, '0')}.ts`;
      return res.redirect(302, cdnUrl);
    }

    // 开发模式: 从S3代理
    // 同 /segment：内部 `/manus-storage/` 路径要先换成 presigned URL 再 302。
    let resolvedUrl: string;
    if (adVideoUrl.startsWith("/manus-storage/")) {
      const key = adVideoUrl.replace("/manus-storage/", "");
      const { url } = await storageGet(key);
      resolvedUrl = url;
    } else {
      resolvedUrl = adVideoUrl;
    }

    res.redirect(302, resolvedUrl);
  } catch (error) {
    console.error("[HLS] Error serving ad segment:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Serve the m3u8 manifest
 * GET /api/hls/manifest/:videoId.m3u8
 *
 * 生产模式: 生成指向CDN .ts片段的m3u8 (多码率 master playlist)
 * 开发模式: 生成伪HLS manifest (byte-range模拟)
 *
 * ---- 详细说明 ----
 * 这是整个 SSAI（Server-Side Ad Insertion，服务端广告拼接）的核心：广告不是由
 * 前端播放器额外加载的，而是在这里被直接**编织进播放列表**，因此浏览器广告拦截
 * 插件无从下手（广告分片和正片分片同域、同扩展名、同一份 m3u8）。
 *
 * 权限级别：public。
 *
 * @param req.params.videoId 路由形如 `/manifest/12.m3u8`，Express 会把 `12` 交给
 *                           :videoId（`.m3u8` 是字面量后缀）
 * @param req.query.q        real 模式下的码率；**不传** = 请求 master playlist，
 *                           传了 = 请求该码率的 variant playlist
 * @returns `application/vnd.apple.mpegurl` 文本；duration 未知时 302 回退到
 *          `/api/video-stream/:id`（渐进式下载播放，不走 HLS）
 * 副作用：查询 videos、ad_placements、ads 三张表（只读）
 *
 * 缓存策略：no-cache —— 因为广告投放随时可能被后台改动，manifest 必须每次重算。
 */
hlsRouter.get("/manifest/:videoId.m3u8", async (req: Request, res: Response) => {
  try {
    const videoId = parseInt(req.params.videoId);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const db = await getDb();
    if (!db) return res.status(500).json({ error: "DB unavailable" });

    const video = await db
      .select()
      .from(videos)
      .where(eq(videos.id, videoId))
      .limit(1);

    if (video.length === 0) {
      return res.status(404).json({ error: "Video not found" });
    }

    const videoData = video[0];
    const videoDuration = videoData.duration || 0;

    // 没有时长元数据就无法切分片（每个 #EXTINF 都需要知道时长），
    // 此时降级为渐进式下载端点，至少保证视频能播。
    if (videoDuration <= 0) {
      return res.redirect(302, `/api/video-stream/${videoId}`);
    }

    // Import the ad logic
    // 这里用动态 import 而非顶层 import：避免 hlsRoutes 与 schema/drizzle-orm 之间
    // 形成额外的模块加载依赖，同时让广告相关代码只在真正生成 manifest 时才载入。
    const { adPlacements, ads: adsTable } = await import("../../drizzle/schema");
    const { and, or, isNull } = await import("drizzle-orm");

    // Get active placements
    // 取出对本视频生效的广告投放位：
    //   - placement 与 ad 双方都必须 isActive（后台可单独下线某个素材或某个投放位）
    //   - videoId 相等 = 该视频专属投放；videoId IS NULL = 全站通投
    // innerJoin 保证只返回素材仍存在的投放位。
    const placements = await db
      .select({
        position: adPlacements.position,
        insertAtSeconds: adPlacements.insertAtSeconds,
        midRollInterval: adPlacements.midRollInterval,
        adId: adsTable.id,
        adVideoUrl: adsTable.videoUrl,
        adDuration: adsTable.duration,
        adClickUrl: adsTable.clickUrl,
      })
      .from(adPlacements)
      .innerJoin(adsTable, eq(adPlacements.adId, adsTable.id))
      .where(
        and(
          eq(adPlacements.isActive, true),
          eq(adsTable.isActive, true),
          or(
            eq(adPlacements.videoId, videoId),
            isNull(adPlacements.videoId)
          )
        )
      );

    // === 生产模式: 生成 Master Playlist (多码率) ===
    if (HLS_MODE === "real" && CDN_BASE_URL) {
      const quality = req.query.q as string;
      
      if (!quality) {
        // 返回 Master Playlist
        // Master playlist 只罗列各档码率及其 variant playlist 地址，播放器据此做 ABR
        // （自适应码率切换）。BANDWIDTH 单位是 bps，取值来自转码预设的目标码率 +
        // 音频与容器开销的经验估算；CODECS 是 RFC 6381 字符串：
        //   avc1.640028 = H.264 High@L4.0 (1080p)
        //   avc1.64001f = H.264 High@L3.1 (720p)
        //   avc1.4d401e = H.264 Main@L3.0 (480p)
        //   avc1.42e015 = H.264 Baseline@L2.1 (360p，兼容老设备)
        //   mp4a.40.2   = AAC-LC
        // 声明准确的 CODECS 能让播放器在起播前就判断是否支持，避免下载后才失败。
        // 排在最前的 1080p 通常被 hls.js 当作初始码率候选。
        const masterLines: string[] = [];
        masterLines.push("#EXTM3U");
        masterLines.push("#EXT-X-VERSION:6");
        masterLines.push("");
        masterLines.push(`#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",NAME="1080p"`);
        masterLines.push(`/api/hls/manifest/${videoId}.m3u8?q=1080p`);
        masterLines.push(`#EXT-X-STREAM-INF:BANDWIDTH=2900000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",NAME="720p"`);
        masterLines.push(`/api/hls/manifest/${videoId}.m3u8?q=720p`);
        masterLines.push(`#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,CODECS="avc1.4d401e,mp4a.40.2",NAME="480p"`);
        masterLines.push(`/api/hls/manifest/${videoId}.m3u8?q=480p`);
        masterLines.push(`#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.42e015,mp4a.40.2",NAME="360p"`);
        masterLines.push(`/api/hls/manifest/${videoId}.m3u8?q=360p`);
        
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "no-cache");
        return res.send(masterLines.join("\n"));
      }
      
      // 返回特定码率的 Variant Playlist (带广告)
      return generateVariantPlaylist(res, videoId, videoData, quality, videoDuration, placements);
    }

    // === 开发模式: 伪HLS (单码率, byte-range模拟) ===
    // baseUrl 用请求头里的 host 拼绝对地址，这样在 localhost / 预览域名 / 生产域名
    // 之间切换时无需额外配置（注意：反代场景依赖 trust proxy 才能拿到正确 protocol）。
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const lines: string[] = [];
    lines.push("#EXTM3U");
    lines.push("#EXT-X-VERSION:3"); // v3 即可满足 #EXTINF 浮点时长；不用高版本以兼容老播放器
    // TARGETDURATION 必须 >= 列表中最长的 #EXTINF（协议硬性要求，否则部分播放器直接报错）。
    // 正片分片固定 6s，广告可能更长，所以取 max(6, 所有广告时长) 再向上取整。
    lines.push(`#EXT-X-TARGETDURATION:${Math.ceil(Math.max(6, ...placements.map(p => p.adDuration || 6)))}`);
    lines.push("#EXT-X-MEDIA-SEQUENCE:0");
    lines.push("#EXT-X-PLAYLIST-TYPE:VOD"); // 点播：播放列表不会再增长，播放器可放心 seek

    // Categorize ads
    // 三类广告位：贴片前(pre-roll)/中插(mid-roll)/贴片后(post-roll)。
    // pre/post 各只取第一条（slice(0,1)）——多条前贴片会严重伤害完播率。
    const preRollAds = placements.filter(p => p.position === "pre-roll").slice(0, 1);
    const postRollAds = placements.filter(p => p.position === "post-roll").slice(0, 1);
    const midRollPlacements = placements.filter(p => p.position === "mid-roll");

    // Calculate mid-roll insertion points
    // 中插点有两种配置方式，优先级：周期性 > 固定时间点
    //   1) midRollInterval > 0：每隔 N 秒插一次，展开成一串插入点
    //   2) insertAtSeconds：只在某个绝对秒数插一次
    // `videoDuration - 30` 这个 30 秒保护带的含义：片尾 30 秒内不再插中插广告，
    // 否则广告紧贴 post-roll 会连播两条，观感极差，且末尾分片可能不足一个广告长度。
    const midRollPoints: { insertAt: number; adId: number; duration: number }[] = [];
    for (const p of midRollPlacements) {
      if (p.midRollInterval && p.midRollInterval > 0) {
        let insertAt = p.midRollInterval;
        while (insertAt < videoDuration - 30) {
          midRollPoints.push({ insertAt, adId: p.adId, duration: p.adDuration });
          insertAt += p.midRollInterval;
        }
      } else if (p.insertAtSeconds) {
        midRollPoints.push({ insertAt: p.insertAtSeconds, adId: p.adId, duration: p.adDuration });
      }
    }
    // 多个 placement 展开后的插入点是交错的，必须按时间排序，
    // 下面主循环才能用「单指针 midRollIdx 顺序推进」的方式消费它们。
    midRollPoints.sort((a, b) => a.insertAt - b.insertAt);

    // Pre-roll ads
    // #EXT-X-DISCONTINUITY 前后各加一条：告诉播放器此处编码参数/时间戳(PTS)会跳变，
    // 需要重置解码器。广告与正片是分别转码的，缺了这个标记会花屏或音画不同步。
    for (const ad of preRollAds) {
      lines.push("#EXT-X-DISCONTINUITY");
      lines.push(`#EXTINF:${(ad.adDuration || 15).toFixed(3)},`); // 15s 是广告时长缺省值
      lines.push(`${baseUrl}/api/hls/ad-segment/${ad.adId}`);
      lines.push("#EXT-X-DISCONTINUITY");
    }

    // Main content with mid-roll insertion
    // 主循环：以 6 秒为步长扫过整个时间轴，边走边在到点处插入中插广告。
    // segDur = 6 是 HLS 的行业惯例（Apple 建议 6s）：太短则请求数暴涨，
    // 太长则起播延迟与码率切换粒度变差。
    let currentTime = 0;
    let midRollIdx = 0;
    const segDur = 6;

    while (currentTime < videoDuration) {
      // 中插命中判断：因为分片按 6s 对齐，广告实际会插在「不晚于配置时间的下一个
      // 分片边界」处（HLS 不允许在分片中间插入）。每次只消费一个插入点，
      // 若两个插入点落在同一边界，多余的会在下一轮循环继续插入。
      if (midRollIdx < midRollPoints.length && currentTime >= midRollPoints[midRollIdx].insertAt) {
        const mr = midRollPoints[midRollIdx];
        lines.push("#EXT-X-DISCONTINUITY");
        lines.push(`#EXTINF:${(mr.duration || 15).toFixed(3)},`);
        lines.push(`${baseUrl}/api/hls/ad-segment/${mr.adId}`);
        lines.push("#EXT-X-DISCONTINUITY");
        midRollIdx++;
      }

      // 最后一个分片可能不足 6 秒，用 min 截断到视频真实结尾。
      // toFixed(3) = 毫秒精度，累计误差不会让播放器判定时间轴漂移。
      const duration = Math.min(segDur, videoDuration - currentTime);
      lines.push(`#EXTINF:${duration.toFixed(3)},`);
      // start/dur 查询参数目前只是元信息（/segment 端点未消费），
      // 但保留它们可让 URL 唯一化，避免 CDN/浏览器把不同分片当成同一资源缓存。
      lines.push(`${baseUrl}/api/hls/segment/${videoId}?start=${currentTime.toFixed(3)}&dur=${duration.toFixed(3)}`);
      currentTime += duration;
    }

    // Post-roll ads
    // 片尾广告后面紧跟 ENDLIST，无需再补一条 DISCONTINUITY 收尾。
    for (const ad of postRollAds) {
      lines.push("#EXT-X-DISCONTINUITY");
      lines.push(`#EXTINF:${(ad.adDuration || 15).toFixed(3)},`);
      lines.push(`${baseUrl}/api/hls/ad-segment/${ad.adId}`);
    }

    lines.push("#EXT-X-ENDLIST"); // 标记 VOD 播放列表结束，播放器据此显示总时长

    const manifest = lines.join("\n");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(manifest);
  } catch (error) {
    console.error("[HLS] Error generating manifest:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * 生产模式: 生成特定码率的 Variant Playlist (带广告拼接)
 *
 * 与开发模式 manifest 的差别：
 *   - 分片 URL 指向 CDN 上真实存在的 .ts 文件，而不是回源到本进程；
 *   - 广告本身也已被切成多个 6s 分片，因此需要内层循环逐片写入；
 *   - EXT-X-VERSION 提到 6（更好的 DISCONTINUITY / 独立分片语义支持）。
 *
 * 该函数直接向 res 写响应（不返回值），调用方需 `return` 它以避免重复响应。
 *
 * @param res           Express 响应对象，函数内部负责设置 header 并 send
 * @param videoId       视频 ID，storageKey 缺失时作为 CDN 目录名的回退
 * @param videoData     videos 表整行，只用到 storageKey
 * @param quality       码率标识（360p/480p/720p/1080p），来自 ?q=
 * @param videoDuration 正片时长（秒），决定分片数量
 * @param placements    已 join 好的广告投放位数组（position/adId/adDuration 等）
 * 副作用：仅写 HTTP 响应，无 DB / S3 / LLM 调用
 */
function generateVariantPlaylist(
  res: Response,
  videoId: number,
  videoData: any,
  quality: string,
  videoDuration: number,
  placements: any[]
) {
  const segDur = 6; // 与转码脚本 -hls_time 6 保持一致，否则分片名与时间轴对不上
  const totalSegments = Math.ceil(videoDuration / segDur);
  // CDN 目录名优先用 storageKey（稳定、不暴露自增 ID），无则退回数字 ID
  const videoStorageKey = (videoData as any).storageKey || videoId;

  const lines: string[] = [];
  lines.push("#EXTM3U");
  lines.push("#EXT-X-VERSION:6");
  lines.push(`#EXT-X-TARGETDURATION:${segDur}`);
  lines.push("#EXT-X-MEDIA-SEQUENCE:0");
  lines.push("#EXT-X-PLAYLIST-TYPE:VOD");

  // Categorize ads
  // 分类与插入点计算逻辑与开发模式 manifest 完全一致（有意的重复实现，
  // 两条分支输出格式差异较大，抽公共函数反而会引入大量条件分支）。
  const preRollAds = placements.filter(p => p.position === "pre-roll").slice(0, 1);
  const postRollAds = placements.filter(p => p.position === "post-roll").slice(0, 1);
  const midRollPlacements = placements.filter(p => p.position === "mid-roll");

  // 展开周期性中插点；同样保留片尾 30 秒不插广告的保护带
  const midRollPoints: { insertAt: number; adId: number; duration: number }[] = [];
  for (const p of midRollPlacements) {
    if (p.midRollInterval && p.midRollInterval > 0) {
      let insertAt = p.midRollInterval;
      while (insertAt < videoDuration - 30) {
        midRollPoints.push({ insertAt, adId: p.adId, duration: p.adDuration });
        insertAt += p.midRollInterval;
      }
    } else if (p.insertAtSeconds) {
      midRollPoints.push({ insertAt: p.insertAtSeconds, adId: p.adId, duration: p.adDuration });
    }
  }
  midRollPoints.sort((a, b) => a.insertAt - b.insertAt);

  // Pre-roll
  // 生产模式下广告同样被切成 6s 的 .ts，所以要按 ceil(广告时长/6) 展开成多条 EXTINF；
  // 最后一片用 min 截断到广告真实剩余时长。
  for (const ad of preRollAds) {
    lines.push("#EXT-X-DISCONTINUITY");
    const adSegments = Math.ceil((ad.adDuration || 15) / segDur);
    for (let i = 0; i < adSegments; i++) {
      const dur = Math.min(segDur, (ad.adDuration || 15) - i * segDur);
      lines.push(`#EXTINF:${dur.toFixed(3)},`);
      lines.push(`${CDN_BASE_URL}/ads/${(ad as any).storageKey || ad.adId}/${quality}/seg${String(i).padStart(4, '0')}.ts`);
    }
    lines.push("#EXT-X-DISCONTINUITY");
  }

  // Main content segments + mid-roll
  // 三个游标各司其职：
  //   currentTime —— 正片时间轴位置（秒），决定何时该插中插广告、何时结束
  //   segIndex    —— 正片分片序号，映射到 CDN 上的 seg%04d.ts 文件名；
  //                  它**只在写正片分片时递增**，广告分片不占用正片序号
  //   midRollIdx  —— 已消费的中插点指针（midRollPoints 已按时间排好序）
  let currentTime = 0;
  let segIndex = 0;
  let midRollIdx = 0;

  while (currentTime < videoDuration) {
    if (midRollIdx < midRollPoints.length && currentTime >= midRollPoints[midRollIdx].insertAt) {
      const mr = midRollPoints[midRollIdx];
      lines.push("#EXT-X-DISCONTINUITY");
      const adSegments = Math.ceil((mr.duration || 15) / segDur);
      for (let i = 0; i < adSegments; i++) {
        const dur = Math.min(segDur, (mr.duration || 15) - i * segDur);
        lines.push(`#EXTINF:${dur.toFixed(3)},`);
        lines.push(`${CDN_BASE_URL}/ads/${mr.adId}/${quality}/seg${String(i).padStart(4, '0')}.ts`);
      }
      lines.push("#EXT-X-DISCONTINUITY");
      midRollIdx++;
    }

    const duration = Math.min(segDur, videoDuration - currentTime);
    lines.push(`#EXTINF:${duration.toFixed(3)},`);
    lines.push(`${CDN_BASE_URL}/videos/${videoStorageKey}/${quality}/seg${String(segIndex).padStart(4, '0')}.ts`);
    currentTime += duration;
    segIndex++;
  }

  // Post-roll
  // 片尾广告：同样展开为多个 6s 分片，之后直接 ENDLIST 收尾
  for (const ad of postRollAds) {
    lines.push("#EXT-X-DISCONTINUITY");
    const adSegments = Math.ceil((ad.adDuration || 15) / segDur);
    for (let i = 0; i < adSegments; i++) {
      const dur = Math.min(segDur, (ad.adDuration || 15) - i * segDur);
      lines.push(`#EXTINF:${dur.toFixed(3)},`);
      lines.push(`${CDN_BASE_URL}/ads/${(ad as any).storageKey || ad.adId}/${quality}/seg${String(i).padStart(4, '0')}.ts`);
    }
  }

  lines.push("#EXT-X-ENDLIST");

  // m3u8 的标准 MIME；no-cache 保证广告投放改动能立刻生效（分片本身在 CDN 上长缓存）
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-cache");
  res.send(lines.join("\n"));
}

export default hlsRouter;
