/**
 * Voice transcription helper using internal Speech-to-Text service
 *
 * Frontend implementation guide:
 * 1. Capture audio using MediaRecorder API
 * 2. Upload audio to storage (e.g., S3) to get URL
 * 3. Call transcription with the URL
 * 
 * Example usage:
 * ```tsx
 * // Frontend component
 * const transcribeMutation = trpc.voice.transcribe.useMutation({
 *   onSuccess: (data) => {
 *     console.log(data.text); // Full transcription
 *     console.log(data.language); // Detected language
 *     console.log(data.segments); // Timestamped segments
 *   }
 * });
 * 
 * // After uploading audio to storage
 * transcribeMutation.mutate({
 *   audioUrl: uploadedAudioUrl,
 *   language: 'en', // optional
 *   prompt: 'Transcribe the meeting' // optional
 * });
 * ```
 *
 * ============================================================================
 * server/_core/voiceTranscription.ts — 语音转文字（Whisper）封装
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 外部服务适配层**。
 * 封装 Forge 网关的 OpenAI 兼容端点 `/v1/audio/transcriptions`（whisper-1 模型）。
 *
 * ## 主要导出
 * - `transcribeAudio(options)` —— 给定音频 URL，下载 → 校验 → 转发给 Whisper → 返回转写结果。
 * - 类型：`TranscribeOptions`（入参）、`WhisperSegment` / `WhisperResponse` /
 *   `TranscriptionResponse`（成功返回）、`TranscriptionError`（失败返回）。
 * - 内部辅助（未导出）：`getFileExtension()`、`getLanguageName()`。
 *
 * ## 上下游依赖
 * - 上游调用方：当前代码库中**暂无业务调用**（Manus 模板预置能力，文件末尾附有
 *   接入 tRPC 的示例代码）。
 * - 下游依赖：`./env` 的 `ENV.forgeApiUrl` / `ENV.forgeApiKey`；两次出网请求 ——
 *   一次拉取音频源文件，一次调 Whisper。
 *
 * ## 关键设计决策与坑
 * 1. **错误以返回值表达，不抛异常**：所有失败路径都返回 `TranscriptionError` 对象。
 *    因此**返回类型是联合类型**，调用方必须先做 `if ('error' in result)` 判别才能
 *    安全访问 `.text`。这与本目录其他模块（llm/imageGeneration 直接 throw）风格相反。
 * 2. **服务端代下载，不透传 URL**：Whisper 端点只收 multipart 文件流，不接受远程 URL，
 *    所以必须先把音频拉到本地内存再转发。代价是整个文件驻留内存（见下条限制）。
 * 3. **16MB 硬上限**：既是 Whisper API 的官方文件大小限制，也顺带防止大文件把
 *    Node 进程内存打爆。超限直接返回 `FILE_TOO_LARGE`，不做分片。
 * 4. **`Accept-Encoding: identity`**：显式禁用响应压缩。verbose_json 响应体可能较大，
 *    禁用 gzip 是为规避某些代理/运行时在流式解压 multipart 响应时的兼容性问题。
 */
import { ENV } from "./env";

/**
 * 转写入参。
 *
 * @property audioUrl 音频文件的可访问 URL（通常是 S3/CDN 地址）。服务端会先 GET 下载。
 * @property language ISO 639-1 语言代码。**不是**强制指定识别语言，仅用于生成提示词
 *                    （见 `getLanguageName`），Whisper 仍会自行检测语言并回填 `response.language`。
 * @property prompt   自定义提示词，优先级高于 `language` 自动生成的那条。
 *                    可用于提供专有名词、术语表以提升识别准确率。
 */
export type TranscribeOptions = {
  audioUrl: string; // URL to the audio file (e.g., S3 URL)
  language?: string; // Optional: specify language code (e.g., "en", "es", "zh")
  prompt?: string; // Optional: custom prompt for the transcription
};

