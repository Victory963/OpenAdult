/**
 * ManusDialog —— Manus OAuth 登录引导弹窗（UI 组件层 / 脚手架自带）
 *
 * ## 在架构中的位置
 * 属于**前端可复用组件层** (`client/src/components/`)，配套 `server/_core/oauth.ts`
 * 与 `server/_core/sdk.ts` 的 Manus OAuth 登录链路：当用户触碰到需要
 * `protectedProcedure` 的功能却尚未登录时，弹出本对话框把他引导去 OAuth 门户。
 *
 * ## 主要导出
 * - `ManusDialog`（**具名导出**，注意不是 default）：受控/非受控双模式的模态框。
 *
 * ## 上下游依赖
 * - 上游调用方：**当前代码库中无人引用**（`grep` 全仓无调用点）。这是 Manus 脚手架
 *   自带的模板组件，本项目实际的登录入口做在 `AdminLoginPage` 与各页面的按钮里，
 *   OAuth 跳转常量在 `client/src/const.ts`。属于可安全删除的死代码（见 observations）。
 * - 下游依赖：shadcn 的 Dialog 系列（Radix Dialog 封装）、Button。**不含任何网络调用** ——
 *   真正的跳转逻辑由调用方通过 `onLogin` 注入。
 *
 * ## 关键设计决策
 * 1. **受控 / 非受控双模式**：是否传 `onOpenChange` 决定由谁持有开关状态。
 *    传了 → 完全受控，`open` prop 说了算；没传 → 组件用内部 `internalOpen` 自管理，
 *    `open` 只作为初始值/外部同步源。判定依据是 `onOpenChange` 是否存在，
 *    而非 `open` 是否为 undefined（与 React 惯例略有出入，但避免了「传了 open 却没传
 *    onOpenChange 就永远关不掉」的死锁）。
 * 2. **样式全部为写死的浅色十六进制值**（#f8f8f7 / #34322d / #1a1a19 等），
 *    不走 Tailwind 主题变量，因此**不随本站的暗色主题切换**——这是 Manus 品牌弹窗
 *    刻意保持视觉一致的结果，但在本站深色界面上会显得突兀（见 observations）。
 * 3. 文案为英文硬编码，未接入 i18n。
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * ManusDialog 的 props 契约。
 *
 * @property title        标题文案；不传则整块标题不渲染（只留副标题）。
 * @property logo         方形 logo 图片 URL；不传则不渲染 logo 容器。
 * @property open         期望的打开状态，默认 false。
 *                        受控模式下是唯一真值来源；非受控模式下仅用于外部同步。
 * @property onLogin      **必填**。点击「Login with Manus」按钮的回调，
 *                        通常在此跳转到 `VITE_OAUTH_PORTAL_URL`。
 *                        ⚠️ 本组件点击后**不会自动关闭弹窗**，需调用方自行处理。
 * @property onOpenChange 传入即切换为受控模式；Radix 的开关变更（含 ESC、点遮罩）都会调它。
 * @property onClose      弹窗被关闭时的额外回调，两种模式下都会触发，
 *                        且在 `onOpenChange(false)` 之后调用。
 */
interface ManusDialogProps {
  title?: string;
  logo?: string;
  open?: boolean;
  onLogin: () => void;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
}

/**
 * 渲染 Manus 登录引导模态框。
 *
 * 内部状态：
 * - `internalOpen` —— **仅在非受控模式下生效**的开关状态。受控模式下它仍会被 setState
 *   更新逻辑绕过（见 handleOpenChange），渲染时也不会被读取。
 *
 * @副作用 无网络/存储副作用；所有行为通过回调交给调用方。
 */
