/**
 * ============================================================================
 * client/src/lib/videoUrl.ts — 视频 URL 归一化 (UI 层 / 工具库)
 * ============================================================================
 *
 * 架构角色：
 *   适配层。数据库 videos.videoUrl 字段在项目演进过程中出现了 4 种不同格式，
 *   本模块负责把它们统一翻译成"浏览器当前可直接使用的同源 URL"，
 *   使播放器与卡片组件无需关心历史包袱。
 *
 * videoUrl 可能的四种取值：
 *   1. `multi-chunk:<sessionId>`  —— 分片上传 (video-upload-v2) 产物，真实字节散落在
 *      多个 S3 对象里，必须由服务端 /api/video-stream 虚拟拼接后才能播放；
 *   2. `/manus-storage/<key>`     —— 当前标准格式，同源相对路径，由 storageProxy 代理到 S3；
 *   3. `https://forge.manus.ai/manus-storage/<key>` —— 早期写入的绝对 URL（历史数据）；
 *   4. 其它任意字符串             —— 外链或未来新格式，原样返回。
 *
 * 主要导出物：
 *   - resolveVideoUrl(videoUrl, videoId)   : 解析"用于播放"的地址
 *   - resolvePreviewUrl(videoUrl, videoId) : 解析"用于封面/预览"的地址
 *
 * 上下游依赖：
 *   ← VideoPlayer / VideoCard / VideoDetailPage / VideoManagementUI 等
 *   → 服务端 server/_core/videoStream.ts（/api/video-stream、/api/video-thumbnail）
 *     与 server/_core/storageProxy.ts（/manus-storage/*）
 *   ← 行为被 server/routers/video-playback.test.ts 中的用例镜像覆盖
 *
 * 关键设计决策：
 *   一律返回**同源相对路径**而非 S3/CDN 绝对地址。原因有二：
 *   (a) 反封锁体系下站点域名会轮换，绝对域名会随封禁失效；
 *   (b) 同源可复用 Cookie 鉴权并让 Nginx/OpenResty 有机会做广告拼接与缓存。
 */

/**
 * Resolve video URL for playback.
 * Handles multi-chunk videos by routing to the video-stream API.
 *
 * 解析用于**播放**的视频地址。
 *
 * @param videoUrl 数据库 videos.videoUrl 原始值，允许 null/undefined（视频尚未转码完成）。
 * @param videoId  videos 表主键。仅当 videoUrl 为 multi-chunk 哨兵值时才必需——
 *                 因为真实字节位置只有服务端能按 videoId 查询出来。
 * @returns 可直接喂给 <video src> / hls.js 的 URL；videoUrl 为空时返回 null。
 *
 * 纯函数，无副作用；不会抛错（所有分支都有兜底返回）。
 *
 * 注意：multi-chunk 分支要求 videoId 同时存在，若调用方漏传 videoId，
 * 会落到最后的"原样返回"，把 `multi-chunk:123` 这种非法值交给播放器 —— 调用方需保证传参。
 */
export function resolveVideoUrl(videoUrl: string | null | undefined, videoId?: number): string | null {
  if (!videoUrl) return null;

  // Multi-chunk video: use streaming endpoint
  // 分片视频：交给服务端流式端点，它会按 Range 请求跨分片拼接字节
  if (videoUrl.startsWith('multi-chunk:') && videoId) {
    return `/api/video-stream/${videoId}`;
  }

  // Regular storage path
  // 已是标准同源路径，无需转换
  if (videoUrl.startsWith('/manus-storage/')) {
    return videoUrl;
  }

  // Legacy absolute URL - try to convert
  // 历史绝对 URL：截取 '/manus-storage/' 之后的 key 重新拼成同源路径。
  // 用 split(...).pop() 而非 replace，可兼容 key 中再次出现该子串的极端情况
  // （pop 取最后一段，即真正的对象 key）。
  if (videoUrl.includes('forge.manus.ai/manus-storage/')) {
    const key = videoUrl.split('/manus-storage/').pop();
    if (key) return `/manus-storage/${key}`;
  }

  // Return as-is for any other format
  // 未知格式（外链等）原样透传，保持向后兼容
  return videoUrl;
}

/**
 * Resolve video URL for thumbnail/preview.
 * For multi-chunk videos, uses the thumbnail endpoint (first chunk).
 *
 * 解析用于**封面/预览**的视频地址。
 *
 * @param videoUrl 同 resolveVideoUrl。
 * @param videoId  同 resolveVideoUrl，multi-chunk 时必需。
 * @returns 用于列表卡片抓首帧的 URL；videoUrl 为空时返回 null。
 *
 * 与 resolveVideoUrl 的唯一差别在 multi-chunk 分支：这里指向
 * /api/video-thumbnail/:id，服务端只代理**第一个分片**。
 * 这么做是为了列表页性能——若走完整 video-stream，浏览器为拿首帧仍可能
 * 触发跨分片的 Range 请求，几十张卡片同时加载会打满 Node 侧代理带宽。
 * 其余分支与播放路径完全一致（普通对象本身就能被 <video> 抓首帧）。
 *
 * 纯函数，无副作用。
 */
export function resolvePreviewUrl(videoUrl: string | null | undefined, videoId?: number): string | null {
  if (!videoUrl) return null;

  // Multi-chunk video: use thumbnail endpoint (first chunk only)
  // 只取首个分片，避免列表页为了首帧而拉取整段视频
  if (videoUrl.startsWith('multi-chunk:') && videoId) {
    return `/api/video-thumbnail/${videoId}`;
  }

  // Regular storage path - can be used directly for preview
  if (videoUrl.startsWith('/manus-storage/')) {
    return videoUrl;
  }

  // Legacy absolute URL - try to convert
  // 历史绝对 URL → 同源路径，逻辑同 resolveVideoUrl
  if (videoUrl.includes('forge.manus.ai/manus-storage/')) {
    const key = videoUrl.split('/manus-storage/').pop();
    if (key) return `/manus-storage/${key}`;
  }

  return videoUrl;
}