// Native Whisper API segment format
/**
 * Whisper `verbose_json` 模式下的单个时间片段（原样透传，字段名保持 snake_case）。
 * - `start` / `end`：片段在音频中的起止秒数，可用于生成字幕。
 * - `avg_logprob`：平均对数概率，越接近 0 越可信；显著为负说明识别质量差。
 * - `no_speech_prob`：该片段为静音/无人声的概率，可用于过滤幻听输出。
 * - `compression_ratio`：文本压缩比，异常高通常意味着模型陷入了重复循环。
 */
export type WhisperSegment = {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
};

// Native Whisper API response format
/**
 * Whisper `verbose_json` 响应体。
 * - `language`：**模型检测出的**语言（不一定等于入参 `options.language`）。
 * - `duration`：音频总时长（秒）。
 * - `text`：完整转写文本。
 * - `segments`：带时间戳的分段结果，可直接用于生成 SRT/VTT 字幕。
 */
export type WhisperResponse = {
  task: "transcribe";
  language: string;
  duration: number;
  text: string;
  segments: WhisperSegment[];
};

/** 成功返回值 = 原生 Whisper 响应，刻意不做二次包装，方便未来直接替换实现。 */
export type TranscriptionResponse = WhisperResponse; // Return native Whisper API response directly

/**
 * 失败返回值（注意：是**返回**而非抛出）。
 *
 * `code` 语义：
 * - `FILE_TOO_LARGE`      音频超过 16MB 上限
 * - `INVALID_FORMAT`      音频 URL 下载返回非 2xx（当前实现把"下载失败"归到了这一类）
 * - `TRANSCRIPTION_FAILED` Whisper 端点返回非 2xx
 * - `UPLOAD_FAILED`       类型中已声明但当前实现未使用（预留）
 * - `SERVICE_ERROR`       环境变量缺失、网络异常、响应结构非法等其他情况
 */
export type TranscriptionError = {
  error: string;
  code: "FILE_TOO_LARGE" | "INVALID_FORMAT" | "TRANSCRIPTION_FAILED" | "UPLOAD_FAILED" | "SERVICE_ERROR";
  details?: string;
};

/**
 * Transcribe audio to text using the internal Speech-to-Text service
 *
 * @param options - Audio data and metadata
 * @returns Transcription result or error
 *
 * 把远程音频转写为文本。
 *
 * 权限级别：无（内部工具函数，鉴权由调用它的 tRPC procedure 负责）。
 *
 * 副作用：
 * - 两次出网 HTTP：GET 下载音频 + POST 调用 Whisper（**计费**）。
 * - 音频完整读入内存（受 16MB 上限约束）。
 * - 不写库、不写 S3、无重试、无超时。
 *
 * 流程：校验配置 → 下载音频并检查体积 → 组装 multipart FormData →
 *       调用 Whisper → 校验响应结构 → 原样返回。
 *
 * @param options 见 `TranscribeOptions`
 * @returns 成功时为 `WhisperResponse`；**失败时同样是正常返回**一个
 *          `TranscriptionError`。调用方必须用 `'error' in result` 判别，
 *          不能只靠 try/catch。
 * @throws 正常情况下不抛异常 —— 最外层 try/catch 会把一切意外收敛成 `SERVICE_ERROR`。
 */
