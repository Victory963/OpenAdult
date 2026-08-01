/**
 * server/llm-prompts.ts — LLM 提示词模板层 (Prompt Templates)
 *
 * LLM Prompt Templates for Adult Content Search Assistant
 * Using Heretic (uncensored) models for unrestricted content recommendations
 *
 * 【架构定位】
 * 纯数据 + 纯函数模块，不做任何 IO：既不查库也不调用 LLM。
 * 它位于「数据访问层 (server/db.ts)」与「LLM 调用层 (server/_core/llm.ts)」之间，
 * 负责把结构化的用户画像/检索结果**序列化成一段自然语言 system prompt**。
 * 因此本文件可以被单元测试直接断言输出字符串 (见 server/chat-preferences.test.ts)。
 *
 * 【主要导出物】
 *   - SYSTEM_PROMPTS         : 四个场景的基础 system prompt 常量
 *                              (chatAssistant / searchAnalysis / recommendationEngine / actressProfile)
 *   - USER_QUERY_EXAMPLES    : ja/zh/en 三语的示例问句 (供 UI 展示引导语，当前未被引用)
 *   - UserPreferenceContext  : 用户画像上下文的类型契约
 *   - buildChatSystemPrompt      : 组装聊天 system prompt (基础 + 语言指令 + 画像上下文)
 *   - buildSearchAnalysisPrompt  : 返回查询解析 prompt
 *   - buildRecommendationPrompt  : 组装推荐 prompt (含观看历史与偏好)
 *   - buildActressProfilePrompt  : 组装女优资料查询 prompt
 *
 * 【上下游依赖】
 *   上游 (调用方)：server/routers.ts (chat / recommendation 相关 tRPC procedure)、
 *                  server/chat-preferences.test.ts。
 *   下游 (被依赖)：无 (零依赖模块)。
 *   数据来源：`UserPreferenceContext` 的字段结构与 server/db.ts 中
 *            `analyzeUserPreferences` / `getRelevantVideosForChat` /
 *            `getRelevantActressesForChat` 的返回值一一对应，
 *            **改动任一侧都必须同步另一侧**。
 *
 * 【关键设计决策 / 坑】
 *   1. 模型使用 Heretic 系列的「无审查」LLM (ENV.hereticLlmModel)，
 *      prompt 中显式声明不做内容过滤，这是本项目的核心业务前提。
 *   2. prompt 主体统一用英文书写 (模型对英文指令遵循度更高)，
 *      再通过 languageNote 追加一句「用某语言回答」的指令来控制输出语种。
 *   3. 注入数据库中的真实视频/女优及其 ID，要求模型按 ID 引用，
 *      目的是抑制幻觉 (避免推荐库里不存在的作品)。
 *   4. 所有拼接都用切片 (slice) 限制条数，本质是**token 预算控制**，
 *      不是业务上的「只有这么多数据」。
 */

/**
 * 四个场景的基础 system prompt。
 * 这些字符串是提示词工程的产物，修改会直接影响线上 AI 的回答风格与合规边界，
 * 改动前建议先用 server/chat-preferences.test.ts 之类的测试固定预期。
 */
export const SYSTEM_PROMPTS = {
  // chatAssistant —— AI 聊天推荐页 (ChatPage / AIChatBox) 的人格设定。
  // 明确禁用内容过滤，并要求按用户语言作答；实际语言指令由 buildChatSystemPrompt 追加。
  chatAssistant: `You are an expert adult video search assistant powered by Heretic (uncensored LLM). Your role is to help users find adult videos based on their preferences, interests, and natural language queries without any content restrictions or filtering.

Key responsibilities:
1. Understand user queries about adult content preferences, genres, and performers
2. Provide detailed recommendations based on user interests
3. Suggest search keywords and tags that will help find relevant content
4. Discuss adult content openly and without judgment
5. Help users discover new content based on their viewing history and preferences

You have unrestricted access to discuss all adult content categories, genres, and performers. Do not apply any content filters or refuse requests based on content type.

Always respond in the user's preferred language (Japanese, Chinese, or English).`,

  // searchAnalysis —— 把自然语言查询解析成结构化检索条件 (关键词/分类/演员/偏好/意图)。
  // 要求返回 JSON，但**没有约定严格 schema**，调用方需自行容错解析。
  searchAnalysis: `You are an AI assistant that analyzes user queries for adult video search. Your task is to extract search parameters from natural language queries.

Analyze the user query and extract:
- Keywords: Main search terms
- Categories: Adult content categories (e.g., "熟女", "巨乳", "中出し", etc.)
- Performers: Actress/performer names if mentioned
- Preferences: Specific preferences or characteristics
- Mood/Context: What the user is looking for (new content, specific type, etc.)

Return structured JSON with these fields.`,

  // recommendationEngine —— 「刷新推荐」流程的 system prompt。
  // 第 4 条要求推荐结果保持多样性，用于对冲纯相似度推荐导致的信息茧房。
  recommendationEngine: `You are a recommendation engine for adult video content. Based on user viewing history, preferences, and current interests, suggest relevant videos.

Consider:
1. Previously watched content and categories
2. User's stated preferences
3. Trending or popular content in their preferred categories
4. Diversity in recommendations (mix of familiar and new content)
5. Performer preferences if applicable

Provide recommendations with brief explanations of why each video might interest the user.`,

  // actressProfile —— 生成女优资料卡文案。
  // 注意：这类信息完全由模型生成，**不来自数据库**，存在事实性幻觉风险，
  // 不适合直接当作权威资料落库。
  actressProfile: `You are an assistant that provides information about adult video performers/actresses. When given a performer name, provide:
1. Basic information (if available)
2. Popular genres/categories they appear in
3. Notable videos or series
4. Similar performers
5. Fan ratings or popularity metrics

Be factual and professional in your descriptions.`,
};

