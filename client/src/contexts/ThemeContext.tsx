/**
 * ============================================================================
 * client/src/contexts/ThemeContext.tsx — 主题上下文 (UI 层 / 全局 Context)
 * ============================================================================
 *
 * 架构角色：
 *   全局外观状态的唯一来源。通过在 <html> 根元素上增删 `dark` class 与
 *   Tailwind 4 的暗色变体联动——所有组件只需写 `dark:` 前缀即可响应主题，
 *   无需读取本 Context。只有"主题切换按钮"这类组件才需要 useTheme()。
 *
 * 主要导出物：
 *   - ThemeProvider : Provider 组件，在 App.tsx 中以 defaultTheme="dark" 挂载
 *   - useTheme()    : 消费 Hook，返回 { theme, toggleTheme?, switchable }
 *
 * 上下游依赖：
 *   ← client/src/App.tsx（挂载 Provider）
 *   ← 需要读取/切换主题的组件
 *   → document.documentElement（写 class）、localStorage（持久化）
 *
 * 关键设计决策：
 *   引入 `switchable` 开关，把"支持切换"与"仅锁定某一主题"两种模式合一。
 *   本站当前以暗色为品牌基调，App.tsx 未传 switchable（默认 false），
 *   因此主题被锁死在 dark，toggleTheme 为 undefined —— 这是刻意的：
 *   类型上的可选性会强制调用方处理"不可切换"的情况。
 */

import React, { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";

/**
 * Context 值契约。
 * @property theme       当前生效主题。
 * @property toggleTheme 切换函数；**仅当 switchable 为 true 时存在**，否则为 undefined。
 * @property switchable  当前是否允许切换，供 UI 决定是否渲染切换按钮。
 */
interface ThemeContextType {
  theme: Theme;
  toggleTheme?: () => void;
  switchable: boolean;
}

// 初始值刻意设为 undefined，使 useTheme 能识别"未被 Provider 包裹"并抛出明确错误
const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/**
 * ThemeProvider 的 props 契约。
 * @property children     被包裹的子树。
 * @property defaultTheme 默认主题；switchable 时仅作为 localStorage 无值时的回退，
 *                        不可切换时则是被锁定的最终主题。默认 "light"
 *                        （注意本站在 App.tsx 显式传入 "dark" 覆盖了它）。
 * @property switchable   是否允许运行时切换并持久化，默认 false。
 */
interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  switchable?: boolean;
}

/**
 * 主题 Provider。
 *
 * 副作用：读写 localStorage["theme"]；直接操作 <html> 的 class 列表。
 */
export function ThemeProvider({
  children,
  defaultTheme = "light",
  switchable = false,
}: ThemeProviderProps) {
  // 惰性初始化（传函数而非直接求值）：localStorage 是同步 I/O，
  // 只在首次挂载时读取一次，避免每次重渲染都白白访问一遍。
  // 不可切换模式下完全跳过读取，直接采用 defaultTheme。
  const [theme, setTheme] = useState<Theme>(() => {
    if (switchable) {
      const stored = localStorage.getItem("theme");
      // 这里对 stored 只做类型断言、未做取值白名单校验；
      // 若 localStorage 被写入非法值，会得到既非 light 也非 dark 的 theme。
      return (stored as Theme) || defaultTheme;
    }
    return defaultTheme;
  });

  // 把主题同步到 DOM 与持久化存储。
  // 之所以操作 documentElement 而非某个容器：Tailwind 4 的暗色变体默认基于
  // 祖先链上的 .dark，挂在 <html> 上才能覆盖 Portal 渲染的内容
  // （Radix 的 Dialog / Tooltip 会挂到 <body> 之外的容器，不在 React 树的 DOM 位置内）。
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }

    // 不可切换时不写 localStorage，以免"锁定主题"污染用户此前保存的偏好
    if (switchable) {
      localStorage.setItem("theme", theme);
    }
  }, [theme, switchable]);

  // 不可切换时返回 undefined 而非空函数：让消费方能通过 `toggleTheme ?? ...`
  // 或可选调用明确区分"不支持切换"，而不是调用了一个静默无效的函数。
  // 注意此处未用 useCallback，每次渲染都会生成新引用；由于 Provider 位于树顶
  // 且极少重渲染，影响可忽略。
  const toggleTheme = switchable
    ? () => {
        setTheme(prev => (prev === "light" ? "dark" : "light"));
      }
    : undefined;

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, switchable }}>
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * 读取主题上下文。
 *
 * @returns { theme, toggleTheme?, switchable }
 * @throws  Error("useTheme must be used within ThemeProvider")
 *          —— 组件未被 ThemeProvider 包裹时抛出。这是刻意的快速失败设计：
 *          相比静默返回默认值，直接抛错能在开发阶段立刻暴露 Provider 缺失，
 *          而不是让页面带着错误主题运行。
 */
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
