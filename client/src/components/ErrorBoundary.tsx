/**
 * ErrorBoundary —— 全局渲染错误兜底组件（前端基础设施层）
 *
 * ## 在架构中的位置
 * 挂在 `client/src/App.tsx` 的**最外层**，包住所有 Context Provider 与路由。
 * 任何 Provider 初始化失败、页面组件渲染抛错、生命周期抛错，都会在这里被截住，
 * 换成一个可读的错误页而不是白屏。
 *
 * ## 主要导出
 * - `default ErrorBoundary`：React **class 组件**（这是硬性要求 —— React 至今没有
 *   函数组件版的 error boundary API，`getDerivedStateFromError` / `componentDidCatch`
 *   只存在于 class 上，所以整个代码库里这是少数几个非函数组件之一）。
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/App.tsx`（唯一使用者）。
 * - 下游依赖：`@/lib/utils` 的 `cn()`、lucide 图标。**无 tRPC、无网络调用** ——
 *   这是刻意的：兜底组件本身必须尽可能不可能失败。
 *
 * ## 边界与坑
 * 1. **捕获范围有限**。error boundary 只捕获「渲染期 / 生命周期 / 构造函数」中抛出的错误，
 *    以下场景**捕获不到**：事件处理器里的异常、setTimeout/Promise 等异步回调、
 *    SSR 期间的错误、以及 boundary 自身渲染时抛的错误。tRPC 请求失败属于异步，
 *    通常由各页面的 `isError` 分支或 sonner toast 处理，不会走到这里。
 * 2. **没有实现 `componentDidCatch`**，因此错误不会被上报到任何监控后端，
 *    只在页面上把 stack 打印给用户看（生产环境会暴露源码结构，见 observations）。
 * 3. **不可恢复**。状态一旦置为 hasError 就没有复位路径，唯一出口是「刷新整页」按钮。
 *    这是有意为之：局部重试很可能立刻再次抛同样的错，整页 reload 才能保证状态干净。
 * 4. 界面文案是英文硬编码，未接入 i18n —— 同理，兜底页不应该依赖可能已经崩掉的
 *    `LanguageContext`。
 */
import { cn } from "@/lib/utils";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, ReactNode } from "react";

/** @property children 被保护的子树；崩溃时整棵子树会被错误页替换掉。 */
interface Props {
  children: ReactNode;
}

/**
 * @property hasError 是否已进入错误态（决定渲染子树还是错误页）。
 * @property error    捕获到的 Error 实例，仅用于展示 `error.stack`。
 *                    单独留 hasError 而不直接判 `error !== null`，是为了兼容
 *                    抛出的值不是 Error 对象（如 `throw "boom"`）的情况。
 */
interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  /**
   * React 在子树渲染抛错时调用，返回值会被合并进 state（属于「渲染阶段」，
   * 因此必须是纯函数：不能在这里做日志上报、埋点等副作用 —— 那是
   * `componentDidCatch`（提交阶段）的职责，本组件未实现。
   *
   * @param error 子树抛出的错误对象
   * @returns 新的 state，令下一次 render 走错误页分支
   */
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    // 错误态：渲染全屏兜底页，彻底丢弃原子树（不再尝试渲染 children，
    // 否则会立刻再次抛出同样的错误，陷入死循环）。
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen p-8 bg-background">
          <div className="flex flex-col items-center w-full max-w-2xl p-8">
            <AlertTriangle
              size={48}
              className="text-destructive mb-6 flex-shrink-0"
            />

            <h2 className="text-xl mb-4">An unexpected error occurred.</h2>

            {/*
              直接把完整调用栈渲染给用户：开发期定位问题极方便，
              但生产环境会泄露打包后的文件名与函数名（见 observations）。
              `overflow-auto` + `whitespace-break-spaces` 保证长栈既能横向滚动
              也能自动折行，不会把页面撑宽。
              可选链 `?.` 是必要的 —— 若抛出的不是 Error 实例则没有 stack 属性。
            */}
            <div className="p-4 w-full rounded bg-muted overflow-auto mb-6">
              <pre className="text-sm text-muted-foreground whitespace-break-spaces">
                {this.state.error?.stack}
              </pre>
            </div>

            {/*
              整页 reload 而非 setState 复位：错误往往源自被污染的全局/Context 状态，
              只重置 boundary 自身通常会立即二次崩溃。
              这里用原生 <button> 而非 shadcn Button，同样是为了减少兜底页的依赖面。
            */}
            <button
              onClick={() => window.location.reload()}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg",
                "bg-primary text-primary-foreground",
                "hover:opacity-90 cursor-pointer"
              )}
            >
              <RotateCcw size={16} />
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    // 正常态：完全透明地透传子树，boundary 自身不产生任何 DOM 包裹层，
    // 因此不会影响子组件的布局（flex/grid 的父子关系保持原样）。
    return this.props.children;
  }
}

export default ErrorBoundary;
