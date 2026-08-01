/**
 * ============================================================================
 * client/src/components/VideoUploadForm.tsx — 大文件分片上传表单 (UI 层 / 组件)
 * ============================================================================
 *
 * 架构角色：
 *   管理面板中的上传入口，是整个项目里唯一**绕过 tRPC 直接用 fetch** 的前端模块。
 *   原因：tRPC 走 JSON + superjson 序列化，二进制必须先 Base64（体积 +33%，
 *   且需在主线程做字符串编码），对动辄几十 GB 的视频完全不可行。
 *   因此上传链路被拆成两段：
 *     - 控制面（会话生命周期）：tRPC —— videoUploadV2.initSession / completeUpload
 *     - 数据面（字节搬运）    ：原生 fetch + multipart/form-data → POST /api/upload/chunk
 *
 * 主要导出物：
 *   - default VideoUploadForm() — 无 props，完全自治的上传面板
 *   （extractThumbnail / uploadChunksParallel / uploadChunkBinary / formatBytes /
 *     formatTime 均为模块内私有辅助函数，未导出）
 *
 * 上下游依赖：
 *   ← client/src/components/ 管理面板页面（ActressManagementPage / Dashboard 等）
 *   → trpc.videoUploadV2.initSession    创建 video_upload_sessions 记录，返回 sessionId
 *   → POST /api/upload/chunk            server/_core/fastUpload.ts，落 S3 + 写 video_upload_chunks
 *   → trpc.videoUploadV2.completeUpload  校验分片齐全 → LLM 生成元数据 → 合并 → 落 videos 表
 *
 * 上传状态机（与服务端 video_upload_sessions.status 对应）：
 *   initSession ──▶ "uploading" ──(并发 N 次 POST /chunk)──▶ "processing"
 *                                  ──completeUpload──▶ "completed"
 *                                  ──任一环节抛错──▶ "error"
 *
 * 封面策略：在**浏览器端**用 <video> + <canvas> 抽帧，把 dataURL 随 initSession
 *   一起送到服务端。这样服务端不需要装 FFmpeg 就能拿到封面（转码容器是异步的，
 *   来不及在上传完成时提供封面）。
 */

