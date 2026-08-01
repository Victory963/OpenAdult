/**
 * ============================================================================
 * server/file-upload.ts — 通用文件上传 + LLM 多模态分析路由
 * ============================================================================
 *
 * 架构层级：**API 路由层**。以 `fileUpload` 命名空间挂到根路由
 * （`server/routers.ts` 中的 `fileUpload: fileUploadRouter`）。
 *
 * ## 主要导出
 * - `fileUploadRouter` —— 含 6 个 procedure：
 *     | procedure          | 类型     | 作用                                   |
 *     |--------------------|----------|----------------------------------------|
 *     | `uploadFile`       | mutation | Base64 上传到 S3 并登记 user_uploads    |
 *     | `analyzeImage`     | mutation | 用 LLM 描述图片内容                     |
 *     | `analyzeVideo`     | mutation | 用 LLM 描述视频内容                     |
 *     | `analyzePDF`       | mutation | 用 LLM 摘要 PDF 文档                    |
 *     | `getUploadHistory` | query    | 分页读取当前用户的上传记录              |
 *     | `deleteUpload`     | mutation | 删除自己的上传记录                      |
 *
 * ## 上下游依赖
 * - 上游：`server/routers.ts`；前端 `client/src/components/FileUploadBox.tsx`、
 *   `VideoUploadForm.tsx`，以及搜索页（先上传拿到 URL，再传给 `search.*`）。
 * - 下游：`./storage`（storagePut → S3/Backblaze B2）、`./_core/llm`（invokeLLM）、
 *   `./db` + `../drizzle/schema`（user_uploads 表）。
 *
 * ## 关键设计决策与坑
 * 1. **Base64 over tRPC**：`uploadFile` 通过 JSON body 传 Base64 字符串，
 *    实现简单、无需额外 multipart 中间件，但**内存放大约 1.33 倍**且整份文件
 *    要在内存里驻留。因此本路由只适合头像/封面这类小文件；
 *    大视频请走 `videoUploadV2`（分片上传）或 `server/_core/fastUpload.ts`（裸二进制流）。
 * 2. **上传与分析解耦**：analyze* 三个 procedure 接受的是 URL 而非文件本身，
 *    调用方需先 `uploadFile` 拿到公开 URL。好处是分析可重试、可对外部 URL 直接使用。
 * 3. **分析结果不落库**：analyze* 只返回结果，不写 user_uploads.metadata；
 *    重复分析同一文件会重复计费。
 * 4. **所有 procedure 均为 protected**，且一律以 `ctx.user.id` 作为归属依据，
 *    从不信任客户端传入的用户标识。
 */
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
// 注：storageGet 目前在本文件中无引用点（预留给"生成临时下载 presigned URL"的未完成功能）。
import { storagePut, storageGet } from "./storage";
import { invokeLLM } from "./_core/llm";
import { getDb } from "./db";
import { userUploads } from "../drizzle/schema";
import { eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

/**
 * ファイルアップロードとAI分析ルーター
 * 画像、ビデオ、PDFなどのファイルをS3にアップロードし、
 * Heretic LLMで分析・解析する機能を提供
 *
 * ---
 * 文件上传与 AI 分析子路由。前端调用形如 `trpc.fileUpload.uploadFile.useMutation()`。
 */
export const fileUploadRouter = router({
  /**
   * ファイルをS3にアップロードして、メタデータを保存
   *
   * ---
   * 上传文件到 S3 并在 user_uploads 表登记一条记录。
   *
   * @权限 protected
   * @param input.filename 原始文件名。会被拼进 S3 key，**未做路径清洗**——
   *                       含 `../` 或 `/` 的文件名会改变对象层级（见 observations）。
   * @param input.mimeType Content-Type，原样透传给 S3，决定浏览器直链访问时的行为。
   * @param input.fileData Base64 编码的文件内容（不含 data URI 前缀）。
   * @param input.fileType "image" | "video" | "audio"，业务语义上的分类。
   * @returns `{ success, url, fileKey, filename }`，`url` 可直接用于 <img>/<video> 或传给 analyze*。
   * @副作用 写 S3 ×1；写库 ×1（user_uploads）
   * @throws `ファイルアップロードに失敗しました: <原因>`
   */
  uploadFile: protectedProcedure
    .input(
      z.object({
        filename: z.string(),
        mimeType: z.string(),
        fileData: z.string(), // Base64エンコードされたファイルデータ
        fileType: z.enum(["image", "video", "audio"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        // Base64 → Buffer。注意 Node 的 Buffer.from(..., "base64") 对非法字符是
        // **静默跳过**而非报错，因此损坏的输入不会在这里抛异常，
        // 而是变成一份内容残缺的文件传上 S3。
        // Base64をバッファに変換
        const buffer = Buffer.from(input.fileData, "base64");

        // S3 对象键的结构：uploads/<用户ID>/<毫秒时间戳>-<原始文件名>
        //   - 用 userId 分目录：便于按用户做配额统计与批量清理，也天然隔离命名冲突；
        //   - 加 Date.now() 前缀：同名文件重复上传时不会互相覆盖（时间戳做去重）。
        // ⚠️ input.filename 未做清洗即拼进 key，存在路径穿越/键污染风险（见 observations）。
        // S3にアップロード
        const fileKey = `uploads/${ctx.user.id}/${Date.now()}-${input.filename}`;
        const { url } = await storagePut(fileKey, buffer, input.mimeType);

        // 数据库不可用时**只跳过登记，不回滚 S3** —— 文件已经传上去了，
        // 结果是产生一个没有数据库记录的孤儿对象。这是刻意的取舍：
        // 上传成功比记账完整更重要，用户至少能拿到可用的 URL。
        // メタデータをデータベースに保存
        const database = await getDb();
        if (database) {
          // 类型收窄：业务层有 image/video/audio 三种，
          // 但 user_uploads.uploadType 的 MySQL enum 只有 ["image","video"]，
          // 所以把 audio 归并到 video（都是时基媒体）。
          // 原始的三分类信息不会丢 —— 下面的 metadata JSON 里完整保留了 fileType。
          // uploadTypeをスキーマに合わせて保存
          // fileTypeが"audio"の場合、uploadTypeは"video"に統一
          const uploadType = input.fileType === "audio" ? "video" : (input.fileType as "image" | "video");
          await database.insert(userUploads).values({
            userId: ctx.user.id,
            uploadType: uploadType,
            fileUrl: url,
            // metadata 列在 schema 中是 text 而非 json，故此处需手动 JSON.stringify；
            // 读取方（getUploadHistory 的调用者）也必须自行 JSON.parse。
            // 存原始文件名/MIME/细分类型，是为了保留 S3 key 里丢失的信息。
            metadata: JSON.stringify({
              originalFilename: input.filename,
              mimeType: input.mimeType,
              fileType: input.fileType,
            }),
            // s3Key 与 s3Url 分开存：key 用于将来做删除/迁移，
            // url 是当下可直接访问的地址（CDN 域名换掉后 url 会失效，key 不会）。
            s3Key: fileKey,
            s3Url: url,
            // 存的是解码后的真实字节数，而非 Base64 字符串长度
            fileSize: buffer.length,
          });
        }

        return {
          success: true,
          url,
          fileKey,
          filename: input.filename,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("[File Upload] Error:", errorMessage);
        throw new Error(`ファイルアップロードに失敗しました: ${errorMessage}`);
      }
    }),

  /**
   * 画像をHeretic LLMで分析
   *
   * ---
   * 用 LLM 分析图片内容并返回自然语言描述。
   *
   * @权限 protected
   * @param input.imageUrl 图片 URL。**由 LLM 网关侧发起拉取**，因此必须是公网可达地址；
   *                       注意这构成 SSRF 面 —— 未校验域名白名单（见 observations）。
   * @param input.prompt   自定义分析指令；不传则用默认的日文"详细描述这张图"提示词。
   * @returns `{ success, analysis, imageUrl }`；LLM 无输出时 analysis 为固定文案「分析に失敗しました」。
   * @副作用 调用 LLM ×1（多模态视觉，按 token 计费）。**不写库**。
   * @throws "画像分析に失敗しました"（注意：原始错误只进日志，不透传给前端）
   */
  analyzeImage: protectedProcedure
    .input(
      z.object({
        imageUrl: z.string(),
        prompt: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const defaultPrompt =
          input.prompt ||
          "この画像について詳しく説明してください。含まれている人物、物、シーン、テキストなど、見えるすべてのものを分析してください。";

        // content parts 顺序：先图后文。多模态模型对"先给素材、再给指令"
        // 的顺序更稳定（指令在后不容易被长图 token 淹没）。
        // detail:"high" 走高分辨率通道，细节识别更准但 token 开销明显更高。
        // Heretic LLMで画像を分析
        const response = await invokeLLM({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: input.imageUrl,
                    detail: "high",
                  },
                },
                {
                  type: "text",
                  text: defaultPrompt,
                },
              ],
            },
          ],
        });

        const analysisResult =
          response.choices[0]?.message?.content || "分析に失敗しました";

        return {
          success: true,
          analysis: analysisResult,
          imageUrl: input.imageUrl,
        };
      } catch (error) {
        // 只抛通用文案、不带原始 error message：图片分析的底层错误可能包含
        // 网关地址或 API Key 片段，不适合直接暴露到前端。
        console.error("[Image Analysis] Error:", error);
        throw new Error("画像分析に失敗しました");
      }
    }),

  /**
   * ビデオをHeretic LLMで分析（フレーム抽出）
   *
   * ---
   * 用 LLM 分析视频内容。
   *
   * @权限 protected
   * @param input.videoUrl   视频 URL
   * @param input.prompt     自定义指令，默认为日文"详细描述这段视频"
   * @param input.frameCount 期望抽帧数，默认 3。
   *                         ⚠️ **当前实现完全没有使用这个参数**（见下方注释与 observations）。
   * @returns `{ success, analysis, videoUrl }`
   * @副作用 调用 LLM ×1。不写库。
   * @throws "ビデオ分析に失敗しました"
   */
  analyzeVideo: protectedProcedure
    .input(
      z.object({
        videoUrl: z.string(),
        prompt: z.string().optional(),
        frameCount: z.number().default(3),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const defaultPrompt =
          input.prompt ||
          "このビデオについて詳しく説明してください。ビデオの内容、登場人物、シーン、アクションなど、重要な要素をすべて分析してください。";

        // 注：実際のビデオフレーム抽出にはffmpegなどが必要
        // ここではビデオURLを直接Heretic LLMに渡す
        //
        // ---
        // 设计说明：真正的"抽帧后逐帧送图"需要在 Node 侧跑 ffmpeg
        // （项目里 ffmpeg 只存在于独立的 transcoder 容器，app 容器内没有），
        // 因此这里退化为把视频 URL 以 file_url 形式整个丢给 LLM 网关，
        // 由网关自行决定如何处理。副作用：入参 frameCount 形同虚设，
        // 且 mime_type 被硬编码成 "video/mp4" —— 传 webm/mkv 时声明会与实际不符。
        const response = await invokeLLM({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "file_url",
                  file_url: {
                    url: input.videoUrl,
                    mime_type: "video/mp4",
                  },
                },
                {
                  type: "text",
                  text: defaultPrompt,
                },
              ],
            },
          ],
        });

        const analysisResult =
          response.choices[0]?.message?.content || "分析に失敗しました";

        return {
          success: true,
          analysis: analysisResult,
          videoUrl: input.videoUrl,
        };
      } catch (error) {
        console.error("[Video Analysis] Error:", error);
        throw new Error("ビデオ分析に失敗しました");
      }
    }),

  /**
   * PDFテキスト抽出とLLM分析
   *
   * ---
   * 用 LLM 摘要 PDF 文档。实现上与 analyzeVideo 同构，
   * 只是把 file_url 的 mime_type 换成 "application/pdf"，
   * 文本抽取全部交给 LLM 网关完成（服务端不引入 pdf-parse 等依赖）。
   *
   * @权限 protected
   * @param input.pdfUrl PDF 文件 URL
   * @param input.prompt 自定义指令，默认为日文"总结这份文档的要点"
   * @returns `{ success, analysis, pdfUrl }`
   * @副作用 调用 LLM ×1。不写库。
   * @throws "PDF分析に失敗しました"
   *
   * 备注：本项目是视频平台，PDF 分析属于框架模板带来的通用能力，
   * 目前前端没有调用点，保留以备后台运营文档场景使用。
   */
  analyzePDF: protectedProcedure
    .input(
      z.object({
        pdfUrl: z.string(),
        prompt: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const defaultPrompt =
          input.prompt ||
          "このPDFドキュメントについて詳しく説明してください。主要な内容、重要なポイント、結論などを分析してください。";

        // PDFをHeretic LLMで分析
        const response = await invokeLLM({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "file_url",
                  file_url: {
                    url: input.pdfUrl,
                    mime_type: "application/pdf",
                  },
                },
                {
                  type: "text",
                  text: defaultPrompt,
                },
              ],
            },
          ],
        });

        const analysisResult =
          response.choices[0]?.message?.content || "分析に失敗しました";

        return {
          success: true,
          analysis: analysisResult,
          pdfUrl: input.pdfUrl,
        };
      } catch (error) {
        console.error("[PDF Analysis] Error:", error);
        throw new Error("PDF分析に失敗しました");
      }
    }),

  /**
   * ユーザーのアップロード履歴を取得
   *
   * ---
   * 分页读取**当前用户**的上传记录。
   *
   * @权限 protected（WHERE 条件直接锁定 ctx.user.id，无越权风险）
   * @param input.limit  每页条数，默认 20。⚠️ 未设服务端上限，客户端可传超大值。
   * @param input.offset 偏移量，默认 0
   * @returns `{ uploads, total }`
   *          - `uploads`：本页记录；
   *          - `total`：该用户的**总记录数**（不受 limit/offset 影响），
   *            前端可用 `Math.ceil(total / limit)` 直接算出总页数。
   * @副作用 只读（两条查询：一条取本页数据，一条 COUNT(*) 取总数）。
   *         数据库不可用时降级为空结果而非抛错。
   * @throws "アップロード履歴の取得に失敗しました"
   */
  getUploadHistory: protectedProcedure
    .input(
      z.object({
        limit: z.number().default(20),
        offset: z.number().default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const database = await getDb();
        if (!database) {
          return {
            uploads: [],
            total: 0,
          };
        }

        // ⚠️ orderBy 未包 desc()，Drizzle 默认按 **ASC** 排序，
        //    即返回的是最早的上传记录。"历史列表"通常期望最新在前，
        //    这与前端直觉相反（见 observations）。
        const uploads = await database
          .select()
          .from(userUploads)
          .where(eq(userUploads.userId, ctx.user.id))
          .orderBy(userUploads.createdAt)
          .limit(input.limit)
          .offset(input.offset);

        // 修复：原先 total 返回的是 uploads.length（本页条数），
        // 前端 Math.ceil(total / limit) 永远得到 1，分页控件失效。
        // 这里额外发一条 COUNT(*) 取该用户的真实总记录数。
        // Number() 是必须的：mysql2 会把 COUNT(*) 以字符串形式返回。
        const totalRows = await database
          .select({ count: sql<number>`count(*)` })
          .from(userUploads)
          .where(eq(userUploads.userId, ctx.user.id));

        return {
          uploads,
          total: Number(totalRows[0]?.count ?? 0),
        };
      } catch (error) {
        console.error("[Upload History] Error:", error);
        throw new Error("アップロード履歴の取得に失敗しました");
      }
    }),

  /**
   * アップロードされたファイルを削除
   *
   * ---
   * 删除一条上传记录（**仅删数据库行，不删 S3 对象**）。
   *
   * @权限 protected + 归属校验（uploadId 是全局自增主键，客户端可枚举，
   *       因此必须先查出记录核对 userId 才能删）
   * @param input.uploadId user_uploads 主键
   * @returns `{ success, message }`
   * @副作用 写库（删除一行）。**S3 上的实际文件会被保留成孤儿对象**（见 observations）。
   * @throws TRPCError(NOT_FOUND)  「アップロードが見つかりません」—— 记录不存在
   * @throws TRPCError(FORBIDDEN)  「このアップロードを削除する権限がありません」—— 记录不属于当前用户
   * @throws Error "アップロード削除に失敗しました" —— 仅用于数据库/未知故障；
   *         上面两种业务错误会原样抛出，前端可据 tRPC 错误码区分三种情况。
   */
  deleteUpload: protectedProcedure
    .input(
      z.object({
        uploadId: z.number(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const database = await getDb();
        if (!database) {
          throw new Error("データベース接続に失敗しました");
        }

        // 先按主键取出记录再核对归属（两步走）。
        // 更稳妥的写法是把 userId 并进 DELETE 的 WHERE 条件一步完成，
        // 既省一次查询也不存在查完到删完之间的竞态。
        // ユーザーが所有するアップロードのみ削除可能
        const upload = await database
          .select()
          .from(userUploads)
          .where(eq(userUploads.id, input.uploadId))
          .limit(1);

        // 修复：改用 TRPCError 并带上语义化错误码，且下方 catch 会原样放行，
        // 让前端能区分「记录不存在」(NOT_FOUND) 与「无权限」(FORBIDDEN)。
        if (!upload || upload.length === 0) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "アップロードが見つかりません",
          });
        }

        if (upload[0].userId !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "このアップロードを削除する権限がありません",
          });
        }

        // ⚠️ 只删数据库行，没有对应的 S3 删除调用（storage.ts 也未提供 storageDelete），
        //    因此 upload[0].s3Key 指向的对象会永久留在存储桶里占用容量。
        //    如需清理，目前只能靠桶的生命周期规则或离线脚本。
        // データベースから削除
        await database
          .delete(userUploads)
          .where(eq(userUploads.id, input.uploadId));

        return {
          success: true,
          message: "アップロードが削除されました",
        };
      } catch (error) {
        console.error("[Delete Upload] Error:", error);
        // 修复：原先无差别地把所有异常重写成同一句通用文案，
        // 「記録なし」「権限なし」「DB 故障」三种情况在前端完全无法区分。
        // 现在业务错误（TRPCError）原样向上抛，只有真正的未知/数据库故障才兜底。
        if (error instanceof TRPCError) {
          throw error;
        }
        throw new Error("アップロード削除に失敗しました");
      }
    }),
});
