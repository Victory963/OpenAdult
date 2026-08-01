/**
 * ============================================================================
 * server/search.ts — 多模态搜索路由（以图搜片 / 人脸检索）
 * ============================================================================
 *
 * 架构层级：**API 路由层**。以 `search` 命名空间挂到根路由
 * （`server/routers.ts` 中的 `search: searchRouter`），前端调用形如
 * `trpc.search.imageSearch.useMutation()`。
 *
 * ## 主要导出
 * - `faceSearch`   —— 上传图片 → LLM 提取面部特征 → 匹配女优 → 返回其作品
 * - `imageSearch`  —— 上传图片 → LLM 提取场景/标签 → 按标签匹配视频
 * - `searchRouter` —— 把上面两个 procedure 聚合成子路由
 *
 * ## 上下游依赖
 * - 上游：`server/routers.ts`；前端 `client/src/pages/FaceSearchPage.tsx`、
 *   `SearchResultsPage.tsx`。图片需先经 `fileUpload.uploadFile` 传到 S3，
 *   拿到公开 URL 后才能传进来（入参是 URL 而非二进制，LLM 网关按 URL 拉取图片）。
 * - 下游：`./_core/llm`（invokeLLM 多模态调用）、`./db`（saveSearchHistory）、
 *   `../drizzle/schema`（actresses / videos / video_actresses）。
 *
 * ## 关键设计决策
 * 1. **不用 face-api.js**：Node 环境缺 DOM/canvas，项目改用 LLM 图像分析输出
 *    结构化的面部特征描述来做匹配（见 CLAUDE.md「关键设计决策 2」）。
 * 2. **两个 procedure 都是 mutation 而非 query**：虽然语义上是"搜索"，
 *    但它们有副作用（写 search_history）且入参较大，用 mutation 可绕过
 *    tRPC 的 GET 查询缓存与 URL 长度限制。
 * 3. **全部包 try/catch**：LLM 与 DB 都可能不可用，失败时统一抛出带前缀的
 *    日文错误信息，前端直接展示给用户。
 *
 * ## ⚠️ 与 `server/routers/faceSearch.ts` 的关系
 * 本文件的 `search.faceSearch` 走的是 **向量比对**路线：用 `extractFaceEmbedding`
 * 把查询图转成 14 维伪向量，与 `actress_face_embeddings` 表中管理面板导入的底库向量
 * 做余弦相似度比较。而 `faceSearch` 命名空间（`server/routers/faceSearch.ts`）走的是
 * **LLM 语义匹配**路线（把女优的 bio/tags 清单塞进 prompt 让模型排序）。
 * 两者互为补充：本路线要求底库已录入人脸图，命中更客观；那条路线无需底库但依赖文本质量。
 */
import { protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { getDb, saveSearchHistory } from "./db";
import { actresses, videos, videoActresses, actressFaceEmbeddings } from "../drizzle/schema";
import { invokeLLM } from "./_core/llm";
import {
  extractFaceEmbedding,
  calculateCosineSimilarity,
  parseEmbedding,
} from "./_core/faceRecognition";
import { eq, inArray, desc } from "drizzle-orm";

/**
 * 顔認識検索エンドポイント
 * アップロード画像から顔特徴を抽出し、女優の顔埋め込みと比較
 *
 * ---
 * 人脸检索 procedure：上传图片 → 抽取 14 维人脸伪向量 → 与 `actress_face_embeddings`
 * 底库做余弦相似度比对 → 取 Top 10 女优 → 返回她们的作品。
 *
 * 前置条件：底库需先由管理面板导入女优人脸图
 * （server/routers/actressManagement.ts 的 uploadActressFaceImage）。
 * 底库为空时本接口只会返回空结果 —— 这是刻意的，返回无关女优比返回空更糟。
 *
 * @权限 protected（需登录；因为要写 search_history 且会消耗 LLM 额度）
 * @param input.imageUrl  待检索图片的**公开可访问 URL**（须先上传到 S3）。
 *                        zod 的 `.url()` 只校验格式，不校验可达性 —— 无效 URL 会导致
 *                        特征抽取失败，走"抽取不到人脸特征"的降级分支。
 * @param input.threshold 余弦相似度下限，取值 0~1，默认 0.7。
 *                        ⚠️ 伪向量的分量全为正，任意两向量的余弦相似度通常已 >0.9，
 *                        因此 0.7 实际过滤力度很弱（见 server/_core/faceRecognition.ts 的说明），
 *                        调参需以实测分布为准。
 * @returns 成功路径返回 `{ success, actresses, videos, message }`；
 *          特征抽取失败/底库为空/查库失败三条降级路径返回
 *          `{ message, actresses: [], videos: [], analysis: {} }`（形状与成功路径不一致）。
 * @副作用 调用 LLM ×1（多模态视觉，由 extractFaceEmbedding 发起）；
 *         写库 ×1（search_history，searchType="face"；仅在走到打分之后的路径时写）
 * @throws `顔認識検索に失敗しました: <原因>` —— 任何环节异常都会被包装后重抛
 */
export const faceSearch = protectedProcedure
  .input(
    z.object({
      imageUrl: z.string().url(),
      threshold: z.number().min(0).max(1).default(0.7),
    })
  )
  .mutation(async ({ input, ctx }) => {
    try {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const userId = ctx.user!.id as number;

      // 修复：原实现先用 invokeLLM 取一段自由文本的面部描述，却在打分时把它整个丢弃，
      //       改用 `Math.random()` 生成 0.5~1.0 的伪造相似度（同一张图每次结果都不同，
      //       且与图片内容无关，那次 detail:"high" 的多模态调用纯属浪费）。
      //       现改为使用与底库入库时**同一个**特征抽取器，走真实的余弦相似度比对。
      //
      // extractFaceEmbedding 把人脸转成 14 维伪向量（取值 0~1）。
      // 管理面板导入女优人脸图时（server/routers/actressManagement.ts）用的也是这个函数，
      // 两侧共用同一套特征定义，向量之间才具备可比性。
      // 该函数全程吞异常：失败返回 null，因此这里必须显式判空。
      // Heretic LLMで顔特徴を抽出
      const queryEmbedding = await extractFaceEmbedding(input.imageUrl);
      if (!queryEmbedding) {
        console.warn("[Face Search] Failed to extract embedding from query image");
        return {
          message: "画像から顔特徴を抽出できませんでした",
          actresses: [],
          videos: [],
          analysis: {},
        };
      }

      // 读取女优人脸底库：actress_face_embeddings ⨝ actresses。
      // 只 SELECT 明确列出的列，而不是 `select().from(actresses)`：
      // 生产库与 drizzle/schema.ts 可能存在版本偏移（例如某些列尚未迁移上线），
      // 全列查询会因"Unknown column"整体报错。显式列清单可以把爆炸半径限制住。
      // 女優データを取得（存在するカラムのみ選択）
      let embeddingRows;
      try {
        // 存在するカラムのみを選択
        embeddingRows = await db
          .select({
            id: actresses.id,
            name: actresses.name,
            bio: actresses.bio,
            profileImageUrl: actresses.profileImageUrl,
            tags: actresses.tags,
            videoCount: actresses.videoCount,
            embedding: actressFaceEmbeddings.embedding,
          })
          .from(actressFaceEmbeddings)
          .innerJoin(actresses, eq(actressFaceEmbeddings.actressId, actresses.id));
      } catch (dbError) {
        // 表不存在 / 列缺失时降级为"没有可检索的数据"，而不是抛 500。
        // 这样新环境在女优库尚未初始化时，页面仍能正常渲染出空结果。
        // ⚠️ 该分支返回的对象形状与成功路径不同（缺 success、多 analysis），
        //    前端需要做兼容判断。
        console.error("[Face Search] Database error:", dbError);
        // テーブルが存在しない場合は空の結果を返す
        console.warn("[Face Search] No face embeddings found or table error");
        return {
          message: "検索対象の女優データが見つかりません",
          actresses: [],
          videos: [],
          analysis: {},
        };
      }

      // 底库为空（管理面板还没导入过任何女优人脸图）时同样降级为空结果。
      // 注意这与「有底库但都不够相似」是两回事，文案上刻意区分开，
      // 便于运营判断是"没录数据"还是"确实没匹配上"。
      if (!embeddingRows || embeddingRows.length === 0) {
        console.warn("[Face Search] No actress face embeddings in database");
        return {
          message: "検索対象の女優データが見つかりません",
          actresses: [],
          videos: [],
          analysis: {},
        };
      }

      // ===== 相似度打分（余弦相似度） =====
      // 一位女优可以录入多张人脸图（底库里就是多行），取其中**最高分**作为她的相似度，
      // 否则同一人会在结果里重复出现、并被低质量的那张图拉低排名。
      // 单行向量损坏（embedding 列不是合法 JSON）时跳过该行而不是整体失败 ——
      // 底库是批量导入的，个别脏数据不应让整次检索报错。
      // 顔特徴に基づいて女優をスコアリング
      const bestByActress = new Map<
        number,
        Omit<(typeof embeddingRows)[number], "embedding"> & { similarity: number }
      >();
      for (const row of embeddingRows) {
        const { embedding, ...actress } = row;
        let similarity: number;
        try {
          similarity = calculateCosineSimilarity(queryEmbedding, parseEmbedding(embedding));
        } catch {
          console.warn(`[Face Search] Broken embedding for actress ${row.id}, skipped`);
          continue;
        }
        const prev = bestByActress.get(row.id);
        if (!prev || similarity > prev.similarity) {
          bestByActress.set(row.id, { ...actress, similarity });
        }
      }

      const scoredActresses = Array.from(bestByActress.values())
        // 先按阈值过滤 → 再降序 → 截断 Top 10。
        // 顺序不可调换：先 slice 再 filter 会丢掉本该入选的高分项。
        // 10 是人脸检索结果页一屏能展示的数量上限。
        .filter((actress) => actress.similarity >= input.threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 10);

      // 无匹配的提前返回分支：仍然记一条搜索历史（resultsCount=0），
      // 用于后续统计"哪些人脸搜不到结果"以评估召回质量。
      // ⚠️ 但这里 query 存的是空对象 `{}`，把 imageUrl 丢掉了，
      //    与下方成功路径存 `{imageUrl}` 不一致，导致这类记录无法回溯。
      // マッチした女優の動画を取得
      if (scoredActresses.length === 0) {
        await saveSearchHistory(
          userId,
          JSON.stringify({}),
          "face",
          0
        );
        return {
          success: true,
          actresses: [],
          videos: [],
          message: "マッチする女優が見つかりませんでした",
        };
      }

      // 两段式查库（而非一次 JOIN）：
      //   1) 从关联表 video_actresses 取出这些女优参演的 videoId 集合；
      //   2) 再按 videoId 批量取视频详情，并按播放量降序取前 20。
      // 拆开写的好处是第 2 步能独立地排序 + 限流；代价是多一次往返。
      // 注意：`inArray(..., [])` 在 Drizzle 中会生成非法 SQL，所以第 2 步用
      // `videoIds.length > 0` 做了守卫；第 1 步无需守卫是因为 actressIds 必非空
      // （上面的提前返回已排除空集）。
      const actressIds = scoredActresses.map((a) => a.id);
      const matchedVideoActresses = await db
        .select()
        .from(videoActresses)
        .where(inArray(videoActresses.actressId, actressIds));

      const videoIds = matchedVideoActresses.map((va) => va.videoId);
      const matchedVideos =
        videoIds.length > 0
          ? await db
              .select()
              .from(videos)
              .where(inArray(videos.id, videoIds))
              .orderBy(desc(videos.views))
              .limit(20)
          : [];

      // 记录搜索历史。face/image 类型的 query 字段存的是 JSON 字符串而非自然语言，
      // 因此 analyzeUserPreferences() 的关键词统计对这类记录基本无效 —— 这是有意为之，
      // 图片搜索的意图不适合当关键词用。
      // 検索履歴を保存
      await saveSearchHistory(
        userId,
        JSON.stringify({ imageUrl: input.imageUrl }),
        "face",
        matchedVideos.length
      );

      return {
        success: true,
        actresses: scoredActresses,
        videos: matchedVideos,
        message: `${scoredActresses.length}人の女優と${matchedVideos.length}本の動画が見つかりました`,
      };
    } catch (error) {
      // 统一错误出口：非 Error 类型（如字符串、网关返回的对象）也要能取到可读信息，
      // 否则日志里只会留下 "[object Object]"。
      // 包装后重抛而非静默降级 —— 人脸搜索是用户主动发起的核心动作，失败必须让用户知道。
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Face Search] Error:", errorMessage);
      throw new Error(`顔認識検索に失敗しました: ${errorMessage}`);
    }
  });

