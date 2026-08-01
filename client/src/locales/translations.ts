/**
 * ============================================================================
 * client/src/locales/translations.ts — 静态三语文案表（i18n 数据层）
 * ============================================================================
 *
 * ## 在架构中的位置
 * 本项目的轻量 i18n 方案由三块拼成，本文件是其中的**数据层**：
 *   - 数据层：**本文件**（一个嵌套的静态对象，无运行时加载、无按需分包）
 *   - 状态层：`client/src/contexts/LanguageContext.tsx`（当前语言 + localStorage 持久化）
 *   - 视图层：`client/src/components/LanguageSwitcher.tsx`（切换下拉菜单）
 *
 * ## 主要导出
 * | 导出物            | 类型     | 用途                                              |
 * |-------------------|----------|---------------------------------------------------|
 * | `translations`    | 常量对象 | 三语文案表，形如 `translations[lang].home.title`   |
 * | `Language`        | 类型     | `"ja" \| "zh" \| "en"`，全站语言代码的唯一真值来源 |
 * | `TranslationKey`  | 类型     | 顶层分组名（nav/home/chat/common）                 |
 * | `getTranslation`  | 函数     | 按 `"a.b.c"` 点号路径取文案，带兜底                |
 *
 * ## 上下游依赖
 * - 被 `LanguageContext.tsx` 引入（只取 `Language` 类型）。
 * - 被各页面直接引入查表，或通过 `getTranslation()` 动态取值。
 * - 无任何下游依赖 —— 纯数据模块，不 import 任何东西。
 *
 * ## 关键设计决策与坑
 * 1. **不引入 i18next**：文案量小（4 个分组），静态对象足够；代价是没有插值、
 *    没有复数规则、没有按语言分包（三语文案全部打进主 bundle）。
 * 2. **默认语言是 `ja`**（见 LanguageContext），因为本站主要面向日本市场。
 *    因此**日语是文案基准**，`TranslationKey` 类型也是从 `translations.ja` 推导的。
 * 3. **三份文案结构必须严格保持一致**，但当前**没有类型约束来强制这一点** ——
 *    zh/en 漏写某个键不会有编译错误，只会在运行时静默回落成 key 字符串
 *    （见 observations）。
 * 4. **覆盖率有限**：只覆盖了导航、首页、聊天页和少数通用词。
 *    VideosPage / FaceSearchPage / 各管理面板的文案仍是硬编码日语，未走本表。
 */