import { useState, useRef, useCallback } from "react";
import { Upload, X, Play, AlertCircle, Image, Settings2, Clock, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/**
 * 单个上传任务在 UI 中的完整状态快照。
 *
 * @property sessionId        服务端返回的会话 ID，同时充当 React list 的 key 与取消/移除的句柄
 * @property progress         0~100 的整数百分比，按**已完成分片数**计算（非字节数）
 * @property status           见文件头状态机：uploading → processing → completed，或 error
 * @property thumbnailPreview 浏览器端抽取的封面 dataURL，仅用于本地预览
 * @property speed / eta      已格式化好的展示字符串（如 "12.3 MB/s" / "3分20秒"），
 *                            而非数值 —— 避免在渲染层重复做格式化
 */
interface UploadingFile {
  sessionId: string;
  fileName: string;
  fileSize: number;
  progress: number;
  status: "uploading" | "processing" | "completed" | "error";
  error?: string;
  thumbnailPreview?: string;
  speed?: string; // Upload speed display
  eta?: string; // Estimated time remaining
}

/**
 * 封面抽帧参数。
 * @property captureTime    "auto" = 取 min(2秒, 时长的5%)；"custom" = 用户指定秒数
 * @property customSeconds  自定义抽帧位置，UI 滑块范围 0~300 秒
 * @property quality        JPEG 压缩质量档位，实际数值见 QUALITY_VALUES
 */
interface ThumbnailOptions {
  captureTime: "auto" | "custom";
  customSeconds: number;
  quality: "low" | "medium" | "high";
}

// ============================================================================
// 调优常量
// ============================================================================
// CHUNK_SIZE = 50MB：分片越大 HTTP 往返次数越少（100GB 文件 → 2048 片而非 100 万片），
//   但单片失败的重传代价也越大，且每个并发 worker 会在内存里持有一份 Blob 切片。
//   50MB × PARALLEL_UPLOADS(4) ≈ 200MB 峰值占用，是浏览器可接受的上限附近。
//   ⚠️ 该值必须与服务端 /api/upload/chunk 的 body 体积限制保持一致，改这里要同步改后端。
// Optimized: 50MB chunks for fewer HTTP requests
const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks
// MAX_FILE_SIZE = 100GB：纯前端预校验，用于尽早给出提示；服务端仍会独立校验。
const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024; // 100GB
// PARALLEL_UPLOADS = 4：HTTP/1.1 下浏览器对同一域名的并发连接上限通常是 6，
//   留 2 条给页面其它请求（tRPC 轮询、图片等），避免上传把整站请求饿死。
// Parallel upload concurrency
const PARALLEL_UPLOADS = 4;

// JPEG 质量档位。0.6/0.8/0.95 是 canvas.toDataURL 的经验取值：
// 低于 0.6 会出现明显块效应，高于 0.95 体积暴涨但肉眼几乎无差别。
const QUALITY_VALUES: Record<string, number> = {
  low: 0.6,
  medium: 0.8,
  high: 0.95,
};

/**
 * 在浏览器端从视频文件抽取一帧作为封面，同时读出时长。
 *
 * 实现要点：创建一个**离屏**（从未挂载到 DOM）的 <video>，用 blob: URL 指向本地文件，
 * 靠 seek 到目标时间点后触发的 onseeked 事件把当前帧 drawImage 到 <canvas>，
 * 再 toDataURL 转成 JPEG。整个过程不上传任何字节。
 *
 * @param file    用户选中的视频文件
 * @param options 抽帧时间点与质量
 * @returns Promise<{ dataUrl: JPEG 的 data URI, duration: 视频秒数 }>
 *
 * 副作用：创建/销毁 blob URL 与 DOM 元素；每条退出路径都成对调用
 *         URL.revokeObjectURL + video.remove()，否则大文件的 blob 会一直驻留内存。
 *
 * 失败情形（均 reject）：
 *   - 浏览器无法解码该封装格式（onerror）—— 常见于 MKV/FLV/WMV
 *   - 取不到 2D canvas 上下文（极少见，通常是 GPU 进程崩溃）
 *   - 超过 15 秒仍未完成（见函数末尾的超时兜底）
 * 调用方对 reject 是容忍的：抽不到封面就走服务端/后续转码补图，不阻断上传。
 */
// Extract thumbnail from video file with options
function extractThumbnail(
  file: File,
  options: ThumbnailOptions
): Promise<{ dataUrl: string; duration: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    const url = URL.createObjectURL(file);
    video.src = url;

    // 元数据就绪 → 计算抽帧时间点并 seek。真正的取帧发生在随后的 onseeked。
    video.onloadedmetadata = () => {
      const duration = video.duration;
      let captureAt: number;
      if (options.captureTime === "custom") {
        // 减 0.1 秒的余量：精确 seek 到最后一帧在部分解码器上不会触发 seeked 事件
        captureAt = Math.min(options.customSeconds, duration - 0.1);
      } else {
        // 自动模式取 min(2秒, 5%)：短片按比例避开片头，长片固定 2 秒即可跳过黑场，
        // 同时避免长视频 seek 到很靠后的位置引发大量数据读取
        captureAt = Math.min(2, duration * 0.05);
      }
      video.currentTime = Math.max(0, captureAt);
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        // ===== 按 16:9 内接框缩放，保持原始宽高比 =====
        // 先夹到 640×360 上限（封面用不着更高分辨率，且 dataURL 要塞进 tRPC 请求体，
        // 体积必须可控），再根据原始宽高比收缩其中一边，避免拉伸变形。
        canvas.width = Math.min(video.videoWidth, 640);
        canvas.height = Math.min(video.videoHeight, 360);
        const aspectRatio = video.videoWidth / video.videoHeight;
        if (canvas.width / canvas.height > aspectRatio) {
          // 当前框比原视频"更宽" → 以高度为准收窄宽度
          canvas.width = Math.round(canvas.height * aspectRatio);
        } else {
          // 当前框比原视频"更高" → 以宽度为准压低高度
          canvas.height = Math.round(canvas.width / aspectRatio);
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const quality = QUALITY_VALUES[options.quality] || 0.8;
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          URL.revokeObjectURL(url);
          video.remove();
          resolve({ dataUrl, duration: video.duration });
        } else {
          URL.revokeObjectURL(url);
          video.remove();
          reject(new Error("Canvas context not available"));
        }
      } catch (e) {
        URL.revokeObjectURL(url);
        video.remove();
        reject(e);
      }
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      video.remove();
      reject(new Error("Failed to load video"));
    };

    // 超时兜底：某些封装格式（MKV/FLV 等）浏览器既不报 error 也永远不触发 seeked，
    // 没有这个定时器就会永久挂起、阻塞整个上传流程。
    // 15 秒对本地文件的 metadata 解析已经非常宽裕。
    // 注意：该定时器不会被取消，成功路径上它仍会到点执行，
    // 但此时 Promise 早已 resolve，reject 是空操作（revoke 重复调用亦无害）。
    setTimeout(() => {
      URL.revokeObjectURL(url);
      video.remove();
      reject(new Error("Thumbnail extraction timeout"));
    }, 15000);
  });
}

