/**
 * ============================================================================
 * client/src/hooks/useMobile.tsx — 移动端视口检测 Hook (UI 层 / 自定义 Hook)
 * ============================================================================
 *
 * 架构角色：
 *   shadcn/ui 标准配套 Hook，供需要在 JS 层面（而非纯 CSS 媒体查询）做分支的
 *   组件使用，典型场景是 Sidebar 在移动端改用抽屉式渲染、播放器控制条切换布局等。
 *
 * 主要导出物：
 *   - useIsMobile() : 返回当前视口是否为移动端宽度。
 *
 * 上下游依赖：
 *   ← @/components/ui/sidebar 等 shadcn 组件及部分业务组件
 *   → 浏览器 window.matchMedia API
 *
 * 说明：
 *   只在"需要改变 DOM 结构"时使用本 Hook；仅样式差异应优先用 Tailwind 的
 *   md: 等响应式前缀，避免不必要的 JS 重渲染。
 */

import * as React from "react";

/**
 * 移动端断点，单位 px。
 * 取 768 是为了与 Tailwind 默认的 `md` 断点 (min-width: 768px) 对齐，
 * 保证 JS 判定结果与 CSS 响应式类的生效范围完全一致，不会出现"CSS 已切换布局
 * 但 JS 仍认为是桌面端"的错位。
 */
const MOBILE_BREAKPOINT = 768;

/**
 * 判断当前视口是否处于移动端宽度（< 768px）。
 *
 * @returns boolean —— true 表示移动端。首帧尚未测量时返回 false（见下方说明）。
 *
 * 状态说明：
 *   isMobile 初始为 undefined 而非 false，用以区分"尚未测量"与"确定不是移动端"；
 *   但最终 return 处用 `!!` 把 undefined 折叠成 false，即**首帧一律按桌面端渲染**，
 *   effect 执行后若实为移动端会再触发一次重渲染。这可能造成移动端首帧闪烁，
 *   属于该模式的已知取舍（在 effect 之前无法安全访问 window）。
 *
 * useEffect 说明：
 *   - 依赖数组为空 → 仅在挂载时订阅一次，断点是常量、无需重订阅；
 *   - 订阅 matchMedia 的 change 事件而非 window.resize：前者仅在跨越断点时触发，
 *     避免拖拽窗口过程中产生大量无意义的 setState；
 *   - addEventListener 之后**立即**再调用一次 onChange 的等价逻辑做初始测量，
 *     因为 change 事件只在状态翻转时触发，不会为当前状态补发一次；
 *   - 清理函数移除监听，防止组件卸载后仍 setState 造成泄漏。
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(
    undefined
  );

  React.useEffect(() => {
    // -1 是为了与 CSS 断点严格互补：Tailwind 的 md 从 768px 起生效，
    // 故"移动端"区间是 max-width: 767px，两者不重叠也不留空隙。
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    // 挂载时补一次初始测量（change 事件不会为当前状态补发）
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // undefined（未测量）统一收敛为 false，让调用方无需处理三态
  return !!isMobile;
}
