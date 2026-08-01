/**
 * Video thumbnail extraction utility
 * Extracts the first frame of a video as a thumbnail
 *
 * 视频封面（缩略图）工具模块 (framework core / 纯工具层)
 * ============================================================================
 * 架构定位
 * --------
 * `server/_core/` 下的**无状态纯函数工具**，不注册任何路由、不访问数据库、
 * 不访问 S3。被视频相关的 tRPC 路由（`server/routers/videos*.ts`、
 * `video-upload*.ts`）在写入 `videos.thumbnailUrl` 时调用，用于在没有真实封面
 * 图的情况下产出一个「能看」的占位图。
 *
 * 主要导出物
 * ----------
 * - `extractVideoThumbnail(videoUrl)`  真正的抽帧（**当前为未实现的桩函数**，恒返回 null）
 * - `generatePlaceholderThumbnail(id, title)`  返回指向 `/api/video-thumbnail/:id` 的相对 URL
 * - `createDataURIThumbnail(title, color)`     纯前端可渲染的 SVG data URI 占位图
 *
 * 上下游依赖
 * ----------
 * 上游：视频 CRUD / 上传路由。
 * 下游：无外部依赖；`generatePlaceholderThumbnail` 产出的 URL 由
 *       `server/_core/videoStream.ts` 中注册的 `/api/video-thumbnail/:videoId` 端点承接。
 *
 * 关键设计决策
 * ------------
 * 服务端抽帧需要 FFmpeg 二进制，而应用容器里并没有装（转码是独立的 transcoder
 * 容器负责的，见 `deploy/docker/Dockerfile.transcoder`）。因此这里退而求其次：
 * 要么让浏览器自己去 `/api/video-thumbnail/:id` 拉首片抽帧，要么直接给一张
 * 内嵌 SVG 占位图，零网络请求。
 * ============================================================================
 */

/**
 * Generate thumbnail from video URL by extracting first frame
 * Uses canvas to capture video frame and convert to image
 *
 * ---- 当前状态：未实现的占位桩 ----
 * 无论输入什么都返回 null；调用方应据此回退到 `generatePlaceholderThumbnail()`
 * 或 `createDataURIThumbnail()`。保留该函数是为了把「日后接入 FFmpeg」的
 * 扩展点固定在这里，避免调用方散落判断。
 *
 * @param videoUrl 视频地址（暂未使用）
 * @returns 恒为 `null`；未来实现后应返回封面图的 URL 或 data URI
 * 副作用：无（try/catch 仅为将来实现时预留）
 */
export async function extractVideoThumbnail(videoUrl: string): Promise<string | null> {
  try {
    // This function will be called from server-side
    // We need to use a library that can extract video frames
    // For now, return null - will be implemented with ffmpeg or similar

    // In a production environment, you would use:
    // - ffmpeg to extract first frame
    // - or use a video processing service
    // - or generate a placeholder based on video metadata

    return null;
  } catch (error) {
    console.error("[Video Thumbnail] Error extracting thumbnail:", error);
    return null;
  }
}

/**
 * Generate a placeholder thumbnail URL for video
 * Can be customized with video metadata
 *
 * ---- 详细说明 ----
 * 生成一个指向本站 `/api/video-thumbnail/:videoId` 的**相对**路径。该端点由
 * `server/_core/videoStream.ts` 注册，会回源视频首个分片，前端 <video> 拿到后
 * 可自行抽首帧当封面。
 *
 * @param videoId 视频 ID，拼进路径
 * @param title   视频标题；截断到 30 字符并做 URL 编码后放进 `?title=`。
 *                截断是为了避免超长标题撑爆 URL 长度；`encodeURIComponent` 处理
 *                日文/中文标题与 `&`、`#` 等会破坏查询串的字符。
 *                **注意：接收端目前并不消费这个参数**，它更多起到「让不同视频的
 *                URL 各不相同、便于缓存区分与排查」的作用。
 * @returns 形如 `/api/video-thumbnail/12?title=xxx` 的相对 URL
 * 副作用：无（纯字符串拼接）
 */
export function generatePlaceholderThumbnail(videoId: number, title: string): string {
  // Generate a placeholder image URL using a service like placeholder.com
  // or return a data URI with a gradient
  const encodedTitle = encodeURIComponent(title.substring(0, 30));
  return `/api/video-thumbnail/${videoId}?title=${encodedTitle}`;
}

/**
 * Create a data URI thumbnail with gradient and text
 *
 * ---- 详细说明 ----
 * 生成一张 320x180（16:9 缩略图标准比例）的 SVG 占位图，内容为：
 * 渐变背景 + 半透明圆形 + 白色三角播放按钮 + 底部标题文字，
 * 最后编码成 `data:image/svg+xml;base64,...` 直接内联进 <img src>。
 *
 * 为什么用 data URI 而不是返回一个图片 URL：完全零网络请求、不占 S3 空间、
 * 不受防盗链/域名轮换影响，列表页大量占位图也不会产生额外连接。
 *
 * @param title 标题文字，会被截断到 20 字符渲染在图片底部
 * @param color 渐变起始色，默认 `#8B5CF6`（violet-500，与前端主题色一致），
 *              终止色固定为 `#1e293b`（slate-800，暗色主题背景）
 * @returns base64 编码的 data URI 字符串
 * 副作用：无（纯字符串运算）
 *
 * 坐标含义（viewBox 320x180）：
 *   circle cx=160 cy=90 —— 画布正中心
 *   polygon 150,75 150,105 180,90 —— 指向右侧的等腰三角形「播放」图标
 *   text y=150 —— 距底部 30px，避开播放按钮
 */
export function createDataURIThumbnail(title: string, color: string = "#8B5CF6"): string {
  // Create a simple SVG thumbnail with gradient background and text
  const svg = `
    <svg width="320" height="180" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:${color};stop-opacity:1" />
          <stop offset="100%" style="stop-color:#1e293b;stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="320" height="180" fill="url(#grad)"/>
      <circle cx="160" cy="90" r="30" fill="rgba(255,255,255,0.3)"/>
      <polygon points="150,75 150,105 180,90" fill="white"/>
      <text x="160" y="150" font-size="14" fill="white" text-anchor="middle" font-family="Arial">
        ${title.substring(0, 20)}...
      </text>
    </svg>
  `;
  
  // Buffer.from 默认按 utf8 编码，因此日文/中文标题也能正确进入 base64；
  // 用 base64 而非 `data:image/svg+xml;utf8,` 是为了免去对 `#`、`%`、引号等
  // 字符做 URL 转义（未转义的 `#` 会被浏览器当成 fragment 截断 data URI）。
  const encoded = Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${encoded}`;
}
