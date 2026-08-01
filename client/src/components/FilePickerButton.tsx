/**
 * FilePickerButton —— 「一个按钮 + 一个隐藏 file input」的极简文件选择器（UI 组件层）
 *
 * ## 在架构中的位置
 * 属于**前端可复用组件层** (`client/src/components/`)。它与同目录的 `FileUploadBox`
 * 是互补关系：
 *   - `FileUploadBox`  —— 重量级面板，自己负责预览 + 上传 + LLM 分析；
 *   - `FilePickerButton` —— 轻量级，**只负责把 File 对象交出去**，不上传、不预览、
 *                          不持有任何 state，后续处理完全由父组件决定。
 *
 * ## 主要导出
 * - `default FilePickerButton`：完全受控的「哑」组件（除了一个 ref，无内部状态）。
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/pages/ChatPage.tsx`（聊天输入框旁的「图片/视频」小按钮，
 *   拿到 File 后自行走图像分析流程）。
 * - 下游依赖：`@/components/ui/button`（shadcn Button）。无网络调用。
 *
 * ## 关键设计决策
 * 1. **props 透传**：接口 `extends ComponentProps<typeof Button>`，剩余属性经
 *    `...buttonProps` 原样转发给 Button，因此调用方可以直接传 `variant` / `size` /
 *    `className` / `disabled` 等，无需本组件逐个中转。
 * 2. **不用 `<label htmlFor>` 而用 ref + click()**：因为要复用 shadcn Button 的样式与
 *    行为（它渲染的是 `<button>`），用 label 包裹会破坏按钮语义与键盘焦点表现。
 * 3. **每次选完就清空 input.value**：见 handleFileChange 注释，这是让「重复选择同一个
 *    文件」也能触发 onChange 的关键，`FileUploadBox` 恰恰漏了这一步。
 */
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { ComponentProps } from "react";

/**
 * FilePickerButton 的 props 契约。
 *
 * @property onFileSelect      **必填**。用户选中文件后的回调，参数为原始 File 对象。
 *                             多选场景下只回传第一个文件（本组件未开启 multiple）。
 * @property acceptedFileTypes 传给 `<input accept>` 的扩展名数组，默认常见图片 + mp4/webm。
 *                             注意 `accept` 只是系统选择器的**建议过滤器**，用户切到
 *                             「所有文件」仍可选任意类型，父组件不应把它当成安全校验。
 * @property label             按钮文案，默认日文「ファイルを選択」。
 *                             ⚠️ 本组件把 `{label}` 直接写成 Button 的 JSX 子节点，
 *                             而 JSX children 的优先级高于 `...buttonProps` 里透传的
 *                             `children`，因此调用方写在标签内部的图标会被**静默丢弃**
 *                             （ChatPage 的 Sparkles/Search 图标就是这样丢的，见 observations）。
 * @property ...               其余属性继承自 shadcn `Button`，原样透传。
 */
interface FilePickerButtonProps extends ComponentProps<typeof Button> {
  onFileSelect: (file: File) => void;
  acceptedFileTypes?: string[];
  label?: string;
}

/**
 * 渲染一个可自由定制样式的按钮，点击后打开系统文件选择器。
 *
 * @副作用 无网络/存储副作用，仅调用父组件传入的 onFileSelect。
 */
export default function FilePickerButton({
  onFileSelect,
  acceptedFileTypes = [".jpg", ".jpeg", ".png", ".gif", ".mp4", ".webm"],
  label = "ファイルを選択",
  ...buttonProps
}: FilePickerButtonProps) {
  // 指向下方那个被 display:none 隐藏的原生 <input type="file">。
  // 这是本组件唯一的"状态"，且刻意用 ref 而非 useState —— 它不参与渲染。
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 把可见按钮的点击"转发"给隐藏的 file input，从而弹出系统文件选择器。 */
  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  /**
   * file input 的 change 处理：取出第一个文件回调给父组件，然后**清空 input 的 value**。
   *
   * 为什么必须清空：原生 file input 只有在 value 发生变化时才触发 change。
   * 若用户第一次选了 a.png，关掉面板后又选同一个 a.png，value 没变 → change 不触发 →
   * 父组件收不到回调，表现为"点了没反应"。手动置空后每次选择都必然是一次变化。
   */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
    }
    // Reset input so the same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <>
      {/* type="button" 是必需的：默认的 type="submit" 会在表单内意外提交表单 */}
      <Button
        type="button"
        onClick={handleButtonClick}
        {...buttonProps}
      >
        {label}
      </Button>
      {/*
        隐藏的真实控件。用内联 display:none 而非 Tailwind 的 hidden 类，
        是为了避免调用方通过 buttonProps.className 之类的方式意外把它显示出来。
      */}
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptedFileTypes.join(",")}
        onChange={handleFileChange}
        style={{ display: "none" }}
      />
    </>
  );
}
