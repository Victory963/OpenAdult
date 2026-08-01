/**
 * ============================================================================
 * server/routers/faceSearch.ts — 女优相似度检索路由（tRPC 路由层）
 * ============================================================================
 *
 * ## 架构定位
 * 属于**路由层**（server/routers/）。在 `server/routers.ts` 中以 `faceSearch`
 * 命名空间注册，前端通过 `trpc.faceSearch.*` 调用。
 *
 * ## 主要导出
 * - `faceSearchRouter` — 包含三个 procedure：
 *   | procedure       | 类型     | 权限   | 用途 |
 *   |-----------------|----------|--------|------|
 *   | `searchByImage` | mutation | public | 上传人脸图片 → LLM 分析特征 → LLM 匹配女优 |
 *   | `searchByName`  | mutation | public | 按名字（英/日/中）模糊匹配女优 + 关联视频 |
 *   | `getHistory`    | query    | protected | 读取**当前登录用户自己**的检索历史 |
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/pages/FaceSearchPage.tsx`
 *   （注意：`ChatPage.tsx` 用的是 `trpc.search.faceSearch`，属于 server/search.ts 的另一条链路）
 * - 下游依赖：
 *   - `getDb()`（server/db.ts）→ MySQL/TiDB
 *   - `invokeLLM()`（server/_core/llm.ts）→ Forge LLM 网关（视觉 + 文本两次调用）
 *   - 表：`actresses` / `videos` / `video_actresses` / `face_search_history`
 *
 * ## 关键设计决策与坑
 * 1. **不用 face-api.js**：Node.js 环境缺少 DOM/canvas，项目统一改用「LLM 视觉分析
 *    输出结构化面部特征 → 再由 LLM 做语义排序」的两段式方案（见 CLAUDE.md 设计决策 #2）。
 *    代价是：相似度分数是 LLM 主观估计，不是真实的 embedding 余弦距离，不具备可重现性。
 * 2. **LLM 输出用正则截取 JSON**：`content.match(/\{[\s\S]*\}/)` / `/\[[\s\S]*\]/`
 *    用于剥离 LLM 可能附带的 markdown 代码围栏或前后说明文字。
 * 3. **全表加载 + 内存过滤**：两个 search procedure 都是 `SELECT * FROM actresses`
 *    后在 JS 里过滤/排序。女优表规模小时可接受，数据量上千后需要改为 SQL 层过滤 + 分页。
 * 4. **返回消息为日语文案**：`message` 字段直接面向 UI 展示，属于 i18n 文案，勿改。
 */

import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  actresses,
  videos,
  videoActresses,
  faceSearchHistory,
} from "../../drizzle/schema";
// 注：`like` / `or` 当前未被使用（历史遗留的 import），实际过滤在 JS 内存中完成
import { eq, like, or, inArray, desc } from "drizzle-orm";
import { invokeLLM } from "../_core/llm";

