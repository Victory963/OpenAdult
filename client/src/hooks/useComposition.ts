/**
 * ============================================================================
 * client/src/hooks/useComposition.ts — 输入法 (IME) 组合状态 Hook (UI 层)
 * ============================================================================
 *
 * 架构角色：
 *   输入控件的行为适配层。本站主要面向日语/中文用户，搜索框与 AI 聊天框都是
 *   "回车即提交"，若不区分 IME 组合状态，用户在候选词阶段按回车（本意是确认选字）
 *   就会误触发送——这是中日韩输入场景的经典 bug。本 Hook 统一解决该问题。
 *
 * 主要导出物：
 *   - useComposition(options)   : 返回一组需要展开到 <input>/<textarea> 上的事件处理器
 *   - UseCompositionOptions<T>  : 入参类型，允许透传用户自己的事件回调
 *   - UseCompositionReturn<T>   : 返回值类型
 *
 * 上下游依赖：
 *   ← AIChatBox、搜索输入框等含"回车提交"语义的组件
 *   → ./usePersistFn（保证返回的处理器引用恒定，可安全展开给 memo 化子组件）
 *
 * 关键设计决策：
 *   浏览器对 compositionend 与 keydown 的触发顺序并不一致：
 *   Chrome/Firefox 中 keydown(229) 先于 compositionend；而 Safari 上
 *   compositionend 会**先**于确认用的那次 keydown 触发。若在 compositionend
 *   里同步把标志位置为 false，Safari 随后到来的 Enter 就会被误判为"提交"。
 *   因此这里用嵌套的两层 setTimeout 把复位推迟到当前宏任务队列之后。
 */

import { useRef } from "react";
import { usePersistFn } from "./usePersistFn";

/** useComposition 的返回值契约：前三项直接展开到输入元素上，isComposing 供业务判断 */
export interface UseCompositionReturn<
  T extends HTMLInputElement | HTMLTextAreaElement,
> {
  onCompositionStart: React.CompositionEventHandler<T>;
  onCompositionEnd: React.CompositionEventHandler<T>;
  onKeyDown: React.KeyboardEventHandler<T>;
  /** 读取当前是否处于 IME 组合中；读的是 ref，不会因状态变化触发重渲染 */
  isComposing: () => boolean;
}

/**
 * useComposition 的可选入参：调用方原有的事件处理器。
 * 本 Hook 采用"包装 + 转发"策略，这些回调会在内部逻辑处理完后被调用，
 * 因此调用方无需放弃自己的事件逻辑。
 */
export interface UseCompositionOptions<
  T extends HTMLInputElement | HTMLTextAreaElement,
> {
  onKeyDown?: React.KeyboardEventHandler<T>;
  onCompositionStart?: React.CompositionEventHandler<T>;
  onCompositionEnd?: React.CompositionEventHandler<T>;
}

/** 兼容浏览器(number)与 Node(Timeout 对象)两种 setTimeout 返回值类型 */
type TimerResponse = ReturnType<typeof setTimeout>;

/**
 * 让输入框正确识别 IME 组合状态，避免候选词阶段的 Enter/Escape 被误当作提交/关闭。
 *
 * @param options 可选的原生事件回调，会被透传调用；默认空对象。
 * @returns 三个事件处理器 + isComposing 查询函数。典型用法：
 *          `const c = useComposition<HTMLTextAreaElement>({ onKeyDown: handleKey });`
 *          `<textarea {...c} />`
 *
 * 内部状态（全部用 ref，刻意不用 useState —— 组合状态变化不应引发重渲染，
 * 且事件回调需要同步读到最新值）：
 *   - c      : 是否正处于 IME 组合中；
 *   - timer  : 外层复位定时器句柄；
 *   - timer2 : 内层复位定时器句柄。
 *
 * 无网络/存储副作用；仅操作定时器。
 */
export function useComposition<
  T extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement,
>(options: UseCompositionOptions<T> = {}): UseCompositionReturn<T> {
  const {
    onKeyDown: originalOnKeyDown,
    onCompositionStart: originalOnCompositionStart,
    onCompositionEnd: originalOnCompositionEnd,
  } = options;

  const c = useRef(false); // c = composing，当前是否处于输入法组合中
  const timer = useRef<TimerResponse | null>(null);
  const timer2 = useRef<TimerResponse | null>(null);

  // 组合开始：必须先撤销上一轮尚未执行的"延迟复位"定时器。
  // 场景：用户连续输入两个词，第二次 compositionstart 可能早于第一次的复位回调，
  // 若不清除，稍后那个回调会把正在进行的组合状态错误地置为 false。
  const onCompositionStart = usePersistFn((e: React.CompositionEvent<T>) => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (timer2.current) {
      clearTimeout(timer2.current);
      timer2.current = null;
    }
    c.current = true;
    originalOnCompositionStart?.(e);
  });

  // 组合结束：延迟复位标志位，而不是立即置 false。
  const onCompositionEnd = usePersistFn((e: React.CompositionEvent<T>) => {
    // 使用两层 setTimeout 来处理 Safari 浏览器中 compositionEnd 先于 onKeyDown 触发的问题
    // 为什么是"两层"而不是一层：Safari 的确认键 keydown 落在 compositionend 之后的
    // 下一个宏任务里，单层 setTimeout(0) 与该 keydown 处于同一批次、先后顺序不稳定；
    // 再嵌套一层可确保复位一定发生在那次 keydown **之后**，从而不会误提交。
    // 两个 setTimeout 都不传延时（等价 0ms）—— 目的是"排到队尾"而非真的等待某个时长。
    timer.current = setTimeout(() => {
      timer2.current = setTimeout(() => {
        c.current = false;
      });
    });
    originalOnCompositionEnd?.(e);
  });

  // 键盘事件拦截器：组合期间吞掉"确认/取消"语义的按键。
  const onKeyDown = usePersistFn((e: React.KeyboardEvent<T>) => {
    // 在 composition 状态下，阻止 ESC 和 Enter（非 shift+Enter）事件的冒泡
    // - Enter  ：候选词确认键，若放行会被上层当成"发送消息/提交搜索"；
    // - Escape ：取消候选词，若放行会被上层当成"关闭弹窗/清空输入"；
    // - shift+Enter 例外：它在 IME 中不表示确认，且业务上代表"换行"，需正常透传。
    // 这里用 stopPropagation 而非 preventDefault —— 必须保留浏览器默认行为
    // （让输入法完成选字），只是不让事件继续冒泡到外层处理器；随后 return，
    // 也不调用调用方的 originalOnKeyDown。
    if (
      c.current &&
      (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey))
    ) {
      e.stopPropagation();
      return;
    }
    originalOnKeyDown?.(e);
  });

  // 暴露为函数而非布尔值：调用方在事件回调里调用时才读取 ref 的即时值，
  // 若直接返回 c.current 会在渲染时被"快照"成过期的布尔量。
  const isComposing = usePersistFn(() => {
    return c.current;
  });

  return {
    onCompositionStart,
    onCompositionEnd,
    onKeyDown,
    isComposing,
  };
}
