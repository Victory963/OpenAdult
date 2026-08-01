/**
 * ============================================================================
 * client/src/hooks/usePersistFn.ts — 恒定引用回调 Hook (UI 层 / 自定义 Hook)
 * ============================================================================
 *
 * 架构角色：
 *   最底层的 Hook 工具，被其它 Hook 与组件复用。等价于社区常说的
 *   "useEventCallback" / "useMemoizedFn" 模式，也接近 React 官方尚未稳定的
 *   useEffectEvent 提案。
 *
 * 主要导出物：
 *   - usePersistFn(fn) : 返回一个引用永不变化、但内部始终执行最新 fn 的函数。
 *
 * 上下游依赖：
 *   ← client/src/hooks/useComposition.ts 及各业务组件
 *   → 仅依赖 react 的 useRef
 */

import { useRef } from "react";

/** 任意函数签名的占位类型；此处必须用 any 才能兼容任意参数/返回值的回调 */
type noop = (...args: any[]) => any;

/**
 * usePersistFn instead of useCallback to reduce cognitive load
 *
 * 把一个每次渲染都会重建的函数，包装成引用恒定的稳定函数。
 *
 * @param fn 本次渲染的最新回调，可自由闭包捕获 props/state，无需声明依赖数组。
 * @returns  一个在组件整个生命周期内 **引用不变** 的函数；调用它总是转发到最新的 fn。
 *
 * 相比 useCallback 的优势（也是本项目选它的原因）：
 *   useCallback 要求手写依赖数组，漏写会读到过期闭包、多写又会让引用频繁变化，
 *   进而击穿 React.memo 或让 useEffect 反复重跑。usePersistFn 用 ref 把
 *   "最新逻辑"与"稳定引用"解耦，调用方不再需要维护依赖数组——即注释所说的
 *   降低心智负担 (cognitive load)。
 *
 * 实现要点：
 *   1. fnRef.current = fn 在**渲染期**直接赋值（而非放进 useEffect），
 *      这样即使在同一次渲染中被子组件同步调用，拿到的也是本轮最新逻辑；
 *   2. persistFn 只在首次渲染时创建一次，之后 if 判断恒为 false，引用因此恒定；
 *   3. 用 function 声明 + apply(this, args) 而非箭头函数，是为了透传 this，
 *      使其也能安全地用作对象方法或 DOM 事件处理器。
 *
 * 注意：返回值不应放进依赖数组用于"触发"更新——它永远不变，
 * 因此永远不会让 useEffect 重跑（这正是它的设计目的）。
 */
export function usePersistFn<T extends noop>(fn: T) {
  // 每次渲染同步刷新，保证 persistFn 内部读到的永远是最新闭包
  const fnRef = useRef<T>(fn);
  fnRef.current = fn;

  // 惰性初始化：仅首次渲染创建包装函数，之后引用恒定
  const persistFn = useRef<T>(null);
  if (!persistFn.current) {
    persistFn.current = function (this: unknown, ...args) {
      return fnRef.current!.apply(this, args);
    } as T;
  }

  return persistFn.current!;
}