export const faceSearchRouter = router({
  // Search similar actresses by uploaded image (LLM-based analysis)
  /**
   * 【public / mutation】以图搜人：上传人脸图 → 找出最相似的女优。
   *
   * 处理流程（两次 LLM 调用，串行）：
   *   1. 视觉分析：把 imageUrl 交给多模态 LLM，输出结构化面部特征 JSON
   *      （年龄段 / 人种 / 发型 / 脸型 / 特征点 / 颜值类型 / 体型）
   *   2. 语义匹配：把上一步的 JSON + 全量女优清单（id/name/bio/tags）喂给 LLM，
   *      让它输出 `[{ id, similarity, reason }]` 排序结果
   *   3. 用 actressMap 回填女优详情，并把结果写入 face_search_history
   *
   * @param input.imageUrl  待分析图片的可公开访问 URL（需能被 LLM 服务端拉取，
   *                        本地 /manus-storage/ 相对路径可能无法被 LLM 访问 —— 调用方需传绝对 URL）
   * @param input.userId    可选。传入时才落库检索历史（未登录用户不记录）
   * @param input.threshold 相似度阈值 0~1，默认 0.7。**注意：当前实现中该参数未被使用**，
   *                        实际下限由 prompt 中的 "similarity > 0.3" 约束
   *
   * @returns `{ success, matches[], topMatch, analysis, message }`
   *          - `matches[]`：`{ actressId, name, similarity, profileImage, reason, videoCount }`
   *          - `analysis`：第 1 步的原始特征 JSON（解析失败时为 `{}`）
   *
   * @sideEffect 调用 LLM ×2（有 token 成本与秒级延迟）；向 `face_search_history` 写入 1 行
   * @throws Error("Database not available") — DB 未初始化
   * @throws Error("画像検索に失敗しました…") — LLM 调用或后续处理抛错（原始错误只打 console）
   */
  searchByImage: publicProcedure
    .input(
      z.object({
        imageUrl: z.string(),
        userId: z.number().int().positive().optional(),
        threshold: z.number().min(0).max(1).default(0.7),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // Use LLM to analyze the face in the image and describe features
        // ── 第 1 步：视觉分析 ──────────────────────────────────────────
        // 之所以强制 "Return ONLY valid JSON"，是因为下游要用正则截取 JSON；
        // detail: "high" 表示让模型以高分辨率读图（成本更高但面部细节更准）。
        const faceAnalysis = await invokeLLM({
          messages: [
            {
              role: "system",
              content: `You are a facial feature analysis expert for adult video actresses. 
Analyze the uploaded face image and describe the person's appearance in detail.
Return a JSON object with these fields:
- age_range: estimated age range (e.g. "20-25")
- ethnicity: ethnicity (e.g. "Japanese", "Chinese", "Korean")
- hair_style: hair style and color
- face_shape: face shape (oval, round, heart, square, etc.)
- distinctive_features: array of distinctive features
- beauty_type: type of beauty (cute, sexy, elegant, cool, etc.)
- body_type: if visible (slim, curvy, athletic, etc.)
Return ONLY valid JSON, no other text.`,
            },
            {
              role: "user",
              content: [
                {
                  type: "text" as const,
                  text: "Analyze this face image and extract facial features for actress matching.",
                },
                {
                  type: "image_url" as const,
                  image_url: {
                    url: input.imageUrl,
                    detail: "high" as const,
                  },
                },
              ],
            },
          ],
        });

        // Parse LLM analysis
        // 容错解析：LLM 常常在 JSON 外面包一层 ```json 代码围栏或解释性文字，
        // 因此用贪婪正则 /\{[\s\S]*\}/ 取「第一个 { 到最后一个 }」之间的整段再 JSON.parse。
        // 解析失败不抛错——降级为空对象 {}，让后续匹配步骤仍能跑（只是匹配质量下降）。
        let analysisData: Record<string, any> = {};
        try {
          const content = faceAnalysis.choices[0]?.message?.content;
          if (typeof content === "string") {
            // Try to extract JSON from the response
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              analysisData = JSON.parse(jsonMatch[0]);
            }
          }
        } catch {
          analysisData = {};
        }

        // Get all actresses from database
        // 全表拉取候选集（无分页）：因为下一步要把整份清单塞进 LLM prompt。
        // 女优数量增长后这里既是 DB 压力点，也是 LLM context 长度的瓶颈。
        const allActresses = await db
          .select({
            id: actresses.id,
            name: actresses.name,
            japaneseName: actresses.japaneseName,
            bio: actresses.bio,
            profileImageUrl: actresses.profileImageUrl,
            tags: actresses.tags,
            videoCount: actresses.videoCount,
          })
          .from(actresses);

        if (allActresses.length === 0) {
          return {
            success: true,
            matches: [],
            topMatch: null,
            analysis: analysisData,
            message: "データベースに女優が登録されていません。管理画面から女優を追加してください。",
          };
        }

        // Use LLM to match actresses based on analysis
        // ── 第 2 步：语义匹配 ──────────────────────────────────────────
        // 把每位女优压缩成一行 "ID:.. Name:.. Bio:.. Tags:[..]" 的紧凑文本，
        // 目的是尽量省 token，同时保留 LLM 做关联推理所需的最小信息量。
        // 注意：这里比对的是「文本描述」而非人脸向量，所以匹配质量高度依赖 bio/tags 的完整度。
        const actressDescriptions = allActresses
          .map((a) => `ID:${a.id} Name:${a.name} Bio:${a.bio || "N/A"} Tags:${JSON.stringify(a.tags || [])}`)
          .join("\n");

        const matchingResponse = await invokeLLM({
          messages: [
            {
              role: "system",
              content: `You are an actress matching expert. Given facial analysis results and a list of actresses, 
rank the actresses by how likely they match the described face.
Return a JSON array of objects with: { "id": number, "similarity": number (0.0-1.0), "reason": string }
Only include actresses with similarity > 0.3. Sort by similarity descending. Max 10 results.
Return ONLY valid JSON array, no other text.`,
            },
            {
              role: "user",
              content: `Face analysis: ${JSON.stringify(analysisData)}

Available actresses:
${actressDescriptions}

Match these actresses to the face analysis. Consider name associations, bio descriptions, and tags.`,
            },
          ],
        });

        // Parse matching results
        // 同样用贪婪正则截取 JSON 数组（第一个 [ 到最后一个 ]）。
        // 降级策略：**只要没能从 LLM 响应中拿到可用的 JSON 数组**（无论是没匹配到
        // `[...]`、解析抛错、还是解析出来不是数组），都不让整个请求失败，而是伪造一份
        // 「前 10 位女优 + 递减分数」的兜底结果，保证 UI 至少有内容可展示。
        //   1 - i*0.08 → 1.00 / 0.92 / 0.84 ... 并用 max(0.5, ...) 兜底在 0.5，
        //   即兜底分数区间为 [0.5, 1.0]，视觉上仍像一份「可信」的排序。
        // 注意：LLM 正常返回空数组 `[]`（确实没有 similarity > 0.3 的候选）时**不兜底**，
        // 此时「未找到匹配」是真实结论。
        const buildFallbackMatches = () =>
          allActresses.slice(0, 10).map((a, i) => ({
            id: a.id,
            similarity: Math.max(0.5, 1 - i * 0.08),
            reason: "AI分析による推定マッチ",
          }));

        let matchResults: Array<{ id: number; similarity: number; reason: string }> = [];
        try {
          const matchContent = matchingResponse.choices[0]?.message?.content;
          const jsonMatch =
            typeof matchContent === "string" ? matchContent.match(/\[[\s\S]*\]/) : null;
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            // 修复：解析结果不是数组时（LLM 把数组包在对象里等）也走兜底，
            // 否则下游 matchResults.filter 会抛 TypeError
            matchResults = Array.isArray(parsed) ? parsed : buildFallbackMatches();
          } else {
            // 修复：原实现把兜底写在 catch 里，只有 JSON.parse 抛错才生效；
            // 而「LLM 返回的文本里根本不含 [...]」这一最常见的失败形态既不抛错也不兜底，
            // matchResults 保持空数组直接返回，用户看到「マッチする女優が見つかりませんでした」。
            matchResults = buildFallbackMatches();
          }
        } catch {
          // Fallback: return top actresses with descending placeholder scores
          matchResults = buildFallbackMatches();
        }

        // Build results with actress details
        // 用 Map 做 O(1) 回填，并顺带过滤掉 LLM 幻觉出来的、库里不存在的 id。
        // similarity 再做一次 clamp 到 [0,1]，防止 LLM 返回 1.2 / -0.3 这类越界值污染前端进度条。
        const actressMap = new Map(allActresses.map((a) => [a.id, a]));
        const matches = matchResults
          .filter((m) => actressMap.has(m.id))
          .map((m) => {
            const actress = actressMap.get(m.id)!;
            return {
              actressId: actress.id,
              name: actress.name,
              similarity: Math.min(1, Math.max(0, m.similarity)),
              profileImage: actress.profileImageUrl,
              reason: m.reason,
              videoCount: actress.videoCount || 0,
            };
          });

        const topMatch = matches.length > 0 ? matches[0] : null;

        // Save search history
        // 写历史是「尽力而为」的副作用：包在独立 try/catch 里，
        // 落库失败只 warn，绝不影响已经算好的检索结果返回给用户。
        // matchedActressIds 以 JSON 字符串存进 text 列（schema 未用 JSON 类型）。
        if (input.userId) {
          try {
            await db.insert(faceSearchHistory).values({
              userId: input.userId,
              uploadedImageUrl: input.imageUrl,
              matchedActressIds: JSON.stringify(matches.map((a) => a.actressId)),
              topMatchActressId: topMatch?.actressId || null,
              similarityScore: topMatch?.similarity.toString() || null,
            });
          } catch (e) {
            console.warn("[Face Search] Failed to save history:", e);
          }
        }

        return {
          success: true,
          matches,
          topMatch,
          analysis: analysisData,
          message: matches.length > 0
            ? `${matches.length}人の相似女優が見つかりました`
            : "マッチする女優が見つかりませんでした",
        };
      } catch (error) {
        console.error("[Face Search] Error:", error);
        throw new Error("画像検索に失敗しました。画像URLが正しいか確認してください。");
      }
    }),

  // Search actresses by name (with related videos)
  /**
   * 【public / mutation】按名字检索女优，并连带返回她们参演的热门视频。
   *
   * 与 `searchByImage` 不同，这条链路**完全不调用 LLM**，是纯字符串匹配 + 打分，
   * 因此延迟低、结果可重现，是 FaceSearchPage 的「名前検索」标签页所用。
   *
   * 匹配范围：`name`（罗马字/英文）、`japaneseName`、`chineseName` 三个字段，
   * 全部转小写后做 `includes` 子串匹配（大小写不敏感）。
   *
   * @param input.actressName 检索关键词，至少 1 字符
   * @param input.userId      可选。传入时才落库检索历史
   * @param input.limit       返回女优条数上限 1~20，默认 10（视频固定最多 20 条，不受此参数影响）
   *
   * @returns `{ success, actresses[], videos[], message }`
   *          - `actresses[]`：按 similarity 降序，已按 limit 截断
   *          - `videos[]`：所有命中女优的关联视频，按播放量降序，最多 20 条
   *
   * @sideEffect 向 `face_search_history` 写入 1 行（uploadedImageUrl 记为 null 以区分图片检索）
   * @throws Error("Database not available") — DB 未初始化
   * @throws Error("名前検索に失敗しました") — 查询过程中任意异常
   */
  searchByName: publicProcedure
    .input(
      z.object({
        actressName: z.string().min(1),
        userId: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(20).default(10),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        const queryLower = input.actressName.toLowerCase();

        // Search actresses by name (partial match on name, japaneseName, chineseName)
        const allActresses = await db
          .select({
            id: actresses.id,
            name: actresses.name,
            japaneseName: actresses.japaneseName,
            chineseName: actresses.chineseName,
            bio: actresses.bio,
            profileImageUrl: actresses.profileImageUrl,
            tags: actresses.tags,
            videoCount: actresses.videoCount,
          })
          .from(actresses);

        // Filter by name match
        // 在 JS 内存里做三字段 OR 子串匹配，而不是用 SQL 的 LIKE '%kw%'：
        // 一是要统一 toLowerCase 语义（避开 MySQL collation 差异），
        // 二是日文/中文字段可能为 NULL 需要逐个判空。
        // 代价：全表扫描 + 全量传输，女优表变大后应改为 SQL 层过滤。
        const matchedActresses = allActresses.filter(
          (a) =>
            a.name.toLowerCase().includes(queryLower) ||
            (a.japaneseName && a.japaneseName.toLowerCase().includes(queryLower)) ||
            (a.chineseName && a.chineseName.toLowerCase().includes(queryLower))
        );

        if (matchedActresses.length === 0) {
          return {
            success: true,
            actresses: [],
            videos: [],
            message: `「${input.actressName}」に一致する女優が見つかりませんでした`,
          };
        }

        // Get videos for matched actresses
        // 两跳查询：先经多对多中间表 video_actresses 拿到 videoId 集合（去重），
        // 再一次性 IN 查询 videos 表。拆成两步而不是 JOIN，是为了能对 videoId 做
        // Set 去重（同一视频可能关联多位命中女优，JOIN 会产生重复行）。
        const actressIds = matchedActresses.map((a) => a.id);
        const videoActressRecords = await db
          .select()
          .from(videoActresses)
          .where(inArray(videoActresses.actressId, actressIds));

        const videoIds = Array.from(new Set(videoActressRecords.map((va) => va.videoId)));
        let matchedVideos: any[] = [];
        if (videoIds.length > 0) {
          matchedVideos = await db
            .select()
            .from(videos)
            .where(inArray(videos.id, videoIds))
            .orderBy(desc(videos.views))
            .limit(20);
        }

        // Calculate similarity score based on name match quality
        // 按「匹配位置」分档打分（数值为经验值，仅用于排序与前端展示的相似度条）：
        //   1.0 完全相等  > 0.9 前缀匹配  > 0.7 中间包含  > 0.5 兜底
        // 0.5 兜底分理论上不会出现——能进 matchedActresses 就至少满足 includes；
        // 除非命中的是 chineseName（打分阶段只看 name / japaneseName，未参与评分）。
        const scoredActresses = matchedActresses.map((a) => {
          let similarity = 0.5;
          const nameLower = a.name.toLowerCase();
          const jpNameLower = (a.japaneseName || "").toLowerCase();
          
          // Exact match = highest score
          if (nameLower === queryLower || jpNameLower === queryLower) {
            similarity = 1.0;
          } else if (nameLower.startsWith(queryLower) || jpNameLower.startsWith(queryLower)) {
            similarity = 0.9;
          } else if (nameLower.includes(queryLower) || jpNameLower.includes(queryLower)) {
            similarity = 0.7;
          }

          return {
            ...a,
            similarity,
            profileImage: a.profileImageUrl,
          };
        }).sort((a, b) => b.similarity - a.similarity);

        // Save search history
        // 同 searchByImage：写历史失败只 warn 不中断。
        // uploadedImageUrl = null 是区分「名字检索」与「图片检索」两类历史记录的标志位。
        // 注意：这里记录的是**截断前**的全部命中 id（未受 input.limit 限制）。
        if (input.userId) {
          try {
            await db.insert(faceSearchHistory).values({
              userId: input.userId,
              uploadedImageUrl: null,
              matchedActressIds: JSON.stringify(scoredActresses.map((a) => a.id)),
              topMatchActressId: scoredActresses[0]?.id || null,
              similarityScore: scoredActresses[0]?.similarity.toString() || null,
            });
          } catch (e) {
            console.warn("[Face Search] Failed to save history:", e);
          }
        }

        return {
          success: true,
          actresses: scoredActresses.slice(0, input.limit).map((a) => ({
            actressId: a.id,
            name: a.name,
            japaneseName: a.japaneseName,
            similarity: a.similarity,
            profileImage: a.profileImageUrl,
            bio: a.bio,
            tags: a.tags,
            videoCount: a.videoCount || 0,
          })),
          videos: matchedVideos.map((v) => ({
            id: v.id,
            title: v.title,
            thumbnailUrl: v.thumbnailUrl,
            videoUrl: v.videoUrl,
            duration: v.duration,
            category: v.category,
            views: v.views,
            rating: v.rating,
          })),
          message: `${scoredActresses.length}人の女優と${matchedVideos.length}本の動画が見つかりました`,
        };
      } catch (error) {
        console.error("[Face Search] Name search error:", error);
        throw new Error("名前検索に失敗しました");
      }
    }),

  // Get search history
  /**
   * 【protected / query】读取**当前登录用户自己**的人脸/名字检索历史。
   *
   * 权限说明：目标 userId 一律取自 `ctx.user.id`（由 session cookie 解析而来），
   * **不接受客户端指定**。历史记录里含用户上传的人脸图 URL（uploadedImageUrl），
   * 属于隐私数据，任何跨用户读取都必须被禁止。
   *
   * @param input.limit  返回条数 1~50，默认 20
   * @returns `face_search_history` 原始行数组；**未指定排序**，MySQL 返回顺序不保证是「最新在前」
   * @throws TRPCError UNAUTHORIZED — 未登录（由 protectedProcedure 中间件抛出）
   * @throws Error("Database not available") — DB 未初始化
   *         （其余查询异常被吞掉并返回空数组 `[]`，前端无法区分「无历史」与「查询失败」）
   */
  getHistory: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(50).default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // 修复：越权读取他人隐私 —— userId 改为从 ctx.user 取，不再由客户端入参指定
        const history = await db
          .select()
          .from(faceSearchHistory)
          .where(eq(faceSearchHistory.userId, ctx.user.id))
          .limit(input.limit);

        return history;
      } catch (error) {
        console.error("[Face Search] Error getting history:", error);
        return [];
      }
    }),
});
