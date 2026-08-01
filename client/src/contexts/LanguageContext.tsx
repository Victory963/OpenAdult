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
 *   1. 默认语言为 "ja"（日语）—— 本站主要面向日本市场，而非跟随浏览器语言。
 *   2. localStorage 偏好在 useState 惰性初始化里同步读取，**首帧即为最终语言**：
 *      既不会出现"先渲染日语再跳成中文"的文案闪烁，Provider 也从第一次渲染起
 *      就必然存在，消费者不存在拿不到 Context 的窗口期。
 */

import React, { createContext, useContext, useState } from "react";
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
 * 读取 localStorage 中持久化的语言偏好。
 *
 * @returns 合法的语言代码；无偏好 / 值非法 / localStorage 不可用时返回默认值 "ja"。
 *
 * 说明：
 *   - 白名单校验：localStorage 可被用户或旧版本代码写入任意值，
 *     若不校验会导致 translations[language] 取到 undefined 而整页崩溃。
 *   - try/catch：隐私模式或站点存储被禁用时 localStorage 访问会抛异常；
 *     本函数在渲染期被调用，抛错等同于整棵树挂掉，故必须吞掉。
 */
function readStoredLanguage(): Language {
  if (typeof window === "undefined") return "ja";
  try {
    const saved = window.localStorage.getItem("language");
    if (saved && ["ja", "zh", "en"].includes(saved)) {
      return saved as Language;
    }
  } catch {
    // 忽略：降级为默认语言
  }
  return "ja";
}

/**
 * 多语言 Provider。
 *
 * @param children 被包裹的子树。
 *
 * 内部状态：
 *   - language : 当前生效语言。**用 useState 惰性初始化直接从 localStorage 读取**，
 *                因此首帧就是最终语言，既无文案闪烁，也不需要"加载完成"标志位。
 *
 * 副作用：读写 localStorage["language"]。
 */
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // 修复：改为 useState 惰性初始化同步读取偏好，并删除 isLoaded 分支。
  // 原实现在 isLoaded 为 false（即首帧）时直接返回 <>{children}</> 而不挂载
  // Provider，导致首帧渲染的消费者（如 Dashboard）调用 useLanguage() 必然抛错。
  // 传函数引用（而非调用结果）给 useState —— 只在首次渲染求值一次。
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);

  /**
   * 切换语言。
   * @param lang 目标语言代码。
   * 副作用：同步更新 state 并持久化到 localStorage，刷新后保持不变。
   *         写入失败（隐私模式等）时只影响持久化，不影响本次会话的语言切换。
   */
  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem("language", lang);
    } catch {
      // 忽略：无法持久化时仍保证当前会话可正常切换
    }
  };

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
 * 注意：LanguageProvider 从**首次渲染**起就挂载 Context，
 * 因此只要组件位于 Provider 子树内，任何时刻调用本 Hook 都不会命中抛错分支。
 */
export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within LanguageProvider");
  }
  return context;
}
