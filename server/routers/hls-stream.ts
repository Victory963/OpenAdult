/**
 * ============================================================================
 * server/routers/hls-stream.ts — HLS manifest 生成与 SSAI 广告拼接（tRPC 路由层）
 * ============================================================================
 *
 * ## 架构定位
 * 属于**路由层**（server/routers/）。在 `server/routers.ts` 中以 `hlsStream`
 * 命名空间注册，前端通过 `trpc.hlsStream.*` 调用。
 *
 * 与之配套的还有两处实现，注意区分：
 * - `server/_core/hlsRoutes.ts` — Express 原生路由，真正吐出 `.m3u8` 文本和
 *   `/api/hls/segment/:videoId` `/api/hls/ad-segment/:adId` 这两个片段端点。
 * - `deploy/openresty/lua/` — 生产环境在 CDN 层用 Lua 做 SSAI 拼接。
 * 本文件负责的是「给前端播放器用的、可编程访问的」manifest 与广告时间表。
 *
 * ## 主要导出
 * - `hlsStreamRouter` — 四个 procedure：
 *   | procedure      | 类型     | 权限   | 用途 |
 *   |----------------|----------|--------|------|
 *   | `getManifest`  | query    | public | 生成含广告的 pseudo-HLS m3u8 文本 |
 *   | `trackAdEvent` | mutation | public | 上报广告事件（曝光/四分位/完播/点击） |
 *   | `getAdInfo`    | query    | public | 取单条广告信息（点击跳转 URL 等） |
 *   | `getVideoAds`  | query    | public | 取该视频的广告时间表（overlay 覆盖播放模式用） |
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/components/VideoPlayer.tsx`
 *   （同时用到 getManifest / getVideoAds / trackAdEvent 三个）
 * - 下游依赖：`getDb()`（server/db.ts）；表 `videos` / `ads` / `ad_placements` / `ad_impressions`
 *
 * ## 关键设计决策与坑
 * 1. **pseudo-HLS（伪 HLS）**：S3 里存的是整段 MP4，没有真正切好的 `.ts` 片段。
 *    因此 manifest 里的每个「片段 URL」其实带 `?start=&duration=` 时间参数，
 *    由 `/api/hls/segment/:videoId` 重定向回同一个 MP4，让 hls.js 自己去 seek。
 *    真实切片模式（HLS_MODE=real）走 CDN，见 `_core/hlsRoutes.ts`。
 * 2. **SSAI 用 `#EXT-X-DISCONTINUITY` 包裹广告**：告诉播放器广告片段与正片的
 *    编码参数/时间戳不连续，避免解码器状态错乱。
 * 3. **广告选取每个坑位只留 1 条**：先按 `ads.priority` 降序排序再 `slice(0, 1)`，
 *    既保证高优先级（付费）广告优先展示，也防止连播多支广告导致跳出率飙升。
 * 4. **mid-roll 不插入最后 30 秒**：`insertAt < videoDuration - 30`，避免结尾处
 *    广告与 post-roll 撞车、以及用户已快看完时被打断。
 */