export const translations = {
  // ── 日语（ja）：默认语言，也是文案结构的基准 ──────────────────────────────
  ja: {
    // Navigation
    nav: {
      chat: "チャット",
      dashboard: "ダッシュボード",
      login: "ログイン",
      logout: "ログアウト",
    },
    // Home page
    // home.features 下的 6 个子项与首页的 6 张功能卡片一一对应；
    // 键名（aiChat/faceSearch/…）即卡片顺序，新增卡片需三种语言同步补齐。
    home: {
      title: "AI検索アシスタントで完璧な動画を発見",
      subtitle: "Heretic LLMを搭載した無検閲AIチャットで、自然な会話から理想の成人動画を検索できます。あなたの好みを理解し、パーソナライズされたレコメンデーションを提供します。",
      startBtn: "AIチャットを開始",
      learnMore: "詳しく知る",
      features: {
        aiChat: {
          title: "AIチャット検索",
          desc: "Heretic LLMを搭載した無検閲AIが、自然な会話で理想の動画を探すお手伝いをします。",
        },
        faceSearch: {
          title: "顔認識検索",
          desc: "女優の顔画像から、その出演動画を検索できます。好きな女優の作品を簡単に見つけられます。",
        },
        favorites: {
          title: "お気に入り管理",
          desc: "好きな動画をお気に入りに登録して、いつでも簡単にアクセスできます。",
        },
        recommendations: {
          title: "パーソナライズ推奨",
          desc: "あなたの視聴履歴と好みに基づいて、AIが最適な動画をレコメンデーションします。",
        },
        profile: {
          title: "女優プロフィール",
          desc: "女優の詳細情報、出演作品、関連動画などを一覧で確認できます。",
        },
        resume: {
          title: "続き再生機能",
          desc: "前回の視聴位置から自動的に再開できます。時間を無駄にしません。",
        },
      },
      cta: "今すぐ無検閲AIチャットを体験",
      ctaDesc: "Hereticモデルを搭載した完全無検閲のAIアシスタントで、制限なく理想の成人動画を検索できます。",
    },
    // Chat page
    chat: {
      title: "AI検索アシスタント",
      subtitle: "Heretic LLM搭載 - 無検閲で理想の動画を検索",
      placeholder: "検索クエリを入力...",
      emptyTitle: "何かお探しですか？",
      emptyDesc: "「最近人気の熟女もの」「〇〇に似た女優の動画」など、自然言語で検索できます。",
      // examples 是**数组**而非对象，是本表中唯一的非字符串叶子节点：
      // 聊天页空态会遍历它渲染成一排可点击的示例提示（点击即填入输入框）。
      // 注意 getTranslation() 的返回类型标注为 string，取这个键会得到类型不符的数组，
      // 因此调用方必须直接访问 translations[lang].chat.examples 而不能走 getTranslation。
      examples: [
        "「最近人気の熟女ものを探してます」",
        "「巨乳で中出しシーンが多い動画」",
        "「〇〇に似た女優の作品」",
        "「新作で評価が高いもの」",
      ],
      thinking: "考え中...",
    },
    // Common
    common: {
      loading: "読み込み中...",
      error: "エラーが発生しました",
      back: "戻る",
      home: "ホーム",
      loginRequired: "ログインが必要です",
    },
  },
  // ── 简体中文（zh）：结构必须与上面的 ja 完全对齐 ──────────────────────────
  zh: {
    // Navigation
    nav: {
      chat: "聊天",
      dashboard: "仪表板",
      login: "登录",
      logout: "登出",
    },
    // Home page
    home: {
      title: "用AI搜索助手发现完美视频",
      subtitle: "配备Heretic LLM的无审查AI聊天，通过自然对话搜索理想的成人视频。它理解您的偏好，提供个性化推荐。",
      startBtn: "开始AI聊天",
      learnMore: "了解更多",
      features: {
        aiChat: {
          title: "AI聊天搜索",
          desc: "配备Heretic LLM的无审查AI通过自然对话帮助您找到理想视频。",
        },
        faceSearch: {
          title: "人脸识别搜索",
          desc: "从女演员的面部图像搜索她的出演视频。轻松找到您喜爱女演员的作品。",
        },
        favorites: {
          title: "收藏管理",
          desc: "将喜爱的视频添加到收藏，随时轻松访问。",
        },
        recommendations: {
          title: "个性化推荐",
          desc: "根据您的观看历史和偏好，AI推荐最适合的视频。",
        },
        profile: {
          title: "女演员资料",
          desc: "查看女演员的详细信息、出演作品和相关视频。",
        },
        resume: {
          title: "继续播放功能",
          desc: "从上次观看位置自动继续。不浪费时间。",
        },
      },
      cta: "立即体验无审查AI聊天",
      ctaDesc: "配备Heretic模型的完全无审查AI助手，无限制地搜索理想的成人视频。",
    },
    // Chat page
    chat: {
      title: "AI搜索助手",
      subtitle: "Heretic LLM驱动 - 无审查搜索理想视频",
      placeholder: "输入搜索查询...",
      emptyTitle: "您在找什么？",
      emptyDesc: "您可以用自然语言搜索，如\"最近流行的熟女作品\"或\"类似某某女演员的视频\"。",
      examples: [
        "\"我在找最近流行的熟女作品\"",
        "\"巨乳和中出镜头较多的视频\"",
        "\"类似某某女演员的作品\"",
        "\"评分最高的新作品\"",
      ],
      thinking: "思考中...",
    },
    // Common
    common: {
      loading: "加载中...",
      error: "发生错误",
      back: "返回",
      home: "首页",
      loginRequired: "需要登录",
    },
  },
  // ── 英语（en）：结构必须与上面的 ja 完全对齐 ──────────────────────────────
  en: {
    // Navigation
    nav: {
      chat: "Chat",
      dashboard: "Dashboard",
      login: "Login",
      logout: "Logout",
    },
    // Home page
    home: {
      title: "Discover Perfect Videos with AI Search Assistant",
      subtitle: "Powered by Heretic LLM uncensored AI chat, search for ideal adult videos through natural conversation. It understands your preferences and provides personalized recommendations.",
      startBtn: "Start AI Chat",
      learnMore: "Learn More",
      features: {
        aiChat: {
          title: "AI Chat Search",
          desc: "Heretic LLM-powered uncensored AI helps you find ideal videos through natural conversation.",
        },
        faceSearch: {
          title: "Face Recognition Search",
          desc: "Search videos by actress face image. Easily find your favorite performer's works.",
        },
        favorites: {
          title: "Favorites Management",
          desc: "Save favorite videos and access them anytime easily.",
        },
        recommendations: {
          title: "Personalized Recommendations",
          desc: "AI recommends the most suitable videos based on your viewing history and preferences.",
        },
        profile: {
          title: "Actress Profile",
          desc: "View actress details, filmography, and related videos.",
        },
        resume: {
          title: "Resume Playback",
          desc: "Automatically continue from where you left off. No time wasted.",
        },
      },
      cta: "Experience Uncensored AI Chat Now",
      ctaDesc: "Fully uncensored AI assistant powered by Heretic model. Search for ideal adult videos without restrictions.",
    },
    // Chat page
    chat: {
      title: "AI Search Assistant",
      subtitle: "Powered by Heretic LLM - Uncensored search for ideal videos",
      placeholder: "Enter search query...",
      emptyTitle: "What are you looking for?",
      emptyDesc: "You can search using natural language like \"recent popular mature videos\" or \"videos similar to actress X\".",
      examples: [
        "\"I'm looking for recent popular mature videos\"",
        "\"Videos with big breasts and creampie scenes\"",
        "\"Videos similar to actress X\"",
        "\"Highest-rated new releases\"",
      ],
      thinking: "Thinking...",
    },
    // Common
    common: {
      loading: "Loading...",
      error: "An error occurred",
      back: "Back",
      home: "Home",
      loginRequired: "Login required",
    },
  },
};

