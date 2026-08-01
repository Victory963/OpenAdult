/**
 * ============================================================================
 * server/routers.ts — tRPC 根路由（appRouter）注册总入口
 * ============================================================================
 *
 * 架构层级：**API 路由层（后端最外层）**。
 * 这是整个后端唯一的 tRPC 根路由聚合点，Express 在 `server/_core/index.ts`
 * 中把它挂载到 `/api/trpc/*`。前端 `client/src/lib/trpc.ts` 通过
 * `AppRouter` 类型获得端到端类型推导，因此**本文件的形状即前端可见的 API 契约**。
 *
 * ## 主要导出
 * - `appRouter`  —— 根路由。由两部分组成：
 *     1. 从 `server/routers/*`、`server/search.ts`、`server/file-upload.ts`
 *        导入的**子路由模块**（videos / actressManagement / hlsStream / ...）；
 *     2. 直接在本文件内联定义的**通用业务路由**：
 *        `auth`、`chat`、`favorites`、`resumePlayback`、`recommendations`、
 *        `actresses`、`userPreferences`、`searchHistory`、`language`。
 * - `AppRouter`  —— `typeof appRouter`，供前端 tRPC 客户端做类型推导（仅类型，无运行时开销）。
 * - `default`    —— 同 `appRouter`。
 *
 * ## 上下游依赖
 * - 上游调用方：`server/_core/index.ts`（Express 挂载）、`client/src/lib/trpc.ts`（类型）。
 * - 下游依赖：
 *     - `./db`              —— 所有数据库读写助手（项目约定：路由层不直接写 SQL，
 *                              但本文件的 `actresses.search` / `searchHistory.*` /
 *                              `recommendations.generate` 存在少量直接 Drizzle 查询，属历史遗留）。
 *     - `./_core/llm`       —— `invokeLLM()`，聊天与推荐调用 LLM。
 *     - `./llm-prompts`     —— 提示词模板构造函数。
 *     - `./_core/trpc`      —— `publicProcedure` / `protectedProcedure` / `router`。
 *     - `./_core/cookies`   —— 登出时清除 session cookie 所需的同源/同站选项。
 *
 * ## 权限级别约定
 * - `publicProcedure`    ：无需登录（`auth.me`、`actresses.*`）。
 * - `protectedProcedure` ：需要登录，`ctx.user` 必定存在（故代码中大量使用 `ctx.user!`）。
 * - `adminProcedure`     ：本文件未直接使用，管理端能力下沉在各子路由中。
 *
 * ## 关键设计决策 / 坑
 * - **双版本路由并存**：`videos` / `videosV2`、`actressManagement` / `actressManagementV2`、
 *   `videoUpload` / `videoUploadV2`。V2 为增强版，V1 保留仅为向后兼容，新功能一律进 V2。
 * - **序列化器**：全局使用 `superjson`，因此 `Date`、`Map` 等类型可直接跨端传输。
 * - **数据库可能不可用**：`getDb()` 返回 `null` 时（未配置 DATABASE_URL 或连接失败），
 *   各 procedure 的处理策略不统一 —— 查询类多半返回空数组降级，写入类则抛错。
 */
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure } from "./_core/trpc";
import { z } from "zod";
// 注：以下 import 中的 getVideoById / getActressesByVideo / trackWatchBehavior 目前无引用点，
// 属早期版本残留（同理 drizzle-orm 的 like/or、schema 的 recommendations、
// llm-prompts 的 buildSearchAnalysisPrompt）。保留不影响运行，但会被 tree-shaking 前的
// 静态检查标记为死引用 —— 清理需另开改动，不在注释任务范围内。
import { getDb, saveChatMessage, getChatHistory, saveSearchHistory, getSearchHistory, addFavorite, removeFavorite, getUserFavorites, updateResumePlayback, getResumePlayback, getUserPreferences, updateUserPreferences, getRecommendations, saveRecommendation, getVideoById, getActressById, getActressesByVideo, getUserWatchHistory, clearUserRecommendations, trackWatchBehavior, calculateRecommendationScore, analyzeUserPreferences, getRelevantVideosForChat, getRelevantActressesForChat } from "./db";
import { searchHistory, videos, recommendations, actresses, videoActresses } from "../drizzle/schema";
import { eq, sql, like, or, inArray } from "drizzle-orm";
import { invokeLLM } from "./_core/llm";
import { buildChatSystemPrompt, buildSearchAnalysisPrompt, buildRecommendationPrompt } from "./llm-prompts";
import { fileUploadRouter } from "./file-upload";
import { searchRouter } from "./search";
import { faceSearchRouter } from "./routers/faceSearch";
import { actressManagementRouter } from "./routers/actressManagement";
import { videosRouter } from "./routers/videos";
import { videoUploadRouter } from "./routers/video-upload";
import { videoUploadV2Router } from "./routers/video-upload-v2";
import { actressManagementV2Router } from "./routers/actress-management-v2";
import { videosV2Router } from "./routers/videos-v2";
import { adminAuthRouter } from "./routers/admin-auth";
import { hlsStreamRouter } from "./routers/hls-stream";
import { adManagementRouter } from "./routers/ad-management";