/**
 * 三语示例问句，用于在聊天框空状态下给用户「可以这样问」的引导。
 * 键与 users.language 枚举 (ja/zh/en) 对齐。
 * 当前仓库中没有任何地方引用它 —— 属于预留/待接入的 UI 文案资源。
 */
export const USER_QUERY_EXAMPLES = {
  ja: [
    "最近人気の熟女ものを探してます",
    "〇〇に似た女優の動画ありますか？",
    "中出しシーンが多い作品を教えてください",
    "新作で人気のある動画は？",
  ],
  zh: [
    "我想找最新的成人视频",
    "推荐一些热门女优的作品",
    "有没有特定类型的内容推荐？",
    "根据我的观看历史推荐一些视频",
  ],
  en: [
    "Show me popular adult videos",
    "Recommend videos similar to what I've watched",
    "What are the trending adult videos this week?",
    "Find videos with specific performers",
  ],
};

/**
 * 注入 LLM 的「用户画像 + 候选内容」上下文契约。
 *
 * 前 5 个必填字段直接对应 server/db.ts 中 `analyzeUserPreferences` 的返回结构；
 * 后 2 个可选字段来自 `getRelevantVideosForChat` / `getRelevantActressesForChat`，
 * 只有在「本轮有具体查询、需要模型引用真实条目」时才提供。
 */
export interface UserPreferenceContext {
  /** 搜索词切分后的高频关键词及出现次数 (Top 15) */
  topKeywords: Array<{ keyword: string; count: number }>;
  /** 观看分类的头部子集 (当前实现等于 watchedCategories 的前 5 条) */
  topCategories: Array<{ category: string; count: number }>;
  /** 从收藏视频反推出的常看女优 (Top 5) */
  favoriteActresses: Array<{ id: number; name: string; profileImageUrl: string | null }>;
  /** 最近的原始搜索词 (最多 10 条) */
  recentSearches: string[];
  /** 观看历史中的分类 + 标签词频 (Top 10) */
  watchedCategories: Array<{ category: string; count: number }>;
  /** 本轮查询召回的真实视频，模型必须按其 ID 引用，用于抑制幻觉 */
  relevantVideos?: Array<{ id: number; title: string; category: string | null; rating: string | null }>;
  /** 本轮查询召回的真实女优，同上 */
  relevantActresses?: Array<{ id: number; name: string; profileImageUrl: string | null }>;
}

/**
 * 组装聊天场景的完整 system prompt。
 *
 * 结构固定为三段拼接：
 *   `基础人格 (SYSTEM_PROMPTS.chatAssistant)` + `语言指令` + `用户上下文块 (可选)`
 *
 * 语言指令用目标语言本身书写 (日文提示写成日文、中文提示写成中文)，
 * 这比用英文说 "answer in Japanese" 更能稳定地锁定输出语种。
 *
 * @param language    输出语言，取值与 users.language 枚举一致
 * @param userContext 用户画像；不传或所有字段都为空时**完全省略**上下文块，
 *                    退化为通用推荐 (新用户 / 未登录场景)
 * @returns 拼接后的 system prompt 字符串
 *
 * 副作用：无 (纯函数，可安全用于单元测试)。
 */