/**
 * 全站语言代码。手写字面量联合而非 `keyof typeof translations`，
 * 这样 LanguageContext / LanguageSwitcher 可以只 import 类型而不牵连整张文案表
 * （类型 import 会被编译期擦除，避免不必要的运行时依赖）。
 */
export type Language = "ja" | "zh" | "en";

/**
 * 顶层分组名："nav" | "home" | "chat" | "common"。
 * 从 `translations.ja` 推导 —— 再次体现"日语是基准"这一约定。
 * 注意它只覆盖**第一层**键，不是完整的点号路径类型，因此对 getTranslation 的
 * 第二个参数起不到约束作用（该参数仍是宽松的 string）。
 */
export type TranslationKey = keyof typeof translations.ja;

/**
 * 按点号路径从文案表中取值。
 *
 * 实现要点：把 `"home.features.aiChat.title"` 按 `.` 拆开，从
 * `translations[language]` 起逐层下钻。每步都用可选链 `?.`，
 * 因此路径中途缺失不会抛 TypeError，只会让 value 变成 undefined。
 *
 * @param language 目标语言代码
 * @param key      点号分隔的路径，如 `"common.loading"`
 * @returns 命中的文案；**未命中时原样返回 key 本身**作为兜底 —— 这样界面上会显示
 *          `"common.loading"` 这种明显不对劲的字符串，便于开发时肉眼发现漏翻译，
 *          同时避免出现空白。
 * @副作用 无（纯函数）。
 *
 * ⚠️ 两个坑（见 observations）：
 *   1. 兜底用的是 `||` 而非 `??`，因此文案若为**空字符串**也会被判为"未命中"而返回 key；
 *   2. 返回类型标注为 string，但取到 `chat.examples` 这类数组节点时会返回数组，
 *      类型系统因为中间变量是 `any` 而察觉不到。
 */
export function getTranslation(language: Language, key: string): string {
  const keys = key.split(".");
  let value: any = translations[language];

  for (const k of keys) {
    value = value?.[k];
  }

  return value || key;
}