import { z } from "zod";
import { publicProcedure, protectedProcedure } from "../_core/trpc";
import { router } from "../_core/trpc";
import { getDb } from "../db";
import { videos, ads, adPlacements, adImpressions } from "../../drizzle/schema";
import { eq, and, sql, desc, isNull, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

/**
 * Generate a Byte-Range HLS m3u8 manifest for a video.
 * Since we store MP4 files directly in S3, we use pseudo-HLS:
 * - The manifest points to time-based segments of the original MP4
 * - For SSAI, we insert ad segments with #EXT-X-DISCONTINUITY markers
 */

/**
 * 单个正片切片的时长（秒）。
 * 6s 是 HLS 的行业惯例（Apple HLS Authoring Spec 推荐 6s）：
 * 太短则请求数/开销暴增，太长则起播延迟与切码率反应变慢。
 * 该值同时写入 manifest 的 `#EXT-X-TARGETDURATION`。
 */
const SEGMENT_DURATION = 6; // seconds per segment

/** 一条待拼接的广告片段（从 ads 表投影而来，仅保留拼 manifest 所需字段） */
interface AdSegment {
  /** ads.id，用于拼出 /api/hls/ad-segment/:adId 与事件上报 */
  adId: number;
  /** 广告素材 MP4 的 S3 URL（本函数不直接用，由 ad-segment 端点解析） */
  videoUrl: string;
  /** 广告时长（秒），写入 `#EXTINF` */
  duration: number;
  /** 点击跳转落地页；null 表示不可点击 */
  clickUrl: string | null;
  /** ads.priority，数值越大越优先；同一坑位有多条候选时用它挑选。DB 中为 null 时归一为 0 */
  priority: number;
}

/**
 * Build a simple m3u8 manifest that references the video stream endpoint
 * with time-range parameters for pseudo-segmentation
 *
 * 生成完整的 VOD m3u8 文本，结构为：
 *   [头部标签] → [pre-roll 广告] → [正片切片(中间穿插 mid-roll)] → [post-roll 广告] → #EXT-X-ENDLIST
 *
 * @param videoId        视频 id，用于拼正片切片 URL
 * @param videoDuration  正片总时长（秒），决定切片循环次数
 * @param videoStreamUrl 正片直链。**当前实现未使用**（切片 URL 走 /api/hls/segment 端点），
 *                       保留为参数是为了将来切换到直链模式时不改签名
 * @param preRollAds     片头广告列表
 * @param midRollAds     中插广告列表，元素为 `{ insertAt: 秒, ads: [...] }`
 * @param postRollAds    片尾广告列表
 * @param baseUrl        URL 前缀（如 "https://example.com"）；传空串则生成相对路径 URL
 * @returns m3u8 纯文本（以 `\n` 连接，无末尾换行）
 * @sideEffect 无（纯函数）
 */
function buildManifest(
  videoId: number,
  videoDuration: number,
  videoStreamUrl: string,
  preRollAds: AdSegment[],
  midRollAds: { insertAt: number; ads: AdSegment[] }[],
  postRollAds: AdSegment[],
  baseUrl: string
): string {
  const lines: string[] = [];
  // ── m3u8 头部标签 ────────────────────────────────────────────────
  // VERSION:3        → 使用 HLS v3（浮点 #EXTINF 时长所需的最低版本）
  // TARGETDURATION   → 声明最长片段时长，播放器据此决定缓冲策略；必须 >= 实际最大 EXTINF
  // MEDIA-SEQUENCE:0 → VOD 点播固定从 0 开始（直播才需要递增）
  // PLAYLIST-TYPE:VOD→ 告知播放器整个列表不可变，可以直接 seek 到任意位置
  lines.push("#EXTM3U");
  lines.push("#EXT-X-VERSION:3");
  lines.push(`#EXT-X-TARGETDURATION:${SEGMENT_DURATION}`);
  lines.push("#EXT-X-MEDIA-SEQUENCE:0");
  lines.push("#EXT-X-PLAYLIST-TYPE:VOD");

  // 全局递增的片段序号。它不参与 HLS 语义，只作为 ad-segment URL 上的 `?t=` 参数，
  // 用于让同一支广告在不同坑位拥有不同 URL —— 否则 CDN/浏览器会把它们当成同一个
  // 资源缓存，导致播放器只请求一次、后续坑位的曝光统计丢失。
  let segmentIndex = 0;

  // Pre-roll ads
  // 片头广告：前后各加一个 #EXT-X-DISCONTINUITY，把广告与正片的时间戳/编码参数隔离开。
  // 每支广告整体作为「一个片段」写入（不再细分成 6s），因为广告 MP4 本来就短。
  for (const ad of preRollAds) {
    lines.push("#EXT-X-DISCONTINUITY");
    // Ad as a single segment
    lines.push(`#EXTINF:${ad.duration.toFixed(3)},`);
    lines.push(`${baseUrl}/api/hls/ad-segment/${ad.adId}?t=${segmentIndex}`);
    segmentIndex++;
    lines.push("#EXT-X-DISCONTINUITY");
  }

  // Main content segments with mid-roll insertion
  // 正片切片主循环：按 6s 步进推进 currentTime，同时用「双指针」把已按时间排序的
  // mid-roll 队列穿插进来 —— midRollIndex 单调前进，保证每个插播点只消费一次，
  // 整体复杂度 O(切片数 + 广告数)，无需在循环内反复查找。
  const sortedMidRolls = [...midRollAds].sort((a, b) => a.insertAt - b.insertAt);
  let currentTime = 0;
  let midRollIndex = 0;

  while (currentTime < videoDuration) {
    // Check if we need to insert a mid-roll ad at this point
    // 判定用 `>=` 而非 `===`：insertAt 通常不会正好落在 6 的倍数上，
    // 所以广告实际会插在「首个 >= insertAt 的切片边界之前」，误差最多 6 秒。
    if (
      midRollIndex < sortedMidRolls.length &&
      currentTime >= sortedMidRolls[midRollIndex].insertAt
    ) {
      const midRoll = sortedMidRolls[midRollIndex];
      for (const ad of midRoll.ads) {
        lines.push("#EXT-X-DISCONTINUITY");
        lines.push(`#EXTINF:${ad.duration.toFixed(3)},`);
        lines.push(`${baseUrl}/api/hls/ad-segment/${ad.adId}?t=${segmentIndex}`);
        segmentIndex++;
        lines.push("#EXT-X-DISCONTINUITY");
      }
      midRollIndex++;
    }

    // Content segment
    // 最后一个切片可能不足 6s，用 min() 裁到剩余时长，避免 EXTINF 声明超过实际内容
    // （超时长会让播放器在片尾出现卡顿或提前判定流结束）。
    // 时长统一保留 3 位小数：HLS 规范要求 EXTINF 精度足以避免累积漂移。
    const segDuration = Math.min(SEGMENT_DURATION, videoDuration - currentTime);
    lines.push(`#EXTINF:${segDuration.toFixed(3)},`);
    lines.push(
      `${baseUrl}/api/hls/segment/${videoId}?start=${currentTime.toFixed(3)}&duration=${segDuration.toFixed(3)}`
    );
    currentTime += segDuration;
    segmentIndex++;
  }

  // Post-roll ads
  // 片尾广告：只在前面加 DISCONTINUITY（后面紧跟 ENDLIST，无需再隔离）
  for (const ad of postRollAds) {
    lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXTINF:${ad.duration.toFixed(3)},`);
    lines.push(`${baseUrl}/api/hls/ad-segment/${ad.adId}?t=${segmentIndex}`);
    segmentIndex++;
  }

  // ENDLIST 标志 VOD 列表结束；缺了它播放器会当成直播流持续轮询 manifest
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

/**
 * Get active ads for a video based on placement rules
 *
 * 根据 `ad_placements` 投放规则，解算出某个视频应该插哪些广告、插在什么时间点。
 *
 * 选取条件（SQL 层）：投放位启用 AND 广告素材启用 AND
 * （videoId 精确命中该视频 OR videoId IS NULL 表示全局投放）。
 *
 * 命中多条时的取舍（内存层）：三个坑位（pre-roll / post-roll / 每个 mid-roll 插播点）
 * 各自按 `ads.priority` 降序排序后只保留 1 条，priority 相等则保持 SQL 返回顺序。
 *
 * @param db            Drizzle DB 实例（类型为 any，因 getDb() 返回值可能为 null 需调用方先判空）
 * @param videoId       视频 id
 * @param videoDuration 视频总时长（秒），用于计算 mid-roll 重复插播点
 * @returns `{ preRoll, midRoll, postRoll }`，其中 midRoll 为 `{ insertAt, ads }[]`
 * @sideEffect 读库一次（ad_placements INNER JOIN ads）
 */
async function getAdsForVideo(
  db: any,
  videoId: number,
  videoDuration: number
): Promise<{
  preRoll: AdSegment[];
  midRoll: { insertAt: number; ads: AdSegment[] }[];
  postRoll: AdSegment[];
}> {
  // Get all active placements for this video (or global placements)
  // isNull(adPlacements.videoId) 是「全局投放」的约定：videoId 留空 = 对所有视频生效。
  // 这里没有做「精确投放优先于全局投放」的去重，两者会同时命中并各占一个候选位。
  const placements = await db
    .select({
      placement: adPlacements,
      ad: ads,
    })
    .from(adPlacements)
    .innerJoin(ads, eq(adPlacements.adId, ads.id))
    .where(
      and(
        eq(adPlacements.isActive, true),
        eq(ads.isActive, true),
        or(
          eq(adPlacements.videoId, videoId),
          isNull(adPlacements.videoId)
        )
      )
    );

  const preRoll: AdSegment[] = [];
  const postRoll: AdSegment[] = [];
  // midRollMap: 插播时间点(秒) → 该时间点上的广告列表。
  // 用 Map 而不是数组，是为了让「不同投放规则算出同一个时间点」时能自动归并到一起。
  const midRollMap = new Map<number, AdSegment[]>();

  // 遍历每条投放规则，按 position 分派到三个坑位桶中
  for (const { placement, ad } of placements) {
    const adSegment: AdSegment = {
      adId: ad.id,
      videoUrl: ad.videoUrl,
      duration: ad.duration,
      clickUrl: ad.clickUrl,
      // 修复：带上 priority，供下面「每坑位限 1 条」时按优先级挑选（列可空，null 归一为 0）
      priority: ad.priority ?? 0,
    };

    if (placement.position === "pre-roll") {
      preRoll.push(adSegment);
    } else if (placement.position === "post-roll") {
      postRoll.push(adSegment);
    } else if (placement.position === "mid-roll") {
      // Calculate mid-roll insertion points
      // mid-roll 支持两种互斥的配置方式，优先判定「周期重复」：
      //   A. midRollInterval = N  → 每隔 N 秒插一次（N=300 即每 5 分钟）
      //   B. insertAtSeconds = T  → 只在第 T 秒插一次
      if (placement.midRollInterval && placement.midRollInterval > 0) {
        // Repeat every N seconds
        // 从第一个 interval 处开始，步进累加直到接近片尾。
        // `> 0` 的守卫同时也防止 interval 为 0 时陷入死循环。
        let insertAt = placement.midRollInterval;
        while (insertAt < videoDuration - 30) {
          // Don't insert in last 30s
          // 留出片尾 30s 安全区：太靠后的中插会与 post-roll 连播，
          // 且此时用户即将看完，打断的负面体验收益最低。
          const existing = midRollMap.get(insertAt) || [];
          existing.push(adSegment);
          midRollMap.set(insertAt, existing);
          insertAt += placement.midRollInterval;
        }
      } else if (placement.insertAtSeconds) {
        // Insert at specific time
        // 注意这是 truthy 判断：insertAtSeconds === 0 会被跳过
        // （不过 0 秒本就等价于 pre-roll，配 0 属于配置错误）
        const existing = midRollMap.get(placement.insertAtSeconds) || [];
        existing.push(adSegment);
        midRollMap.set(placement.insertAtSeconds, existing);
      }
    }
  }

  // Sort by priority (higher first) and limit to 1 ad per slot
  // 修复：真正实现「按 priority 降序挑选」——此前只有注释与字段声明，slice(0,1) 直接
  // 取数组首元素，最终展示哪支广告取决于 SQL 返回顺序（通常是主键顺序），运营配置的
  // priority 完全无效。现在三个坑位一律先 sort 再 slice。
  // 排序前先复制（slice()），避免原地改动调用方可见的数组顺序；priority 相等时
  // Array.prototype.sort 在 V8 中稳定，保持 SQL 返回的原有相对顺序。
  // 每坑位限 1 条是产品约束：连播多支广告会显著推高跳出率。
  const byPriorityDesc = (a: AdSegment, b: AdSegment) => b.priority - a.priority;
  const sortedPreRoll = preRoll.slice().sort(byPriorityDesc).slice(0, 1); // Max 1 pre-roll
  const sortedPostRoll = postRoll.slice().sort(byPriorityDesc).slice(0, 1); // Max 1 post-roll

  // 把 Map 摊平成数组（顺序即插入顺序，未按 insertAt 排序 —— 那步排序在 buildManifest 里做）
  // 修复：每个插播点内部同样先按 priority 降序排，再截取 1 条
  const midRoll: { insertAt: number; ads: AdSegment[] }[] = [];
  midRollMap.forEach((adList, insertAt) => {
    // Max 1 ad per mid-roll point
    midRoll.push({ insertAt, ads: adList.slice().sort(byPriorityDesc).slice(0, 1) });
  });

  return { preRoll: sortedPreRoll, midRoll, postRoll: sortedPostRoll };
}

export const hlsStreamRouter = router({
  /**
   * Get HLS manifest for a video (with SSAI ads)
   *
   * 【public / query】取某视频的 pseudo-HLS manifest（已服务端拼好广告）。
   *
   * 返回值是**判别联合（discriminated union）**，前端需按 `type` 分支处理：
   * - `{ type: "direct", videoUrl, duration }` — 视频时长未知（duration <= 0，
   *   通常是转码/元数据尚未回填），无法切片，降级为直接播放 MP4 直链，**此时没有任何广告**
   * - `{ type: "hls", manifest, duration, hasAds }` — 正常情况，manifest 为 m3u8 文本，
   *   前端需自行转成 Blob URL 或 data URI 交给 hls.js
   *
   * @param input.videoId 视频 id
   * @param input.baseUrl 可选。生成片段 URL 时的绝对前缀；省略则生成相对路径
   *                      （前端同域播放传空即可；CDN 分发场景需传 CDN 域名）
   * @sideEffect 读库 2 次（videos 一次、ad_placements JOIN ads 一次），不写库
   * @throws TRPCError INTERNAL_SERVER_ERROR — DB 不可用
   * @throws TRPCError NOT_FOUND — 视频不存在
   */
  getManifest: publicProcedure
    .input(z.object({ videoId: z.number(), baseUrl: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const video = await db
        .select()
        .from(videos)
        .where(eq(videos.id, input.videoId))
        .limit(1);

      if (video.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Video not found" });
      }

      const videoData = video[0];
      const videoDuration = videoData.duration || 0;

      if (videoDuration <= 0) {
        // If no duration, return direct video URL (fallback to MP4)
        // 没有时长就无法计算切片边界与广告插入点，只能整段回退播 MP4。
        // 这条降级路径会连带丢掉所有广告收益，属于「宁可不播广告也要能播视频」的取舍。
        return {
          type: "direct" as const,
          videoUrl: videoData.videoUrl,
          duration: 0,
        };
      }

      // Get ads for this video
      const { preRoll, midRoll, postRoll } = await getAdsForVideo(
        db,
        input.videoId,
        videoDuration
      );

      const baseUrl = input.baseUrl || "";

      const manifest = buildManifest(
        input.videoId,
        videoDuration,
        videoData.videoUrl || "",
        preRoll,
        midRoll,
        postRoll,
        baseUrl
      );

      return {
        type: "hls" as const,
        manifest,
        duration: videoDuration,
        hasAds: preRoll.length > 0 || midRoll.length > 0 || postRoll.length > 0,
      };
    }),

  /**
   * Track ad events (impression, quartiles, complete, click)
   *
   * 【public / mutation】广告事件上报（VAST 标准事件模型）。
   *
   * 事件语义：
   * - `impression`    曝光：广告开始加载/展示
   * - `start`         真正开始播放
   * - `firstQuartile` 播放到 25%
   * - `midpoint`      播放到 50%
   * - `thirdQuartile` 播放到 75%
   * - `complete`      完播 100%
   * - `click`         用户点击跳转
   *
   * 采用「明细 + 聚合」双写：
   * 1. 每个事件都往 `ad_impressions` 插一行明细（用于后续做漏斗/时段分析）
   * 2. 只有 impression / click / complete 三个关键事件会额外用
   *    `SET col = col + 1` 的原子自增更新 `ads` 表上的计数器，
   *    让 `getAnalytics` 无需 COUNT(*) 全表扫描即可秒出汇总
   *
   * @param input.adId    广告 id
   * @param input.videoId 可选。事件发生所在的视频，便于分视频归因
   * @param input.event   事件类型（见上表）
   * @returns `{ success: true }`；DB 不可用时返回 `{ success: false }` 而非抛错
   *          —— 埋点失败不应该中断用户的播放体验
   *
   * @sideEffect 写 `ad_impressions` 1 行；可能再写 `ads` 计数器 1 次
   * @remarks ⚠️ 这是无鉴权、无限流、无幂等校验的 public 接口，
   *          任何人可以直接构造请求刷曝光/点击数，统计数据不可作为结算依据。
   */
  trackAdEvent: publicProcedure
    .input(
      z.object({
        adId: z.number(),
        videoId: z.number().optional(),
        event: z.enum([
          "impression",
          "start",
          "firstQuartile",
          "midpoint",
          "thirdQuartile",
          "complete",
          "click",
        ]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return { success: false };

      // 未登录用户记为 null（本 procedure 是 public，ctx.user 可能不存在）。
      // 转成 any 只是为了跳过类型收窄，ctx.user 的实际类型见 _core/context.ts。
      const userId = (ctx as any).user?.id || null;

      // 明细落库：每次事件一行，保留完整时间序列
      await db.insert(adImpressions).values({
        adId: input.adId,
        videoId: input.videoId || null,
        userId,
        event: input.event,
      });

      // Update aggregate counters on ads table
      // 用 sql`col + 1` 让 MySQL 在服务端原子自增，避免「读-改-写」的并发丢更新问题。
      // 只对三个关键指标做聚合（曝光/点击/完播），四分位事件仅存明细。
      if (input.event === "impression") {
        await db
          .update(ads)
          .set({ impressions: sql`impressions + 1` })
          .where(eq(ads.id, input.adId));
      } else if (input.event === "click") {
        await db
          .update(ads)
          .set({ clicks: sql`clicks + 1` })
          .where(eq(ads.id, input.adId));
      } else if (input.event === "complete") {
        await db
          .update(ads)
          .set({ completions: sql`completions + 1` })
          .where(eq(ads.id, input.adId));
      }

      return { success: true };
    }),

  /**
   * Get ad info (for click-through URL, etc.)
   *
   * 【public / query】取单条广告的公开信息。
   *
   * 只投影 4 个字段（id/name/clickUrl/duration），刻意不返回 videoUrl 与
   * impressions/clicks 等运营数据 —— 这是面向播放器的公开接口，
   * 主要供「点击广告 → 打开 clickUrl」这一步使用。
   *
   * @param input.adId 广告 id
   * @throws TRPCError INTERNAL_SERVER_ERROR — DB 不可用
   * @throws TRPCError NOT_FOUND — 广告不存在
   * @remarks 未过滤 `isActive`，已下线的广告仍可被查到（对点击跳转场景是合理的：
   *          广告播到一半被下线时，点击仍应能正常跳转）
   */
  getAdInfo: publicProcedure
    .input(z.object({ adId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const ad = await db
        .select()
        .from(ads)
        .where(eq(ads.id, input.adId))
        .limit(1);

      if (ad.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Ad not found" });
      }

      return {
        id: ad[0].id,
        name: ad[0].name,
        clickUrl: ad[0].clickUrl,
        duration: ad[0].duration,
      };
    }),

  /**
   * Get ads for a video (used by VideoPlayer in direct/overlay mode)
   * Returns pre-roll, mid-roll, and post-roll ads with timing info
   *
   * 【public / query】取该视频的广告「时间表」，供**客户端拼接（CSAI / overlay 模式）**使用。
   *
   * 与 `getManifest` 的区别：
   * - `getManifest` 是**服务端拼接（SSAI）**：广告已经嵌进 m3u8，播放器无感知，抗广告拦截
   * - 本接口是**客户端拼接**：返回扁平的 `{ triggerAt, videoUrl, ... }` 列表，
   *   由 `VideoPlayer.tsx` 监听 timeupdate，到点暂停正片、覆盖播放广告 MP4
   * 走 direct（无 HLS）播放路径时只能用这条。
   *
   * @param input.videoId       视频 id
   * @param input.videoDuration 可选。视频时长（秒）。**必须传**才能拿到 mid-roll / post-roll——
   *                            省略时按 0 处理，只会返回 pre-roll
   * @returns `{ ads: [{ adId, name, videoUrl, clickUrl, duration, position, triggerAt }] }`
   *          已按 `triggerAt` 升序排列，便于播放器顺序消费
   *
   * @sideEffect 读库 1 次，不写库
   * @throws TRPCError INTERNAL_SERVER_ERROR — DB 不可用
   * @remarks 本函数复刻了 `getAdsForVideo()` 的投放解算逻辑但**未做「每坑位限 1 条」的截断**，
   *          两处逻辑重复且行为不一致，修改投放规则时需同步两边。
   */
  getVideoAds: publicProcedure
    .input(z.object({
      videoId: z.number(),
      videoDuration: z.number().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const placements = await db
        .select({
          placement: adPlacements,
          ad: ads,
        })
        .from(adPlacements)
        .innerJoin(ads, eq(adPlacements.adId, ads.id))
        .where(
          and(
            eq(adPlacements.isActive, true),
            eq(ads.isActive, true),
            or(
              eq(adPlacements.videoId, input.videoId),
              isNull(adPlacements.videoId)
            )
          )
        );

      const videoDuration = input.videoDuration || 0;
      const result: Array<{
        adId: number;
        name: string;
        videoUrl: string;
        clickUrl: string | null;
        duration: number;
        position: string;
        triggerAt: number;
      }> = [];

      // 把投放规则摊平成「触发时间点」列表：
      //   pre-roll  → triggerAt = 0（开播前）
      //   post-roll → triggerAt = videoDuration（正片结束处）
      //   mid-roll  → 按 interval 周期展开，或用 insertAtSeconds 单点插入
      // videoDuration 为 0（调用方未传）时会跳过 post/mid，只剩 pre-roll。
      for (const { placement, ad } of placements) {
        if (placement.position === "pre-roll") {
          result.push({
            adId: ad.id, name: ad.name, videoUrl: ad.videoUrl,
            clickUrl: ad.clickUrl, duration: ad.duration,
            position: "pre-roll", triggerAt: 0,
          });
        } else if (placement.position === "post-roll" && videoDuration > 0) {
          result.push({
            adId: ad.id, name: ad.name, videoUrl: ad.videoUrl,
            clickUrl: ad.clickUrl, duration: ad.duration,
            position: "post-roll", triggerAt: videoDuration,
          });
        } else if (placement.position === "mid-roll" && videoDuration > 0) {
          if (placement.midRollInterval && placement.midRollInterval > 0) {
            // 周期展开：与 getAdsForVideo() 同样留出片尾 30 秒安全区。
            // `> 0` 守卫防止 interval=0 造成死循环。
            let insertAt = placement.midRollInterval;
            while (insertAt < videoDuration - 30) {
              result.push({
                adId: ad.id, name: ad.name, videoUrl: ad.videoUrl,
                clickUrl: ad.clickUrl, duration: ad.duration,
                position: "mid-roll", triggerAt: insertAt,
              });
              insertAt += placement.midRollInterval;
            }
          } else if (placement.insertAtSeconds) {
            result.push({
              adId: ad.id, name: ad.name, videoUrl: ad.videoUrl,
              clickUrl: ad.clickUrl, duration: ad.duration,
              position: "mid-roll", triggerAt: placement.insertAtSeconds,
            });
          }
        }
      }

      // 按触发时间升序，让播放器可以用一个游标顺序推进，无需每帧全表查找
      result.sort((a, b) => a.triggerAt - b.triggerAt);
      return { ads: result };
    }),
});