export function ManusDialog({
  title,
  logo,
  open = false,
  onLogin,
  onOpenChange,
  onClose,
}: ManusDialogProps) {
  // useState(open) 只在首次挂载时取 open 作为初始值，之后 prop 变化不会自动同步，
  // 因此需要下面的 useEffect 补一条同步通路。
  const [internalOpen, setInternalOpen] = useState(open);

  // 非受控模式下把外部 `open` 的变化「镜像」进内部 state。
  // 触发时机：open 或 onOpenChange 引用变化时。
  // 守卫 `if (!onOpenChange)` 的意义：受控模式下内部 state 是无关变量，
  // 同步它纯属多余的 re-render。
  // ⚠️ 副作用：非受控模式下用户手动关掉弹窗（internalOpen=false）后，若父组件因任何
  //    原因重渲染且 open 仍为 true，这个 effect 并不会重跑（依赖没变），所以弹窗
  //    不会被"复活"——这是期望行为；但反过来，父组件想再次打开就必须先把 open 翻转
  //    成 false 再翻回 true（见 observations）。
  useEffect(() => {
    if (!onOpenChange) {
      setInternalOpen(open);
    }
  }, [open, onOpenChange]);

  /**
   * Radix Dialog 的开关变更统一入口（点遮罩、按 ESC、点关闭按钮都会走到这里）。
   *
   * 按受控/非受控分派：受控 → 把决定权交回父组件；非受控 → 自己改 state。
   * 无论哪种模式，只要是「关闭」这一方向，都额外触发 `onClose`，
   * 这样调用方可以只监听 onClose 而不必解析 onOpenChange 的布尔值。
   *
   * @param nextOpen Radix 给出的目标状态
   */
  const handleOpenChange = (nextOpen: boolean) => {
    if (onOpenChange) {
      onOpenChange(nextOpen);
    } else {
      setInternalOpen(nextOpen);
    }

    if (!nextOpen) {
      onClose?.();
    }
  };

  return (
    // 模式判定与 handleOpenChange 保持一致：以 onOpenChange 是否存在为准
    <Dialog
      open={onOpenChange ? open : internalOpen}
      onOpenChange={handleOpenChange}
    >
      {/*
        这一长串 className 是 Manus 品牌弹窗的像素级还原（固定 400px 宽、20px 圆角、
        #f8f8f7 米白底、8% 黑的细边与投影）。`p-0 gap-0` 先清空 shadcn DialogContent
        的默认内边距与栅格间距，再由下面两个子块自行控制留白。
        注意这些都是**写死的浅色值**，不随主题变化。
      */}
      <DialogContent className="py-5 bg-[#f8f8f7] rounded-[20px] w-[400px] shadow-[0px_4px_11px_0px_rgba(0,0,0,0.08)] border border-[rgba(0,0,0,0.08)] backdrop-blur-2xl p-0 gap-0 text-center">
        {/* pt-12 而非 pt-5：顶部留出额外空间，避开 Radix 自带的右上角关闭按钮 */}
        <div className="flex flex-col items-center gap-2 p-5 pt-12">
          {/* logo 可选：外层 64px 白底方块 + 内层 40px 图片，形成 App 图标式的留白 */}
          {logo ? (
            <div className="w-16 h-16 bg-white rounded-xl border border-[rgba(0,0,0,0.08)] flex items-center justify-center">
              <img
                src={logo}
                alt="Dialog graphic"
                className="w-10 h-10 rounded-md"
              />
            </div>
          ) : null}

          {/* Title and subtitle */}
          {/* ⚠️ DialogTitle 是条件渲染的：不传 title 时 Radix 会因缺少
              aria-labelledby 目标而在控制台报无障碍警告（见 observations）。
              副标题固定为英文引导语，不可配置。 */}
          {title ? (
            <DialogTitle className="text-xl font-semibold text-[#34322d] leading-[26px] tracking-[-0.44px]">
              {title}
            </DialogTitle>
          ) : null}
          <DialogDescription className="text-sm text-[#858481] leading-5 tracking-[-0.154px]">
            Please login with Manus to continue
          </DialogDescription>
        </div>

        <DialogFooter className="px-5 py-5">
          {/* Login button */}
          {/* 点击后只调 onLogin，不会自动关闭弹窗 —— 因为典型用法是整页跳转去 OAuth 门户，
              提前关闭反而会让用户在跳转前看到一次闪烁 */}
          <Button
            onClick={onLogin}
            className="w-full h-10 bg-[#1a1a19] hover:bg-[#1a1a19]/90 text-white rounded-[10px] text-sm font-medium leading-5 tracking-[-0.154px]"
          >
            Login with Manus
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