/** 字节数 → 人类可读体积（B / KB / MB / GB）。也被复用于展示上传速率（拼上 "/s"）。 */
// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 秒数 → 日语时长文案（"45秒" / "3分20秒" / "1時間25分"），用于剩余时间 ETA。 */
// Format seconds to human readable time
function formatTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒`;
  return `${Math.floor(seconds / 3600)}時間${Math.floor((seconds % 3600) / 60)}分`;
}

/**
 * Upload a single chunk via binary POST (no Base64 encoding)
 *
 * 上传单个分片（原始二进制，不做 Base64）。
 *
 * 走 multipart/form-data 而非 tRPC 的原因见文件头：Base64 会让 50MB 分片膨胀到 ~67MB，
 * 且编码过程在主线程会造成明显卡顿。
 *
 * @param sessionId  initSession 返回的会话 ID
 * @param chunkIndex 分片序号（从 0 开始）。服务端据此定位偏移量，因此**允许乱序到达**
 * @param chunkBlob  File.slice() 得到的分片，浏览器不会立即读进内存
 * @returns 服务端返回的 `{ success, progress }`（progress 为服务端视角的整体进度）
 *
 * @throws Error 非 2xx 响应时抛出，message 优先取响应体的 error 字段，
 *               响应体不是 JSON 时退化为 `HTTP <status>`
 * @副作用 服务端会把该分片落 S3 并写入 video_upload_chunks 表
 *
 * `credentials: "include"` 必需 —— 该端点靠 JWT Cookie 鉴权，
 * 而 fetch 默认不带跨站 Cookie。
 */
async function uploadChunkBinary(
  sessionId: string,
  chunkIndex: number,
  chunkBlob: Blob
): Promise<{ success: boolean; progress: number }> {
  const formData = new FormData();
  formData.append("sessionId", sessionId);
  formData.append("chunkIndex", String(chunkIndex));
  formData.append("file", chunkBlob, `chunk-${chunkIndex}`);

  const response = await fetch("/api/upload/chunk", {
    method: "POST",
    body: formData,
    credentials: "include", // Include cookies for auth
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Parallel chunk uploader with concurrency control
 *
 * 并发分片上传器（固定 worker 池 + 共享任务队列 + 分片级重试）。
 *
 * 并发模型：不是"一次性发起 N 个 Promise"，而是启动 `concurrency` 个常驻 worker，
 * 每个 worker 循环从共享队列 `queue` 里 shift 取任务。这样无论文件多大，
 * 同时在途的请求数恒定为 concurrency，内存占用可预测。
 * JS 单线程保证了 `queue.shift()` 是原子的，无需加锁。
 *
 * @param file        源文件，用 slice() 惰性切片（不会把整个文件读进内存）
 * @param sessionId   上传会话 ID
 * @param totalChunks 分片总数 = ceil(file.size / CHUNK_SIZE)
 * @param concurrency 并发 worker 数，调用方传 PARALLEL_UPLOADS
 * @param onProgress  每完成一个分片回调一次 `(已完成分片数, 平均速率 bytes/s)`
 * @param signal      取消信号，worker 在每轮循环开始时检查
 *
 * @throws 任一分片重试耗尽后抛出该分片的错误
 * @副作用 通过 uploadChunkBinary 写 S3 与数据库
 */
async function uploadChunksParallel(
  file: File,
  sessionId: string,
  totalChunks: number,
  concurrency: number,
  onProgress: (uploaded: number, speed: number) => void,
  signal?: AbortSignal
): Promise<void> {
  let completedChunks = 0;
  let totalBytesUploaded = 0;
  const startTime = Date.now();
  // 共享任务队列：[0, 1, 2, ..., totalChunks-1]
  const queue: number[] = Array.from({ length: totalChunks }, (_, i) => i);
  // errors 非空即作为"熔断"信号，让其余 worker 在下一轮循环时主动退出，
  // 避免一个分片彻底失败后剩下几百个分片还在白白上传
  const errors: Error[] = [];

  async function worker() {
    while (queue.length > 0 && errors.length === 0) {
      if (signal?.aborted) throw new Error("Upload cancelled");

      const chunkIndex = queue.shift()!;
      // 按序号换算字节区间；最后一片用 min 截断到文件末尾（通常不足 CHUNK_SIZE）
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunkBlob = file.slice(start, end);

      // ===== 分片级重试：最多 3 次 =====
      // 大文件上传跨越几十分钟，期间网络抖动、CDN 切节点、域名轮换都可能打断单个请求。
      // 重试粒度控制在分片级别，一片失败只重传 50MB，不必从头再来。
      let retries = 3;
      while (retries > 0) {
        try {
          await uploadChunkBinary(sessionId, chunkIndex, chunkBlob);
          completedChunks++;
          totalBytesUploaded += (end - start);
          // 速率用「累计字节 / 累计耗时」的平均值而非瞬时值：
          // 瞬时速率在多 worker 交错完成时抖动剧烈，UI 上数字会疯狂跳动
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = totalBytesUploaded / elapsed; // bytes/sec
          onProgress(completedChunks, speed);
          break;
        } catch (err: any) {
          retries--;
          if (retries === 0) {
            // 触发熔断并让 Promise.all 立即 reject
            errors.push(err);
            throw err;
          }
          // Wait before retry (exponential backoff)
          // 退避间隔：第 1 次失败等 2s，第 2 次等 4s（(3-retries)*2000）。
          // 注：严格说这是线性退避而非指数退避，注释与实现有出入，但对
          // 短暂网络抖动已经够用。
          await new Promise((r) => setTimeout(r, (3 - retries) * 2000));
        }
      }
    }
  }

  // Launch concurrent workers
  // 分片数少于并发数时不必启动多余 worker（否则它们一进循环就因队列空而退出）
  const workers = Array.from({ length: Math.min(concurrency, totalChunks) }, () => worker());
  await Promise.all(workers);

  if (errors.length > 0) {
    throw errors[0];
  }
}

/**
 * 视频上传面板。无 props，状态完全自治。
 *
 * 内部状态职责：
 *   uploadingFiles   —— 当前所有上传任务的展示状态数组，驱动底部进度卡片
 *   thumbnailOptions —— 封面抽帧参数，会在下一次 uploadFile 时生效
 *   manualThumbnail  —— 用户手动指定的封面 dataURL；一旦设置就**跳过自动抽帧**，
 *                       且对之后上传的每个文件都生效（不会自动清空）
 *   showOptions      —— 高级设置面板折叠状态
 *
 * Ref 职责：
 *   fileInputRef / thumbnailInputRef —— 隐藏的 <input type=file>，靠按钮 click() 唤起
 *   dropZoneRef      —— 拖拽高亮直接操作 classList，绕开 React 重渲染（拖拽事件极高频）
 *   abortControllerRef —— 取消上传用的信号源
 */
export default function VideoUploadForm() {
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [showOptions, setShowOptions] = useState(false);
  const [thumbnailOptions, setThumbnailOptions] = useState<ThumbnailOptions>({
    captureTime: "auto",
    customSeconds: 5,
    quality: "medium",
  });
  const [manualThumbnail, setManualThumbnail] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const initSessionMutation = trpc.videoUploadV2.initSession.useMutation();
  const completeUploadMutation = trpc.videoUploadV2.completeUpload.useMutation();

  /**
   * 前端预校验：扩展名白名单 + 体积上限。
   * @returns 错误文案；校验通过返回 null。
   *
   * 注意这是**纯前端**校验，只为尽早给出反馈；真正的安全边界在服务端
   * （initSession 会重新校验扩展名，/api/upload/chunk 会校验会话归属）。
   */
  const validateFile = (file: File): string | null => {
    const allowedFormats = [".mp4", ".webm", ".mkv", ".avi", ".mov", ".flv", ".wmv", ".m4v"];
    // 靠最后一个 "." 取扩展名。无扩展名的文件会取到整个文件名，必然不在白名单内 → 被拒
    const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();

    if (!allowedFormats.includes(ext)) {
      return `Invalid format. Allowed: ${allowedFormats.join(", ")}`;
    }

    if (file.size > MAX_FILE_SIZE) {
      return "File size exceeds 100GB limit";
    }

    return null;
  };

  /**
   * 单个文件的完整上传流程（校验 → 抽封面 → 建会话 → 并发传片 → 收尾）。
   *
   * 执行顺序上的一个关键点：**封面抽取排在 initSession 之前**。
   * 因为 initSession 需要把封面 dataURL 和时长一并写进会话的 metadata 列，
   * 服务端在 completeUpload 时才从那里读出来落库。
   *
   * @param file 用户选中/拖入的文件
   * @副作用 修改 uploadingFiles 状态、弹 toast、写 S3、写数据库、触发服务端 LLM 分析
   * 所有异常都在内部捕获并转成 error 状态 + toast，不向外抛。
   */
  const uploadFile = useCallback(
    async (file: File) => {
      const error = validateFile(file);
      if (error) {
        toast.error(error);
        return;
      }

      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      // Extract thumbnail and duration
      // 手动封面优先；只有没设手动封面时才做自动抽帧。
      // ⚠️ 走手动封面分支时 videoDuration 保持 0，服务端因而拿不到时长 ——
      //    而 hlsStream.getManifest 在 duration<=0 时会降级为 direct 模式（无广告）。
      let thumbnailDataUrl: string | null = manualThumbnail;
      let videoDuration = 0;

      if (!thumbnailDataUrl) {
        try {
          const { dataUrl, duration } = await extractThumbnail(file, thumbnailOptions);
          thumbnailDataUrl = dataUrl;
          videoDuration = Math.round(duration);
        } catch (e) {
          // 抽帧失败不阻断上传：封面可以后续由转码流程补，视频本体才是关键
          console.warn("Could not extract thumbnail:", e);
        }
      }

      try {
        // Initialize upload session (still via tRPC - small payload)
        // 控制面仍走 tRPC：payload 只有文件名/大小/分片数/封面 dataURL，体积可控
        const sessionResult = await initSessionMutation.mutateAsync({
          fileName: file.name,
          // BigInt：文件大小可达 100GB（约 1.07e11），已超出 Number 安全整数的直觉范围，
          // 且服务端列类型为 BIGINT；superjson 能正确序列化 BigInt
          fileSize: BigInt(file.size),
          totalChunks,
          thumbnailData: thumbnailDataUrl || undefined,
          duration: videoDuration || undefined,
        });
        const sessionId = sessionResult.sessionId;

        // Add to uploading files
        setUploadingFiles((prev) => [
          ...prev,
          {
            sessionId,
            fileName: file.name,
            fileSize: file.size,
            progress: 0,
            status: "uploading",
            thumbnailPreview: thumbnailDataUrl || undefined,
            speed: "計算中...",
            eta: "計算中...",
          },
        ]);

        // Upload chunks in parallel using binary endpoint
        await uploadChunksParallel(
          file,
          sessionId,
          totalChunks,
          PARALLEL_UPLOADS,
          // 进度回调：把「已完成分片数 + 平均速率」翻译成百分比 / 速度 / 剩余时间文案
          (completedChunks, speed) => {
            // 按分片数算百分比（非字节数）：最后一片通常不满 CHUNK_SIZE，
            // 因此这里的百分比是近似值，末尾可能略微偏低
            const progress = Math.round((completedChunks / totalChunks) * 100);
            const remainingBytes = file.size - (completedChunks * CHUNK_SIZE);
            const eta = speed > 0 ? remainingBytes / speed : 0;

            setUploadingFiles((prev) =>
              prev.map((f) =>
                f.sessionId === sessionId
                  ? {
                      ...f,
                      progress,
                      speed: `${formatBytes(speed)}/s`,
                      eta: formatTime(Math.max(0, eta)),
                    }
                  : f
              )
            );
          },
          abortController.signal
        );

        // Complete upload
        // 字节已全部送达 → 切到 processing。服务端在 completeUpload 里要做
        // 分片齐全校验 + LLM 生成标题/描述/分类 + 封面落 S3 + 合并分片 + 落 videos 表，
        // 大文件下这一步可能持续数分钟，所以必须有独立的"处理中"态而非停在 100%。
        setUploadingFiles((prev) =>
          prev.map((f) =>
            f.sessionId === sessionId
              ? { ...f, status: "processing", progress: 100, speed: undefined, eta: "処理中..." }
              : f
          )
        );

        await completeUploadMutation.mutateAsync({ sessionId });

        setUploadingFiles((prev) =>
          prev.map((f) =>
            f.sessionId === sessionId
              ? { ...f, status: "completed", progress: 100, eta: undefined }
              : f
          )
        );

        toast.success(`「${file.name}」のアップロードが完了しました`);

        // 完成 5 秒后自动从列表移除，让面板保持清爽（失败项则保留，需用户手动关闭）
        // Auto-remove completed file after 5 seconds
        setTimeout(() => {
          setUploadingFiles((prev) =>
            prev.filter((f) => f.sessionId !== sessionId)
          );
        }, 5000);
      } catch (err: any) {
        const errorMessage = err?.message || "Upload failed";
        // 用 fileName + status 定位失败项而不是 sessionId：
        // initSession 阶段就失败时根本还没有 sessionId 可用
        setUploadingFiles((prev) =>
          prev.map((f) =>
            f.fileName === file.name && f.status === "uploading"
              ? { ...f, status: "error", error: errorMessage }
              : f
          )
        );
        toast.error(errorMessage);
      }
    },
    [initSessionMutation, completeUploadMutation, thumbnailOptions, manualThumbnail]
  );

  /**
   * 处理文件选择/拖入。
   * 刻意不 await —— 多文件时全部并发上传（每个文件内部再各自开 PARALLEL_UPLOADS 个 worker）。
   */
  const handleFileSelect = (files: FileList | null) => {
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      uploadFile(files[i]);
    }
  };

  // ===== 拖放区事件 =====
  // 三个 handler 都必须 preventDefault + stopPropagation：
  // 浏览器对文件拖放的默认行为是"在当前标签页打开该文件"，
  // 不阻止的话用户拖入视频会直接跳出 SPA。
  // 高亮效果直接改 classList 而非走 state —— dragover 每秒触发数十次，
  // 走 React 会引发大量无意义重渲染。
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dropZoneRef.current?.classList.add("border-purple-600", "bg-purple-600/10");
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dropZoneRef.current?.classList.remove("border-purple-600", "bg-purple-600/10");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dropZoneRef.current?.classList.remove("border-purple-600", "bg-purple-600/10");
    handleFileSelect(e.dataTransfer.files);
  };

  /**
   * 取消上传：拉起 abort 信号让 worker 在下一轮循环退出，并把该项从列表移除。
   *
   * 注意服务端**不会**被通知取消，已上传的分片会以孤儿会话形式留在
   * video_upload_sessions / S3 中，需要靠服务端的过期清理任务回收。
   */
  const cancelUpload = (sessionId: string) => {
    abortControllerRef.current?.abort();
    setUploadingFiles((prev) => prev.filter((f) => f.sessionId !== sessionId));
    toast.info("アップロードをキャンセルしました");
  };

  /** 从列表中移除一条已完成/已失败的记录。纯 UI 操作，不影响服务端数据。 */
  const removeFile = (sessionId: string) => {
    setUploadingFiles((prev) => prev.filter((f) => f.sessionId !== sessionId));
  };

  /**
   * 手动指定封面：用 FileReader 把图片读成 dataURL 存进 state。
   * 设置后会**跳过自动抽帧**，且对之后每个上传的文件持续生效，直到用户点「クリア」。
   * 副作用：dataURL 会常驻内存并随每次 initSession 一起上行，图片过大会显著增加请求体。
   */
  // Handle manual thumbnail upload
  const handleManualThumbnailSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setManualThumbnail(dataUrl);
      toast.success("サムネイル画像を設定しました");
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-6">
      {/* Drop Zone */}
      <Card className="bg-slate-800 border-slate-700">
        <CardContent className="p-8">
          <div
            ref={dropZoneRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="border-2 border-dashed border-slate-600 rounded-lg p-12 text-center transition cursor-pointer hover:border-purple-600 hover:bg-purple-600/5"
          >
            <Upload className="w-12 h-12 text-slate-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-white mb-2">
              ビデオをアップロード
            </h3>
            <p className="text-slate-400 mb-2">
              ファイルをドラッグ＆ドロップするか、クリックして選択
            </p>
            <p className="text-sm text-slate-500 mb-2">
              対応形式: MP4, WebM, MKV, AVI, MOV, FLV, WMV, M4V (最大100GB)
            </p>
            <div className="flex items-center justify-center gap-2 text-xs text-emerald-400 mb-2">
              <Zap className="w-3 h-3" />
              <span>高速並列アップロード（{PARALLEL_UPLOADS}並列 × {CHUNK_SIZE / (1024 * 1024)}MB チャンク）</span>
            </div>
            <p className="text-xs text-purple-400 mb-4">
              <Image className="w-3 h-3 inline mr-1" />
              {manualThumbnail
                ? "手動サムネイルが設定されています"
                : thumbnailOptions.captureTime === "custom"
                ? `サムネイルを ${thumbnailOptions.customSeconds}秒 の位置から抽出します`
                : "サムネイルは自動的にビデオから抽出されます"}
            </p>
            <Button
              onClick={() => fileInputRef.current?.click()}
              className="bg-purple-600 hover:bg-purple-700"
            >
              <Upload className="w-4 h-4 mr-2" />
              ファイルを選択
            </Button>
            {/* 隐藏的原生 file input：由上方按钮 click() 唤起。
                accept 只是文件选择器的过滤提示，真正的校验在 validateFile 与服务端。 */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".mp4,.webm,.mkv,.avi,.mov,.flv,.wmv,.m4v"
              onChange={(e) => handleFileSelect(e.target.files)}
              className="hidden"
            />
          </div>
        </CardContent>
      </Card>

      {/* Thumbnail Options */}
      <Card className="bg-slate-800 border-slate-700">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-white text-base flex items-center gap-2">
              <Settings2 className="w-4 h-4 text-purple-400" />
              サムネイル設定
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowOptions(!showOptions)}
              className="text-slate-400 hover:text-white text-xs"
            >
              {showOptions ? "閉じる" : "詳細設定"}
            </Button>
          </div>
        </CardHeader>

        {showOptions && (
          <CardContent className="space-y-4 pt-0">
            {/* Capture Time Option */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                <Clock className="w-4 h-4 text-purple-400" />
                キャプチャタイミング
              </label>
              <div className="flex gap-2">
                <Button
                  variant={thumbnailOptions.captureTime === "auto" ? "default" : "outline"}
                  size="sm"
                  onClick={() =>
                    setThumbnailOptions((prev) => ({ ...prev, captureTime: "auto" }))
                  }
                  className={
                    thumbnailOptions.captureTime === "auto"
                      ? "bg-purple-600 text-white"
                      : "border-slate-600 text-slate-300 hover:text-white"
                  }
                >
                  自動（2秒 / 5%）
                </Button>
                <Button
                  variant={thumbnailOptions.captureTime === "custom" ? "default" : "outline"}
                  size="sm"
                  onClick={() =>
                    setThumbnailOptions((prev) => ({ ...prev, captureTime: "custom" }))
                  }
                  className={
                    thumbnailOptions.captureTime === "custom"
                      ? "bg-purple-600 text-white"
                      : "border-slate-600 text-slate-300 hover:text-white"
                  }
                >
                  カスタム
                </Button>
              </div>

              {/* 自定义抽帧位置滑块。上限 300 秒（5 分钟）是刻意的：
                  封面通常取自片头，允许拖到更后面既无意义，也会让 seek 变慢。
                  超出实际时长时 extractThumbnail 会自动夹到 duration-0.1。 */}
              {thumbnailOptions.captureTime === "custom" && (
                <div className="flex items-center gap-3 mt-2">
                  <input
                    type="range"
                    min="0"
                    max="300"
                    step="1"
                    value={thumbnailOptions.customSeconds}
                    onChange={(e) =>
                      setThumbnailOptions((prev) => ({
                        ...prev,
                        customSeconds: parseInt(e.target.value),
                      }))
                    }
                    className="flex-1 h-2 accent-purple-600 cursor-pointer"
                  />
                  <span className="text-sm text-slate-300 min-w-[60px]">
                    {thumbnailOptions.customSeconds}秒
                  </span>
                </div>
              )}
            </div>

            {/* Quality Option */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300">画質</label>
              <div className="flex gap-2">
                {(["low", "medium", "high"] as const).map((q) => (
                  <Button
                    key={q}
                    variant={thumbnailOptions.quality === q ? "default" : "outline"}
                    size="sm"
                    onClick={() =>
                      setThumbnailOptions((prev) => ({ ...prev, quality: q }))
                    }
                    className={
                      thumbnailOptions.quality === q
                        ? "bg-purple-600 text-white"
                        : "border-slate-600 text-slate-300 hover:text-white"
                    }
                  >
                    {q === "low" ? "低" : q === "medium" ? "中" : "高"}
                  </Button>
                ))}
              </div>
            </div>

            {/* Manual Thumbnail */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300">手動サムネイル</label>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => thumbnailInputRef.current?.click()}
                  className="border-slate-600 text-slate-300 hover:text-white"
                >
                  <Image className="w-4 h-4 mr-2" />
                  画像を選択
                </Button>
                {manualThumbnail && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setManualThumbnail(null)}
                    className="text-red-400 hover:text-red-300"
                  >
                    <X className="w-4 h-4 mr-1" />
                    クリア
                  </Button>
                )}
                <input
                  ref={thumbnailInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleManualThumbnailSelect}
                  className="hidden"
                />
              </div>
              {manualThumbnail && (
                <img
                  src={manualThumbnail}
                  alt="Manual thumbnail"
                  className="w-32 h-20 object-cover rounded border border-slate-600"
                />
              )}
            </div>
          </CardContent>
        )}
      </Card>

      {/* Upload Progress */}
      {/* 上传状况列表：进度条颜色即状态指示
          紫=上传中 / 黄+脉冲=服务端处理中 / 绿=完成 / 红=失败 */}
      {uploadingFiles.length > 0 && (
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base">アップロード状況</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {uploadingFiles.map((file) => (
              <div
                key={file.sessionId}
                className="bg-slate-700/50 rounded-lg p-4"
              >
                <div className="flex items-start gap-4">
                  {/* Thumbnail preview */}
                  {file.thumbnailPreview && (
                    <img
                      src={file.thumbnailPreview}
                      alt="Preview"
                      className="w-20 h-14 object-cover rounded"
                    />
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-medium text-white truncate">
                        {file.fileName}
                      </p>
                      {file.status === "uploading" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => cancelUpload(file.sessionId)}
                          className="text-red-400 hover:text-red-300 h-6 px-2"
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      )}
                      {(file.status === "completed" || file.status === "error") && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeFile(file.sessionId)}
                          className="text-slate-400 hover:text-white h-6 px-2"
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      )}
                    </div>

                    <div className="flex items-center gap-3 text-xs text-slate-400 mb-2">
                      <span>{formatBytes(file.fileSize)}</span>
                      {file.speed && file.status === "uploading" && (
                        <>
                          <span className="text-emerald-400">{file.speed}</span>
                          <span>残り: {file.eta}</span>
                        </>
                      )}
                      {file.status === "processing" && (
                        <span className="text-yellow-400">AI分析中...</span>
                      )}
                    </div>

                    {/* Progress bar */}
                    <div className="w-full bg-slate-600 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all duration-300 ${
                          file.status === "completed"
                            ? "bg-green-500"
                            : file.status === "error"
                            ? "bg-red-500"
                            : file.status === "processing"
                            ? "bg-yellow-500 animate-pulse"
                            : "bg-purple-500"
                        }`}
                        style={{ width: `${file.progress}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs text-slate-400">
                        {file.status === "completed" && (
                          <span className="text-green-400 flex items-center gap-1">
                            <Play className="w-3 h-3" /> 完了
                          </span>
                        )}
                        {file.status === "error" && (
                          <span className="text-red-400 flex items-center gap-1">
                            <AlertCircle className="w-3 h-3" /> {file.error}
                          </span>
                        )}
                        {file.status === "uploading" && `${file.progress}%`}
                        {file.status === "processing" && "処理中..."}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