/**
 * 画像ベース検索エンドポイント
 * アップロード画像の内容をHeretic LLMで分析し、タグやカテゴリで動画を検索
 *
 * ---
 * 以图搜片 procedure：上传图片 → LLM 打标签 → 用标签去匹配视频。
 *
 * 与 `faceSearch` 的区别：faceSearch 关心"**是谁**"（人物身份），
 * 本 procedure 关心"**是什么内容**"（场景、动作、道具、着装）。
 *
 * @权限 protected
 * @param input.imageUrl 图片的公开 URL（须先经 fileUpload 上传到 S3）
 * @returns `{ success, analysis, videos, message }`
 *          - `analysis`：LLM 输出的结构化标签对象；解析失败时为 `{}`
 *          - `videos`：命中的视频，按播放量降序，最多 20 条
 * @副作用 调用 LLM ×1（多模态视觉）；写库 ×1（search_history，searchType="image"）
 * @throws `画像検索に失敗しました: <原因>`
 */
export const imageSearch = protectedProcedure
  .input(
    z.object({
      imageUrl: z.string().url(),
    })
  )
  .mutation(async ({ input, ctx }) => {
    try {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const userId = ctx.user!.id as number;

      // 让 LLM 输出结构化标签（场景类型/动作/体位/道具/服装/环境/tags）。
      // 用的是 Heretic 系模型（HERETIC_LLM_MODEL）—— 通用商业模型会因内容政策拒答，
      // 这也是本项目坚持自建 LLM 网关的直接原因。
      // 同样要求 "Return ONLY valid JSON"，配合下面的宽容解析。
      // Heretic LLMで画像内容を分析
      const imageAnalysis = await invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "You are an adult content analyzer. Analyze the uploaded image and extract: scene_type, activities, positions, props, clothing, setting, tags. Return ONLY valid JSON.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Analyze this image for adult content classification and tagging.",
              },
              {
                type: "image_url",
                image_url: {
                  url: input.imageUrl,
                  detail: "high",
                },
              },
            ],
          },
        ],
      });

      // 宽容解析 LLM 输出：即便 prompt 明确要求纯 JSON，模型仍可能返回
      // Markdown 代码块包裹、多余说明文字，或多模态 content 数组。
      // 任何一种情况都退化成空对象 `{}`，让流程继续走到"没有标签 → 无匹配结果"，
      // 而不是把整个请求打成 500。
      // 分析結果を解析
      let analysisData: Record<string, unknown> = {};
      try {
        const content = imageAnalysis.choices[0].message.content;
        if (typeof content === "string") {
          analysisData = JSON.parse(content);
        } else {
          analysisData = {};
        }
      } catch {
        analysisData = {};
      }

      // `analysisData.tags` 的类型无法在编译期保证（来自 LLM 的自由输出），
      // 这里的 as 断言属于乐观转换；若模型返回的 tags 不是字符串数组，
      // 下面的 `.toLowerCase()` 会抛错并被外层 catch 兜住。
      // タグに基づいて動画を検索
      const tags = (analysisData.tags as string[]) || [];
      let matchedVideos: (typeof videos.$inferSelect)[] = [];

      // 没抽出任何标签就完全跳过查库 —— 空标签集匹配不到东西，白跑一趟。
      if (tags.length > 0) {
        let allVideos: (typeof videos.$inferSelect)[] = [];
        try {
          // 同 recommendations.generate：候选集硬截断到 100 条在内存里过滤。
          // 因为标签匹配是"子串包含"语义，SQL 层没有可用索引，只能全量拉取；
          // 100 是防止 OOM 的保守上限，也意味着**只有最先入库的 100 条视频可被搜到**。
          allVideos = await db.select().from(videos).limit(100);
        } catch (dbError) {
          // 查库失败降级为空候选集：最终返回"0 条结果"而非报错
          console.error("[Image Search] Database error:", dbError);
          allVideos = [];
        }

        // 标签匹配规则：LLM 标签只要是视频某个标签的**子串**即算命中
        // （例如 LLM 给 "school"，视频标签 "schoolgirl" 也算匹配）。
        // 这是刻意放宽的模糊匹配 —— LLM 的用词粒度与人工标注不一致，
        // 精确相等会导致召回率极低。代价是可能出现误命中。
        // 双重 toLowerCase 用于消除大小写差异。
        matchedVideos = allVideos
          .filter((video) => {
            const videoTags = (video.tags as string[]) || [];
            const matchCount = tags.filter((tag: string) =>
              videoTags.some((vt: string) =>
                vt.toLowerCase().includes(tag.toLowerCase())
              )
            ).length;
            // 只要命中一个标签就入选（matchCount 未参与排序，
            // 也就是说命中 5 个标签的片子并不比命中 1 个的排更前）
            return matchCount > 0;
          })
          // 排序依据是播放量而非匹配度；`?? 0` 兜住 views 为 NULL 的旧数据
          .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
          .slice(0, 20);
      }

      // 历史里连 tags 一起存：便于事后分析"LLM 打了哪些标签却搜不到片"，
      // 是补标签库的重要数据来源。
      // 検索履歴を保存
      await saveSearchHistory(
        userId,
        JSON.stringify({ imageUrl: input.imageUrl, tags }),
        "image",
        matchedVideos.length
      );

      return {
        success: true,
        analysis: analysisData,
        videos: matchedVideos,
        message: `${matchedVideos.length}本の関連動画が見つかりました`,
      };
    } catch (error) {
      // 与 faceSearch 一致的统一错误出口，详见上文说明
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Image Search] Error:", errorMessage);
      throw new Error(`画像検索に失敗しました: ${errorMessage}`);
    }
  });

/**
 * 多模态搜索子路由。挂载点见 `server/routers.ts` 的 `search: searchRouter`。
 *
 * 前端调用路径：
 *   - `trpc.search.faceSearch.useMutation()`
 *   - `trpc.search.imageSearch.useMutation()`
 *
 * ⚠️ 别与根路由上的 `faceSearch` 命名空间（`server/routers/faceSearch.ts`）混淆：
 * 那个是女优相似度检索的完整实现，本文件的 `search.faceSearch` 是早期占位版本。
 */
export const searchRouter = router({
  faceSearch,
  imageSearch,
});
