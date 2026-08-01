/**
 * ============================================================================
 * client/src/lib/utils.ts — 通用前端工具函数 (UI 层 / 工具库)
 * ============================================================================
 *
 * 架构角色：
 *   shadcn/ui 体系约定的工具模块（components.json 中 aliases.utils 指向本文件）。
 *   `@/components/ui/*` 下的每个基础组件都会从这里导入 cn()。
 *
 * 主要导出物：
 *   - cn(...inputs) : 条件式 className 合并器。
 *
 * 上下游依赖：
 *   ← @/components/ui/* 全部 40+ 基础组件，以及业务组件与页面
 *   → clsx（条件类名求值）、tailwind-merge（Tailwind 冲突消解）
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 className，并消解 Tailwind 工具类之间的冲突。
 *
 * @param inputs 任意数量的 ClassValue：字符串、数组、`{ "cls": boolean }` 条件对象、
 *               以及 null / undefined / false（会被自动忽略）。
 * @returns 去重、去冲突后的 className 字符串。
 *
 * 为什么需要两层而不是只用 clsx：
 *   clsx 只负责把条件表达式摊平成字符串，它不理解 Tailwind 语义，
 *   `cn("p-2", "p-4")` 会得到 "p-2 p-4"——最终样式取决于 CSS 里两条规则的先后顺序，
 *   而非书写顺序，属于不可控行为。twMerge 认识 Tailwind 的工具类分组，
 *   会保留同组中**最后出现**的那个，得到确定的 "p-4"。
 *   这使得组件可以先写默认样式、再让调用方通过 props.className 覆盖。
 *
 * 无副作用（纯函数）。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