export async function transcribeAudio(
  options: TranscribeOptions
): Promise<TranscriptionResponse | TranscriptionError> {
  try {
    // Step 1: Validate environment configuration
    if (!ENV.forgeApiUrl) {
      return {
        error: "Voice transcription service is not configured",
        code: "SERVICE_ERROR",
        details: "BUILT_IN_FORGE_API_URL is not set"
      };
    }
    if (!ENV.forgeApiKey) {
      return {
        error: "Voice transcription service authentication is missing",
        code: "SERVICE_ERROR",
        details: "BUILT_IN_FORGE_API_KEY is not set"
      };
    }

    // Step 2: Download audio from URL
    let audioBuffer: Buffer;
    let mimeType: string;
    try {
      const response = await fetch(options.audioUrl);
      if (!response.ok) {
        return {
          error: "Failed to download audio file",
          code: "INVALID_FORMAT",
          details: `HTTP ${response.status}: ${response.statusText}`
        };
      }
      
      // 全量读入内存。这里没有先看 Content-Length 做预检 —— 意味着一个超大文件
      // 会先被完整下载下来才被判定超限，存在被恶意 URL 打爆内存的风险（已知坑）。
      audioBuffer = Buffer.from(await response.arrayBuffer());
      // 源站没给 Content-Type 时兜底为 audio/mpeg（mp3 是最常见的场景）
      mimeType = response.headers.get('content-type') || 'audio/mpeg';
      
      // Check file size (16MB limit)
      // 16MB = Whisper API 官方单文件上限；1024*1024 为字节→MB 换算因子。
      const sizeMB = audioBuffer.length / (1024 * 1024);
      if (sizeMB > 16) {
        return {
          error: "Audio file exceeds maximum size limit",
          code: "FILE_TOO_LARGE",
          details: `File size is ${sizeMB.toFixed(2)}MB, maximum allowed is 16MB`
        };
      }
    } catch (error) {
      return {
        error: "Failed to fetch audio file",
        code: "SERVICE_ERROR",
        details: error instanceof Error ? error.message : "Unknown error"
      };
    }

    // Step 3: Create FormData for multipart upload to Whisper API
    const formData = new FormData();
    
    // Create a Blob from the buffer and append to form
    // 文件名的扩展名很关键：Whisper 端点依赖它判断容器格式，随便给个名字会被判为
    // 不支持的格式。因此从 MIME 反推扩展名（见 getFileExtension）。
    // `new Uint8Array(audioBuffer)` 包一层是为了让 Node 的 Buffer 被 Blob 正确接受
    // （直接传 Buffer 在部分 Node 版本上会产生非预期的字节序列）。
    const filename = `audio.${getFileExtension(mimeType)}`;
    const audioBlob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
    formData.append("file", audioBlob, filename);
    
    // response_format=verbose_json 才会返回 segments/duration/language；
    // 默认的 json 只给一个 text 字段。
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");
    
    // Add prompt - use custom prompt if provided, otherwise generate based on language
    // 提示词三级降级：自定义 prompt > 按语言生成的提示 > 通用提示。
    // 告知模型"用户的工作语言是 X"能有效减少多语言音频被误判语种的情况。
    const prompt = options.prompt || (
      options.language 
        ? `Transcribe the user's voice to text, the user's working language is ${getLanguageName(options.language)}`
        : "Transcribe the user's voice to text"
    );
    formData.append("prompt", prompt);

    // Step 4: Call the transcription service
    // 补齐末尾斜杠，否则 `new URL(relative, base)` 会替换掉 base 的最后一段路径。
    const baseUrl = ENV.forgeApiUrl.endsWith("/")
      ? ENV.forgeApiUrl
      : `${ENV.forgeApiUrl}/`;
    
    const fullUrl = new URL(
      "v1/audio/transcriptions",
      baseUrl
    ).toString();

    // 刻意**不设置** content-type：必须由 fetch 根据 FormData 自动生成带 boundary 的
    // `multipart/form-data; boundary=...`，手写会导致 boundary 缺失、上游解析失败。
    // Accept-Encoding: identity —— 禁用响应压缩，规避代理层解压兼容性问题。
    const response = await fetch(fullUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "Accept-Encoding": "identity",
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        error: "Transcription service request failed",
        code: "TRANSCRIPTION_FAILED",
        details: `${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ""}`
      };
    }

    // Step 5: Parse and return the transcription result
    const whisperResponse = await response.json() as WhisperResponse;
    
    // Validate response structure
    // 只校验最关键的 text 字段：网关有可能返回 200 但内容是错误包装体，
    // 这里做一道最小防御，避免把非法结构当成成功结果交给调用方。
    // 注意副作用：纯静音音频转写结果为空串时也会走到这里，被误判为 SERVICE_ERROR。
    if (!whisperResponse.text || typeof whisperResponse.text !== 'string') {
      return {
        error: "Invalid transcription response",
        code: "SERVICE_ERROR",
        details: "Transcription service returned an invalid response format"
      };
    }

    return whisperResponse; // Return native Whisper API response directly

  } catch (error) {
    // Handle unexpected errors
    // 兜底：任何未被内层分支覆盖的异常（如 response.json() 解析失败）统一收敛为
    // SERVICE_ERROR，确保本函数对外承诺的"永不抛出"成立。
    return {
      error: "Voice transcription failed",
      code: "SERVICE_ERROR",
      details: error instanceof Error ? error.message : "An unexpected error occurred"
    };
  }
}