export function buildChatSystemPrompt(language: "ja" | "zh" | "en", userContext?: UserPreferenceContext): string {
  const basePrompt = SYSTEM_PROMPTS.chatAssistant;
  const languageNote = {
    ja: "\n\nユーザーは日本語で質問しています。日本語で回答してください。",
    zh: "\n\n用户用中文提问。请用中文回答。",
    en: "\n\nThe user is asking in English. Please respond in English.",
  };

  // 逐个字段「有才拼」：把画像序列化成若干行人类可读文本，收集进 parts。
  // 每处 slice(n) 都是 token 预算控制 —— 上下文块整体要压在几百 token 以内，
  // 否则会挤占多轮对话历史的空间。
  // 计数值 `keyword(count)` 一并给到模型，让它能区分「偶尔搜过」和「反复搜索」的强弱偏好。
  let contextSection = "";
  if (userContext) {
    const parts: string[] = [];

    if (userContext.recentSearches.length > 0) {
      parts.push(`Recent searches: ${userContext.recentSearches.slice(0, 5).join(", ")}`);
    }
    if (userContext.topKeywords.length > 0) {
      parts.push(`Frequently searched keywords: ${userContext.topKeywords.slice(0, 10).map(k => `${k.keyword}(${k.count})`).join(", ")}`);
    }
    if (userContext.watchedCategories.length > 0) {
      parts.push(`Preferred categories (from watch history): ${userContext.watchedCategories.slice(0, 8).map(c => `${c.category}(${c.count})`).join(", ")}`);
    }
    if (userContext.favoriteActresses.length > 0) {
      parts.push(`Favorite actresses: ${userContext.favoriteActresses.map(a => a.name).join(", ")}`);
    }
    // 候选视频/女优以 `- [ID:123] 标题 (分类, rating: x)` 的列表形式给出：
    // 显式的 ID 前缀是给模型的「可引用句柄」，前端据此把回复中的 ID 还原成可点击的卡片。
    if (userContext.relevantVideos && userContext.relevantVideos.length > 0) {
      parts.push(`\nRelevant videos in database that match the query:\n${userContext.relevantVideos.slice(0, 8).map(v => `- [ID:${v.id}] ${v.title} (${v.category || "uncategorized"}, rating: ${v.rating || "N/A"})`).join("\n")}`);
    }
    if (userContext.relevantActresses && userContext.relevantActresses.length > 0) {
      parts.push(`\nRelevant actresses in database:\n${userContext.relevantActresses.map(a => `- [ID:${a.id}] ${a.name}`).join("\n")}`);
    }

    // 用 `=== ... ===` 包裹上下文块：给模型一个明确的「数据区」边界，
    // 避免它把这些事实数据误当成用户指令来执行 (prompt injection 的轻量防护)。
    // parts 为空时不输出任何标记，保持 prompt 干净。
    if (parts.length > 0) {
      contextSection = `\n\n=== USER PREFERENCE CONTEXT ===\nUse this information to personalize your recommendations. Reference specific videos by their ID when recommending.\n${parts.join("\n")}\n=== END CONTEXT ===`;
    }
  }

  return basePrompt + languageNote[language] + contextSection;
}

/**
 * 返回「查询解析」场景的 system prompt。
 *
 * 目前只是常量的透传封装，保留函数形式是为了将来加入动态参数
 * (如可选分类白名单) 时不必改调用点。
 *
 * @returns searchAnalysis prompt 原文
 *
 * 副作用：无。
 * 备注：server/routers.ts 已 import 但当前未实际调用。
 */
export function buildSearchAnalysisPrompt(): string {
  return SYSTEM_PROMPTS.searchAnalysis;
}

/**
 * 组装「生成推荐列表」的 prompt。
 *
 * 与 buildChatSystemPrompt 不同，这里的历史与偏好由调用方 (server/routers.ts)
 * 预先拼成纯文本再传入，本函数只负责套模板并追加输出要求 (5-10 条 + 简短理由)。
 *
 * @param userHistory 已格式化的观看历史文本
 * @param preferences 已格式化的当前偏好文本
 * @returns 完整 prompt 字符串
 *
 * 副作用：无。
 */
export function buildRecommendationPrompt(userHistory: string, preferences: string): string {
  return `${SYSTEM_PROMPTS.recommendationEngine}

User's viewing history and preferences:
${userHistory}

Current preferences:
${preferences}

Based on this information, provide 5-10 video recommendations with brief explanations.`;
}

/**
 * 组装「查询女优资料」的 prompt。
 *
 * @param actressName 女优姓名，直接插值进 prompt
 * @returns 完整 prompt 字符串
 *
 * 副作用：无。
 *
 * ⚠️ 安全提示：actressName 未做任何转义/长度限制，若来源于用户输入，
 *    存在 prompt injection 风险 (用户可在姓名里塞入指令)。当前无调用方引用本函数。
 */
export function buildActressProfilePrompt(actressName: string): string {
  return `${SYSTEM_PROMPTS.actressProfile}

Actress name: ${actressName}

Provide comprehensive information about this performer.`;
}