/**
 * tRPC 根路由。命名空间即前端调用路径：
 * 例如 `trpc.videosV2.list.useQuery()` 对应下面的 `videosV2` → `videos-v2.ts` 的 `list`。
 *
 * 注意：这里的 key 一旦改名，所有前端调用点都会编译失败（这正是 tRPC 的价值所在），
 * 因此新增子路由请追加，不要重命名已有 key。
 */
export const appRouter = router({
  // ===== 子路由模块（实现分散在 server/routers/ 与同级文件） =====
  system: systemRouter,                             // 框架内置：健康检查、版本、心跳等
  fileUpload: fileUploadRouter,                     // 通用文件上传 + LLM 多模态分析（./file-upload.ts）
  search: searchRouter,                             // 以图搜片 / 人脸检索（./search.ts）
  faceSearch: faceSearchRouter,                     // 女优相似度检索（按名称/图像，含 embedding 管理）
  actressManagement: actressManagementRouter,       // 女优管理 V1（向后兼容，勿加新功能）
  videos: videosRouter,                             // 视频 CRUD V1（向后兼容）
  videoUpload: videoUploadRouter,                   // 视频上传 V1（单次上传）
  videoUploadV2: videoUploadV2Router,               // 视频上传 V2（分片上传 + 会话状态机）
  actressManagementV2: actressManagementV2Router,   // 女优管理 V2（增强版，新功能入口）
  videosV2: videosV2Router,                         // 视频 CRUD V2（增强版，支持分类筛选）
  adminAuth: adminAuthRouter,                       // 管理面板独立密码认证（与 OAuth 并行的第二套认证）
  hlsStream: hlsStreamRouter,                       // HLS 流管理（pseudo / real 两种模式）
  adManagement: adManagementRouter,                 // 广告素材与投放位管理（配合 OpenResty SSAI 拼接）

  /**
   * 认证路由。
   * 说明：登录动作本身不走 tRPC，而是走 `server/_core/oauth.ts` 注册的
   * `/api/oauth/*` REST 回调（Manus OAuth），此处只负责「读当前用户」和「登出」。
   */
  auth: router({
    /**
     * 读取当前登录用户。
     * @权限 public —— 未登录时 `ctx.user` 为 `null`/`undefined`，前端据此判断登录态。
     * @returns 由 `server/_core/context.ts` 从 JWT Cookie 解析出的用户对象，或空值。
     * @副作用 无
     */
    me: publicProcedure.query(opts => opts.ctx.user),

    /**
     * 登出：清除会话 Cookie。
     * @权限 public —— 未登录调用也安全（清除不存在的 Cookie 是幂等操作）。
     * @副作用 写响应头 Set-Cookie，清除 `COOKIE_NAME`。
     *
     * 关键点：`clearCookie` 必须携带与**写入时完全一致**的 domain/path/sameSite/secure，
     * 否则浏览器会认为是另一个 Cookie 而不予删除 —— 所以这里复用
     * `getSessionCookieOptions(ctx.req)`（它会根据请求来源推导正确的域配置）。
     * 额外的 `maxAge: -1` 是双保险：即使某些代理吞掉了 `Expires`，负的 max-age 也能立即过期。
     */
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // Chat Router - Heretic LLM integration
  /**
   * AI 聊天推荐路由。
   * 对应前端 `client/src/pages/ChatPage.tsx` + `components/AIChatBox.tsx`。
   *
   * 设计要点：这不是纯粹的闲聊机器人，而是「**带检索增强（RAG）的推荐对话**」——
   * 每轮对话都会先从数据库捞出与用户输入相关的视频/女优，塞进 system prompt 作为上下文，
   * 让 LLM 在**真实存在的库存**范围内作答，避免凭空编造不存在的片名。
   */
  chat: router({
    /**
     * 发送一条聊天消息并获取 AI 回复 + 关联推荐内容。
     *
     * @权限 protected（需登录）
     * @param input.content 用户输入文本，至少 1 个字符。
     * @returns `{ message, videos, actresses }`
     *          - `message`：LLM 生成的回复文本；
     *          - `videos` / `actresses`：本轮检索到的相关内容（**精简字段后**返回，
     *            避免把整行数据库记录暴露给前端）。
     * @副作用 写库 ×3（chat_messages 存用户消息、存助手回复、search_history 存查询）+ 调用 LLM ×1
     * @throws "Database not available" —— `getDb()` 返回 null 时。
     */
    sendMessage: protectedProcedure
      .input(z.object({
        content: z.string().min(1),
      }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const userId = ctx.user!.id as number;
        // 语言决定 system prompt 的语种；用户对象上没有 language 字段时兜底为日语（ja）——
        // 因为本站主要受众是日语用户，日语是产品默认语言。
        const userLanguage = (ctx.user!.language as "ja" | "zh" | "en") || "ja";

        // 先落库再调 LLM：即使后续 LLM 调用失败/超时，用户说过的话也不会丢
        // Save user message
        await saveChatMessage(userId, "user", input.content);

        // 取最近 10 条历史作为对话上下文。
        // 10 是成本与连贯性的折中：更多轮次会线性推高 token 成本，而推荐类对话
        // 通常只需要最近几轮的意图即可。
        // 注意 getChatHistory 按 createdAt DESC 返回（最新在前）。
        // Get chat history for context
        const history = await getChatHistory(userId, 10);

        // 修复：getChatHistory 返回的是「最新在前」的倒序，必须翻转成正序（旧 → 新）
        // 才能作为 LLM 的对话上下文，否则模型看到的是逆序对话，多轮连贯性会退化。
        // （对照 chat.getHistory 的 `messages.reverse()`，那里也是同样的原因。）
        const orderedHistory = [...history].reverse();

        // 修复：本轮用户消息在上面已经 saveChatMessage 落库，因此它**必然**是
        // orderedHistory 的最后一条；若再无条件追加一次，模型会看到重复提问。
        // 这里只在历史末尾不是本轮消息时才补追加（防御 saveChatMessage 静默失败的情况）。
        const lastHistoryMsg = orderedHistory[orderedHistory.length - 1];
        const historyHasCurrentMessage =
          lastHistoryMsg?.role === "user" && lastHistoryMsg.content === input.content;

        // 三路并发检索，构成 RAG 上下文：
        //   1. 用户长期偏好（来自搜索历史聚合的关键词/分类频次）
        //   2. 与本次输入相关的视频（最多 10 条）
        //   3. 与本次输入相关的女优（最多 5 条）
        // 用 Promise.all 而非串行，是因为三者互不依赖，串行会把聊天延迟叠加三倍。
        // Analyze user preferences and get relevant content
        const [userPrefs, relevantVideos, relevantActresses] = await Promise.all([
          analyzeUserPreferences(userId),
          getRelevantVideosForChat(userId, input.content, 10),
          getRelevantActressesForChat(input.content, 5),
        ]);

        // Build user preference context for LLM
        const userContext = {
          ...userPrefs,
          relevantVideos,
          relevantActresses,
        };

        // 组装 LLM 消息数组：system（人设 + RAG 上下文） → 历史消息（正序，已含本轮输入）。
        // buildChatSystemPrompt 会把 userContext 序列化进 system prompt，
        // 让模型只在给定的视频/女优候选集中做推荐。
        // Build messages for LLM with user context
        const messages = [
          {
            role: "system" as const,
            content: buildChatSystemPrompt(userLanguage, userContext),
          },
          ...orderedHistory.map(msg => ({
            role: msg.role as "user" | "assistant",
            content: msg.content,
          })),
          // 仅在历史里没拿到本轮消息时才补上，避免重复提问
          ...(historyHasCurrentMessage
            ? []
            : [
                {
                  role: "user" as const,
                  content: input.content,
                },
              ]),
        ];

        // Invoke Heretic LLM
        const response = await invokeLLM({
          messages,
        });

        // LLM 返回的 content 在多模态场景下可能是数组（content parts）而非纯字符串，
        // 这里统一归一化成字符串再落库，避免 chat_messages.content 存进 "[object Object]"。
        const assistantContent = response.choices[0]?.message?.content;
        const assistantMessage = typeof assistantContent === 'string' ? assistantContent : JSON.stringify(assistantContent) || "";

        // Save assistant message
        if (assistantMessage) {
          await saveChatMessage(userId, "assistant", assistantMessage);
        }

        // 把聊天内容也当成一次 "text" 搜索记入 search_history：
        // analyzeUserPreferences() 只读 search_history 来提取长期偏好，
        // 因此聊天意图必须回流到这张表，才能在后续对话/推荐中生效（resultsCount 记 0 无实际语义）。
        // Also save this search query to search_history for future preference analysis
        await saveSearchHistory(userId, input.content, "text", 0);

        // 只回传前端渲染卡片所需的字段，避免泄露内部列（如 S3 key、审核状态等）
        return {
          message: assistantMessage,
          videos: relevantVideos.map(v => ({ id: v.id, title: v.title, thumbnailUrl: v.thumbnailUrl, category: v.category, rating: v.rating })),
          actresses: relevantActresses.map(a => ({ id: a.id, name: a.name, profileImage: a.profileImageUrl })),
        };
      }),

    /**
     * 拉取聊天历史（用于页面初次加载时回填对话）。
     *
     * @权限 protected
     * @param input.limit 期望条数，默认 50。
     * @returns 按时间**正序**（旧 → 新）排列的消息数组，可直接自上而下渲染。
     * @副作用 只读
     * @throws "Database not available"
     */
    getHistory: protectedProcedure
      .input(z.object({
        limit: z.number().default(50),
      }))
      .query(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const userId = ctx.user!.id as number;
        // 服务端硬上限 200：input.limit 来自客户端，不设上限会让人构造
        // `limit: 1e9` 拖垮数据库和响应体（zod 只校验类型不校验业务范围）。
        const limit = Math.min(input.limit, 200);
        const messages = await getChatHistory(userId, limit);

        // getChatHistory 是 DESC（取"最近 N 条"必须倒序 + LIMIT），
        // 但 UI 需要正序展示，所以在这里翻转回来。
        return messages.reverse();
      }),
  }),

  // Note: search router is now imported from ./search and merged at the top

  // Favorites Router
  /**
   * 收藏路由。所有操作以 `ctx.user.id` 为准，**不接受客户端传入 userId**，
   * 这是防越权的关键约定（下面 resumePlayback / userPreferences 同理）。
   */
  favorites: router({
    /**
     * 添加收藏。
     * @权限 protected
     * @param input.videoId 视频 ID
     * @副作用 写库（favorites 表；重复收藏由 db 层做幂等处理）
     */
    add: protectedProcedure
      .input(z.object({
        videoId: z.number(),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user!.id as number;
        await addFavorite(userId, input.videoId);
        return { success: true };
      }),

    /**
     * 取消收藏。
     * @权限 protected
     * @副作用 写库（按 userId + videoId 删除，因此不存在越权删他人收藏的风险）
     */
    remove: protectedProcedure
      .input(z.object({
        videoId: z.number(),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user!.id as number;
        await removeFavorite(userId, input.videoId);
        return { success: true };
      }),

    /**
     * 列出当前用户的收藏（已 JOIN 视频信息，可直接渲染卡片）。
     * @权限 protected
     * @param input.limit 条数上限，默认 50
     * @副作用 只读
     */
    list: protectedProcedure
      .input(z.object({
        limit: z.number().default(50),
      }))
      .query(async ({ input, ctx }) => {
        const userId = ctx.user!.id as number;
        return await getUserFavorites(userId, input.limit);
      }),
  }),

  // Resume Playback Router
  /**
   * 续播进度路由。
   * 由 `client/src/components/VideoPlayer.tsx` 在播放过程中定时上报，
   * 并在视频详情页加载时读取，实现「上次看到哪里」。
   */
  resumePlayback: router({
    /**
     * 上报/更新播放进度（upsert 语义）。
     * @权限 protected
     * @param input.videoId  视频 ID
     * @param input.position 当前播放位置（秒）
     * @param input.duration 视频总时长（秒）。一并存储是为了让前端能算出百分比进度条，
     *                       并让 db 层判断「是否已看完」（接近 duration 时不再提示续播）。
     * @副作用 写库（resume_playback 表，按 userId+videoId upsert）
     */
    update: protectedProcedure
      .input(z.object({
        videoId: z.number(),
        position: z.number(),
        duration: z.number(),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user!.id as number;
        await updateResumePlayback(userId, input.videoId, input.position, input.duration);
        return { success: true };
      }),

    /**
     * 读取指定视频的续播进度。
     * @权限 protected
     * @returns 进度记录；从未观看过则为 undefined/null（前端应从 0 开始播放）
     * @副作用 只读
     */
    get: protectedProcedure
      .input(z.object({
        videoId: z.number(),
      }))
      .query(async ({ input, ctx }) => {
        const userId = ctx.user!.id as number;
        return await getResumePlayback(userId, input.videoId);
      }),
  }),

  // Recommendations Router
  /**
   * 推荐路由。采用「**预计算 + 读缓存**」模式：
   * `generate` 负责跑打分流水线并把结果写入 recommendations 表，
   * `list` 只是把预计算结果读出来。这样首页/仪表盘的读取路径永远是一次简单查询，
   * 不会因为 LLM 慢而卡住页面渲染。
   */
  recommendations: router({
    /**
     * 读取已生成的推荐列表。
     * @权限 protected
     * @param input.limit 条数，默认 20
     * @returns 推荐记录（含推荐理由 reason 与得分 score），从未生成过则为空数组
     * @副作用 只读（不会触发生成）
     */
    list: protectedProcedure
      .input(z.object({
        limit: z.number().default(20),
      }))
      .query(async ({ input, ctx }) => {
        const userId = ctx.user!.id as number;
        return await getRecommendations(userId, input.limit);
      }),

    /**
     * 重新生成当前用户的推荐（全量覆盖）。
     *
     * @权限 protected
     * @input 无
     * @returns `{ success, recommendedCount, message }`
     *          —— 失败时不抛异常，而是返回 `success:false`（见下方 catch 说明）。
     * @副作用 调用 LLM ×1；删除该用户全部旧推荐；批量写入最多 20 条新推荐。
     *
     * ## 流水线
     *   1. 采集信号：最近 10 条观看历史 + 最近 10 条搜索历史 + 用户偏好设置
     *   2. 交给 LLM 生成一段**面向用户展示的文案**（注意：LLM 输出并不参与实际排序）
     *   3. 清空旧推荐 → 对候选视频做**本地加权打分** → 取 Top 20 落库
     *
     * ## 重要设计取舍
     *   真正决定排序的是本地打分公式（`calculateRecommendationScore`），
     *   LLM 只贡献 `message` 文案。这样做的好处是排序结果确定、可解释、不受模型漂移影响；
     *   代价是 LLM 调用的性价比很低（详见 observations）。
     */
    generate: protectedProcedure
      .mutation(async ({ ctx }) => {
        // 整个流程包在 try/catch 里并返回 success:false 而非抛错：
        // 推荐属于"锦上添花"功能，生成失败不应该让仪表盘页面整体报错，
        // 前端只需静默保留上一批推荐即可。
        try {
          const userId = ctx.user!.id as number;
          const db = await getDb();
          if (!db) throw new Error("Database not available");
  
          // 采集三类偏好信号。10 条是"近期兴趣"的经验窗口：太少噪声大，
          // 太多则会把几个月前的旧口味也算进来，稀释当前意图。
          // Get user's watch history and search history
          const watchHistory = await getUserWatchHistory(userId, 10);
          const searchHistoryRecords = await getSearchHistory(userId, 10);
          const preferences = await getUserPreferences(userId);
  
          // Build context for LLM
          const watchedTitles = watchHistory.map(v => v.title).join(", ");
          const searchQueries = searchHistoryRecords.map(s => s.query).join(", ");
          const preferencesText = preferences ? JSON.stringify(preferences) : "No preferences set";
  
          const contextText = `
  User's watched videos: ${watchedTitles || "None"}
  User's search history: ${searchQueries || "None"}
  User preferences: ${preferencesText}`;
  
          // Use LLM to analyze and generate recommendations
          const response = await invokeLLM({
            messages: [
              {
                role: "system",
                content: buildRecommendationPrompt(contextText, preferencesText),
              },
            ],
          });
  
          // 逐层可选链 + 兜底文案：LLM 网关在限流/降级时可能返回 choices 为空数组，
          // 直接 `choices[0].message.content` 会抛 TypeError 把整个生成流程带崩。
          // 这里退化成一句通用文案，保证后面的本地打分照常执行。
          // Parse recommendations from LLM response (safely handle undefined)
          const firstChoice = response?.choices?.[0];
          const responseText = firstChoice
            ? (typeof firstChoice.message?.content === 'string'
              ? firstChoice.message.content
              : JSON.stringify(firstChoice.message?.content ?? ''))
            : 'Recommendations generated based on your preferences';
  
          // 先清空再重建：推荐是"快照"语义，不做增量合并，
          // 否则旧推荐会与新推荐混在一起且无法判断新鲜度。
          // 注意这中间没有事务，若下面的写入失败，用户会暂时看到 0 条推荐。
          // Clear old recommendations
          await clearUserRecommendations(userId);
  
          // 候选集：全表前 100 条视频。这是个"够用就好"的粗糙实现 ——
          // 打分逻辑跑在 Node 内存里，把全表拉下来会 OOM，所以硬截断到 100。
          // 库存变大后这里必须换成带索引的候选召回（先按分类/标签预筛再打分）。
          // Get all videos to find matches
          const allVideos = await db.select().from(videos).limit(100);
          // ⚠️ userFavorites 取出后并未参与下面的打分，是"收藏加权"功能做到一半留下的变量。
          const userFavorites = await getUserFavorites(userId, 10);
  
          // ===== 本地加权打分：为每个候选视频计算 5 个 0~1 的因子 =====
          // 权重定义在 db.ts 的 calculateRecommendationScore()：
          //   keyword 0.3 / category 0.2 / actress 0.2 / watchHistory 0.15 / popularity 0.15
          // 因子全部归一化到 [0,1]，因此 finalScore 也必然落在 [0,1]。
          // Calculate recommendation scores for each video using multiple factors
          const videoScores: Array<{ videoId: number; score: number; reason: string }> = [];
          
          allVideos.forEach(video => {
            let keywordMatch = 0;
            let categoryMatch = 0;
            let watchHistoryMatch = 0;
            // 热度归一化：播放量 / 1000 后截断到 1，即"播放量 ≥ 1000 视为满分热门"。
            // 1000 是按当前站点量级拍的经验阈值，作用是给热度设天花板，
            // 防止头部爆款靠播放量碾压掉所有个性化因子。
            let popularityScore = (video.views || 0) / 1000; // Normalize by 1000
            popularityScore = Math.min(popularityScore, 1); // Cap at 1
            
            // 关键词匹配：把每条搜索词按空白切分，统计有多少词出现在「标题 + 简介」中，
            // 得到该条搜索的命中率；多条搜索之间取**最大值**而非平均 ——
            // 语义是"只要与用户任意一次搜索意图强相关即可"，避免被无关的历史搜索稀释。
            // Keyword matching score
            const videoText = `${video.title || ""} ${video.description || ""}`.toLowerCase();
            searchHistoryRecords.forEach(record => {
              const keywords = record.query.toLowerCase().split(/\s+/);
              const matchCount = keywords.filter(kw => videoText.includes(kw)).length;
              keywordMatch = Math.max(keywordMatch, matchCount / keywords.length);
            });
            
            // 分类匹配：命中用户显式偏好分类记满分 1，命中"不想看"的分类记负分（-0.5）。
            // 负分会以 0.2 的权重折算成 -0.1 的最终分惩罚，使被排斥分类更难越过 0.2 的入选门槛。
            // Category matching score
            if (preferences?.preferredCategories?.includes(video.category || "")) {
              categoryMatch = 1;
            } else if (preferences?.avoidedCategories?.includes(video.category || "")) {
              categoryMatch = -0.5; // Penalize avoided categories
            }
            
            // 观看历史匹配：与任意一部看过的片同分类即得 0.8。
            // 取 0.8 而非 1.0 是刻意留余量 —— "同分类"只是弱相似信号，
            // 不应与"精确命中用户显式偏好设置"（1.0）等价。
            // Watch history matching score
            watchHistory.forEach(watchedVideo => {
              if (watchedVideo.category === video.category) {
                watchHistoryMatch = Math.max(watchHistoryMatch, 0.8);
              }
            });
            
            // 加权求和。传参前再夹一次值域，保证公式输出可预测。
            // Calculate final score using weighted factors
            const finalScore = calculateRecommendationScore(
              Math.min(keywordMatch, 1),
              // 修复：原先写的是 Math.max(categoryMatch, 0)，会把 avoidedCategories 的
              // -0.5 惩罚夹回 0，导致"不想看的分类"与"无关分类"完全等价、惩罚形同虚设。
              // 现在按 [-0.5, 1] 夹取，保留负向惩罚（下限即上面赋的 -0.5，仅作防御性约束）。
              Math.max(Math.min(categoryMatch, 1), -0.5),
              // 女优偏好因子权重 0.2，但需要 JOIN video_actresses 才能算，当前未接入，恒传 0；
              // 这意味着最终分的理论上限只有 0.8。
              0, // actress match would require additional data
              watchHistoryMatch,
              popularityScore
            );
            
            // 0.2 是"有意义推荐"的门槛：低于此值的视频基本只靠热度蹭分，
            // 与该用户没有任何个性化关联，宁可少推也不推噪声。
            if (finalScore > 0.2) { // Only include videos with meaningful scores
              // 反向拼装可解释性文案：把超过阈值的因子翻译成人话（"为什么推荐它"）。
              // 各因子都不突出时退化为一句泛化说明，保证 reason 永不为空。
              let reason = "Based on ";
              const reasons: string[] = [];
              if (keywordMatch > 0.5) reasons.push("your search history");
              if (categoryMatch > 0.5) reasons.push("your preferred categories");
              if (watchHistoryMatch > 0.5) reasons.push("similar videos you watched");
              if (popularityScore > 0.7) reasons.push("popularity");
              
              reason += reasons.length > 0 ? reasons.join(", ") : "your viewing patterns";
              
              videoScores.push({
                videoId: video.id,
                score: finalScore,
                reason
              });
            }
          });
  
          // 降序取 Top 20 —— 与 recommendations.list 的默认 limit 20 对齐，
          // 多存也没人看，反而增加清空/重建的开销。
          // Sort by score and save top recommendations
          const topRecommendations = videoScores
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);
          
          // 串行写入：条数固定 ≤20，累积延迟可接受；
          // 并发 insert 反而可能打满 MySQL 连接池（db 层未提供批量插入助手）。
          for (const rec of topRecommendations) {
            await saveRecommendation(
              userId,
              rec.videoId,
              rec.reason,
              rec.score
            );
          }
  
          return {
            success: true,
            recommendedCount: topRecommendations.length,
            message: responseText,
          };
        } catch (error) {
          console.error("Error generating recommendations:", error);
          return {
            success: false,
            recommendedCount: 0,
            message: "Failed to generate recommendations",
          };
        }
      }),
  }),

  // Actress Router
  /**
   * 女优公开只读路由（对应前端搜索框联想、女优详情页）。
   * 管理端的增删改在 `actressManagement` / `actressManagementV2` 子路由中，
   * 二者刻意分离：这里全部是 publicProcedure，绝不能混入写操作。
   */
  actresses: router({
    /**
     * 按 ID 获取女优档案。
     * @权限 public
     * @returns 女优记录；不存在时返回空值（不抛 404，由前端自行展示"未找到"）
     * @副作用 只读
     */
    getProfile: publicProcedure
      .input(z.object({
        actressId: z.number(),
      }))
      .query(async ({ input }) => {
        const actress = await getActressById(input.actressId);
        return actress;
      }),

    /**
     * 按名称模糊搜索女优，结果按作品数降序。
     *
     * @权限 public
     * @param input.query 搜索词，至少 1 字符；同时匹配罗马字名 / 日文名 / 中文名。
     * @returns 精简后的女优数组（id / name / japaneseName / profileImageUrl / videoCount）。
     *          任何异常都降级为 `[]` —— 搜索联想失败不该让页面报错。
     * @副作用 只读
     *
     * ## 实现说明
     * 这里**没有用 SQL LIKE**，而是把全表拉进内存用 JS 过滤。原因是要同时匹配三种语言的
     * 名字字段（其中日文/中文名可空），用 LIKE 拼 OR 条件在 MySQL 上没有可用索引，
     * 加之女优表体量小（数千行以内）。⚠️ 这是明确的规模上限，表变大后必须改为全文索引。
     */
    search: publicProcedure
      .input(z.object({
        query: z.string().min(1),
      }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return [];

        try {
          // 统一转小写做大小写不敏感匹配（罗马字名场景需要；日文/中文不受影响）
          const queryLower = input.query.toLowerCase();
          // Get all actresses and filter by name match
          const allActresses = await db.select().from(actresses);
          const matched = allActresses.filter(
            (a) =>
              a.name.toLowerCase().includes(queryLower) ||
              a.japaneseName?.toLowerCase().includes(queryLower) ||
              a.chineseName?.toLowerCase().includes(queryLower)
          );

          // 提前返回：没有命中就不必再去查作品数（省一次 JOIN 查询）
          if (matched.length === 0) return [];

          // 只为命中的女优统计作品数：GROUP BY 聚合一次拿全，
          // 避免对每个女优单独 count（N+1 查询）。
          // actressIds 非空已由上面的提前返回保证，三元表达式是防御性冗余
          // （inArray 传空数组在 Drizzle 中会生成非法 SQL）。
          // Get video counts for matched actresses from video_actresses table
          const actressIds = matched.map((a) => a.id);
          const videoCountsRaw = actressIds.length > 0
            ? await db
                .select({
                  actressId: videoActresses.actressId,
                  count: sql<number>`count(*)`.as("count"),
                })
                .from(videoActresses)
                .where(inArray(videoActresses.actressId, actressIds))
                .groupBy(videoActresses.actressId)
            : [];

          // 转成 Map 便于 O(1) 查找。Number() 是必须的：MySQL 驱动会把
          // COUNT(*) 以字符串形式返回，不转换会导致后面的数值排序退化成字典序。
          const videoCountMap = new Map(
            videoCountsRaw.map((vc) => [vc.actressId, Number(vc.count)])
          );

          // 作品数取值优先级：实时聚合值 → 表上冗余的 videoCount 快照 → 0。
          // 保留快照兜底是因为部分历史数据只填了 actresses.videoCount 而没有关联记录。
          // Return matched actresses with video counts, sorted by video count desc
          return matched
            .map((a) => ({
              id: a.id,
              name: a.name,
              japaneseName: a.japaneseName,
              profileImageUrl: a.profileImageUrl,
              videoCount: videoCountMap.get(a.id) || a.videoCount || 0,
            }))
            .sort((a, b) => b.videoCount - a.videoCount);
        } catch (error) {
          // 搜索联想属于非关键路径：出错时记日志并返回空列表，
          // 让搜索框静默无结果，而不是把整个页面打成错误态。
          console.error("[Actresses] Search error:", error);
          return [];
        }
      }),
  }),



  // User Preferences Router
  /**
   * 用户显式偏好路由。
   * 与 `analyzeUserPreferences()`（从行为历史**隐式**推断）互补：
   * 这里存的是用户主动勾选的口味，权重高于隐式信号，直接参与
   * `recommendations.generate` 的 categoryMatch 因子。
   */
  userPreferences: router({
    /**
     * 读取当前用户偏好。
     * @权限 protected
     * @returns 偏好记录；从未设置过则为空值，调用方需自行兜底（推荐流水线用了 `?.`）
     * @副作用 只读
     */
    get: protectedProcedure
      .query(async ({ ctx }) => {
        const userId = ctx.user!.id as number;
        return await getUserPreferences(userId);
      }),

    /**
     * 更新用户偏好（upsert）。
     * @权限 protected
     * @param input.preferredCategories 想看的分类名数组
     * @param input.preferredActresses  想看的女优 ID 数组（目前推荐流水线尚未消费，见 actressMatch 恒为 0）
     * @param input.avoidedCategories   不想看的分类名数组
     *        —— 三者皆为 optional：允许只提交被修改的那一部分做局部更新。
     * @副作用 写库（user_preferences 表）
     */
    update: protectedProcedure
      .input(z.object({
        preferredCategories: z.array(z.string()).optional(),
        preferredActresses: z.array(z.number()).optional(),
        avoidedCategories: z.array(z.string()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user!.id as number;
        await updateUserPreferences(userId, input);
        return { success: true };
      }),
  }),

  // Search History Router
  /**
   * 搜索历史路由。
   * 这张表是**推荐与聊天 RAG 的主要输入源**（`analyzeUserPreferences`、
   * `recommendations.generate` 的 keywordMatch 都读它），
   * 因此"清空历史"不仅是隐私操作，也会直接削弱个性化效果。
   */
  searchHistory: router({
    /**
     * 列出当前用户的搜索历史。
     * @权限 protected
     * @param input.limit 条数，默认 20
     * @副作用 只读
     */
    list: protectedProcedure
      .input(z.object({
        limit: z.number().default(20),
      }))
      .query(async ({ input, ctx }) => {
        const userId = ctx.user!.id as number;
        return await getSearchHistory(userId, input.limit);
      }),

    /**
     * 手动写入一条搜索历史。
     *
     * @权限 protected
     * @param input.query        搜索内容。对 face/image 类型，各搜索路由存的是
     *                           JSON 字符串（如 `{"imageUrl":"..."}`），而非自然语言。
     * @param input.searchType   "text" | "face" | "image"，与 search_history.searchType 枚举一致
     * @param input.resultsCount 命中结果数，用于后续评估搜索质量
     * @副作用 写库（search_history 表）
     *
     * 注：服务端各搜索入口（./search.ts、faceSearch 路由、chat.sendMessage）
     * 已自行调用 `saveSearchHistory`，此 procedure 主要供纯前端触发的搜索场景补记。
     */
    save: protectedProcedure
      .input(z.object({
        query: z.string().min(1),
        searchType: z.enum(["text", "face", "image"]),
        resultsCount: z.number().default(0),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user!.id as number;
        await saveSearchHistory(userId, input.query, input.searchType, input.resultsCount);
        return { success: true };
      }),

    /**
     * 删除单条搜索历史。
     *
     * @权限 protected（并额外做**归属校验**）
     * @param input.historyId 记录主键
     * @副作用 写库（删除一行）
     * @throws "Unauthorized" —— 记录不存在或不属于当前用户
     *
     * ⚠️ 安全要点：`historyId` 是全局自增主键，客户端可以随意猜测，
     * 因此必须先 SELECT 出记录、核对 `userId` 再删，
     * 不能直接 `DELETE WHERE id = ?`（那样任何登录用户都能删他人历史）。
     * 更优写法是把 userId 直接并入 DELETE 的 WHERE 条件，一条语句搞定且无竞态。
     */
    delete: protectedProcedure
      .input(z.object({
        historyId: z.number(),
      }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const userId = ctx.user!.id as number;
        // Verify ownership before deletion
        const record = await db
          .select()
          .from(searchHistory)
          .where(eq(searchHistory.id, input.historyId))
          .limit(1);
        
        // 「不存在」与「不属于我」合并成同一个 Unauthorized 错误，
        // 避免通过错误信息差异探测某个 historyId 是否存在（枚举攻击）。
        if (record.length === 0 || record[0].userId !== userId) {
          throw new Error("Unauthorized");
        }
        
        await db.delete(searchHistory).where(eq(searchHistory.id, input.historyId));
        return { success: true };
      }),

    /**
     * 清空当前用户的全部搜索历史（隐私功能）。
     *
     * @权限 protected
     * @副作用 写库（批量删除）。**不可逆**，且会连带清掉推荐/聊天 RAG 的偏好信号，
     *         下次 `recommendations.generate` 的 keywordMatch 将全部退化为 0。
     * @throws "Database not available"
     *
     * 这里 WHERE 条件直接锁定 `userId`，天然无越权风险（与上面的 delete 不同）。
     */
    clearAll: protectedProcedure
      .mutation(async ({ ctx }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        const userId = ctx.user!.id as number;
        await db.delete(searchHistory).where(eq(searchHistory.userId, userId));
        return { success: true };
      }),
  }),

  // Language Router
  /**
   * 语言路由。
   *
   * ⚠️ 当前是**占位实现**：`set` 校验了入参却没有做任何持久化，恒返回成功。
   * 实际的语言切换完全由前端 `client/src/contexts/LanguageContext.tsx` 在本地状态 +
   * localStorage 中完成；服务端只有 `ctx.user.language`（来自 OAuth 用户资料）
   * 会影响 `chat.sendMessage` 的 system prompt 语种。
   *
   * 后果：用户在前端切到中文后，AI 聊天回复的语种不会随之改变，仍沿用账号语言。
   * 若要修复，应在此写入 users 表或 user_preferences 表（见 observations）。
   */
  language: router({
    /**
     * 设置界面语言（当前为 no-op）。
     * @权限 protected
     * @param input.language "ja" | "zh" | "en"
     * @副作用 无（未写库）
     */
    set: protectedProcedure
      .input(z.object({
        language: z.enum(["ja", "zh", "en"]),
      }))
      .mutation(async ({ input, ctx }) => {
        // Language preference update would be handled in the frontend
        // by updating user context after mutation
        return { success: true };
      }),
  }),
});

/**
 * 根路由类型。前端 `createTRPCReact<AppRouter>()` 靠它推导出所有
 * query/mutation 的入参与返回值类型 —— 这是本项目"类型从服务端流向客户端"的关键一环。
 * 仅类型导出，编译后不产生任何运行时代码。
 */
export type AppRouter = typeof appRouter;
export default appRouter;