/**
 * Helper function to get file extension from MIME type
 *
 * MIME 类型 → 文件扩展名映射（内部辅助，未导出）。
 *
 * 用途：Whisper 端点靠上传文件名的扩展名判断音频容器格式，因此必须给出正确后缀。
 * 表中同时收录了 `audio/mp3` 与 `audio/mpeg`（前者不规范但浏览器/CDN 常用）、
 * `audio/wav` 与 `audio/wave`，属于现实世界的兼容性妥协。
 *
 * ⚠️ 未命中时返回 `'audio'`，拼出的文件名是 `audio.audio` —— 这不是任何已知格式，
 * 上游多半会拒绝。若源站给出的 Content-Type 带参数（如 `audio/mpeg; charset=utf-8`）
 * 也会直接查表落空，因为这里做的是**精确匹配**而非前缀匹配。
 *
 * @param mimeType 下载响应头里的 Content-Type
 * @returns 不含点号的扩展名
 */
function getFileExtension(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/mp3': 'mp3',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/ogg': 'ogg',
    'audio/m4a': 'm4a',
    'audio/mp4': 'm4a',
  };
  
  return mimeToExt[mimeType] || 'audio';
}

/**
 * Helper function to get full language name from ISO code
 *
 * ISO 639-1 语言代码 → 英文语言全名（内部辅助，未导出）。
 *
 * 仅用于拼装提示词 —— 模型对 "Japanese" 这样的自然语言表述比对 "ja" 更敏感，
 * 因此在提示里使用全名而非代码。未收录的代码原样返回（降级但不报错）。
 *
 * @param langCode 形如 "ja" / "zh" / "en" 的语言代码
 * @returns 英文语言名，未命中时返回原输入
 */
function getLanguageName(langCode: string): string {
  const langMap: Record<string, string> = {
    'en': 'English',
    'es': 'Spanish',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'pt': 'Portuguese',
    'ru': 'Russian',
    'ja': 'Japanese',
    'ko': 'Korean',
    'zh': 'Chinese',
    'ar': 'Arabic',
    'hi': 'Hindi',
    'nl': 'Dutch',
    'pl': 'Polish',
    'tr': 'Turkish',
    'sv': 'Swedish',
    'da': 'Danish',
    'no': 'Norwegian',
    'fi': 'Finnish',
  };
  
  return langMap[langCode] || langCode;
}

/**
 * Example tRPC procedure implementation:
 * 
 * ```ts
 * // In server/routers.ts
 * import { transcribeAudio } from "./_core/voiceTranscription";
 * 
 * export const voiceRouter = router({
 *   transcribe: protectedProcedure
 *     .input(z.object({
 *       audioUrl: z.string(),
 *       language: z.string().optional(),
 *       prompt: z.string().optional(),
 *     }))
 *     .mutation(async ({ input, ctx }) => {
 *       const result = await transcribeAudio(input);
 *       
 *       // Check if it's an error
 *       if ('error' in result) {
 *         throw new TRPCError({
 *           code: 'BAD_REQUEST',
 *           message: result.error,
 *           cause: result,
 *         });
 *       }
 *       
 *       // Optionally save transcription to database
 *       await db.insert(transcriptions).values({
 *         userId: ctx.user.id,
 *         text: result.text,
 *         duration: result.duration,
 *         language: result.language,
 *         audioUrl: input.audioUrl,
 *         createdAt: new Date(),
 *       });
 *       
 *       return result;
 *     }),
 * });
 * ```
 */
