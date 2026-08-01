/**
 * ============================================================================
 * client/src/contexts/LanguageContext.tsx — 多语言上下文 (UI 层 / 全局 Context)
 * ============================================================================
 *
 * 架构角色：
 *   轻量级 i18n 方案的状态层。本项目没有引入 i18next 等库，而是用
 *   "一个巨大的静态翻译对象 (locales/translations.ts) + 一个当前语言 Context"
 *   来实现三语切换（ja / zh / en）。本文件只负责保存与切换当前语言，
 *   文案查表由各组件自行完成：`translations[language].xxx.yyy`。
 *
 * 主要导出物：
 *   - LanguageProvider : Provider 组件，在 App.tsx 中包裹整棵树
 *   - useLanguage()    : 消费 Hook，返回 { language, setLanguage }
 *
 * 上下游依赖：
 *   ← client/src/App.tsx（挂载）
 *   ← client/src/components/LanguageSwitcher.tsx（切换语言）
 *   ← client/src/pages/Dashboard.tsx 等需要文案的页面
 *   → @/locales/translations（Language 类型与翻译表）
 *   → localStorage["language"]（持久化用户偏好）
 *
 * 关键设计决策：
 *   默认语言为 "ja"（日语）—— 本站主要面向日本市场，而非跟随浏览器语言。
 */

import React, { createContext, useContext, useState, useEffect } from "react";
import { Language } from "@/locales/translations";

/**
 * Context 值契约。
 * @property language    当前语言代码："ja" | "zh" | "en"。
 * @property setLanguage 切换语言并写入 localStorage。
 */
interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
}

// 与 ThemeContext 同样的模式：默认 undefined 以便 useLanguage 检测缺失的 Provider
const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

/**
 * 多语言 Provider。
 *
 * @param children 被包裹的子树。
 *
 * 内部状态：
 *   - language : 当前生效语言，初始 "ja"（业务默认，非浏览器语言）；
 *   - isLoaded : 是否已完成 localStorage 偏好读取，用于避开首帧"语言闪烁"
 *                （先渲染日语再跳成中文）。
 *
 * 副作用：读写 localStorage["language"]。
 */
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("ja");
  const [isLoaded, setIsLoaded] = useState(false);

  // Load language preference from localStorage
  // 挂载后读取持久化偏好。放在 useEffect 而非 useState 惰性初始化里，
  // 是为了配合下方 isLoaded 的"首帧不渲染 Provider"策略。
  // 依赖数组为空 → 只执行一次，之后语言变化由 setLanguage 驱动。
  useEffect(() => {
    const saved = localStorage.getItem("language") as Language | null;
    // 白名单校验：localStorage 可被用户或旧版本代码写入任意值，
    // 若不校验会导致 translations[language] 取到 undefined 而整页崩溃。
    if (saved && ["ja", "zh", "en"].includes(saved)) {
      setLanguageState(saved);
    }
    setIsLoaded(true);
  }, []);

  /**
   * 切换语言。
   * @param lang 目标语言代码。
   * 副作用：同步更新 state 并持久化到 localStorage，刷新后保持不变。
   */
  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem("language", lang);
  };

  // 首帧（localStorage 尚未读取完成）时直接透传 children，不提供 Context。
  // 目的是避免用错误的默认语言渲染一帧再切换造成文案闪烁。
  // 代价：这一帧中 Context 为 undefined —— 见文件级注释与调用方约定。
  if (!isLoaded) {
    return <>{children}</>;
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
}

/**
 * 读取多语言上下文。
 *
 * @returns { language, setLanguage }
 * @throws  Error("useLanguage must be used within LanguageProvider")
 *          —— 未被 LanguageProvider 包裹时抛出（快速失败）。
 *
 * 注意：LanguageProvider 在首帧（isLoaded 为 false）会不带 Context 渲染
 * children，因此在那一帧内调用本 Hook 的组件会命中此抛错分支，
 * 由 App.tsx 最外层的 ErrorBoundary 兜住。
 */
export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within LanguageProvider");
  }
  return context;
}
