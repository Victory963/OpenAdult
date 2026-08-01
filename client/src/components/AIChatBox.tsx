/**
 * ============================================================================
 * client/src/components/AIChatBox.tsx — 通用 AI 聊天框（UI 组件层 / 纯受控组件）
 * ============================================================================
 *
 * ## 架构定位
 * 属于**前端组件层**（client/src/components/），是一个**完全受控（controlled）的展示组件**：
 * 它自己不持有对话历史、不调用 tRPC、不认识 LLM，只负责「渲染 messages + 把用户输入抛出去」。
 * 会话状态与 LLM 调用一律由调用方（页面）持有 —— 这样同一个组件既能接推荐聊天，
 * 也能接组件展示页的假数据。
 *
 * ## 主要导出
 * - `Message`     — 与服务端 `invokeLLM` 的消息结构一致的类型（role + content）
 * - `AIChatBoxProps` — props 契约（见类型内逐字段注释）
 * - `AIChatBox`   — 聊天框组件本体
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/pages/ComponentShowcase.tsx`
 *   （`ChatPage.tsx` 使用的是自己的聊天实现，未复用本组件）
 * - 下游依赖：
 *   - `streamdown` 的 `Streamdown` —— 渲染 assistant 消息中的 Markdown（支持流式增量文本）
 *   - `@/components/ui/scroll-area`（Radix ScrollArea 封装）、`textarea`、`button`
 *
 * ## ⚠️ 关键设计决策与坑
 * 1. **Message 类型必须与服务端保持一致**（server/_core/llm.ts 的 Message），
 *    这样页面可以把 `messages` 原样透传给 tRPC mutation，无需做格式转换。
 * 2. **system 消息不渲染**：它是给模型看的指令，展示出来会泄露 prompt。
 * 3. **「最后一条消息撑最小高度」的技巧**：给最后一条消息（或 loading 指示器）设一个
 *    动态 min-height，使得刚发出的用户消息能被顶到视口顶部，模拟 ChatGPT 的阅读体验。
 *    该高度只在挂载时算一次，容器尺寸后续变化不会重算（见 observations）。
 * 4. **滚动容器不是 scrollAreaRef 本身**：Radix ScrollArea 真正滚动的是内部
 *    `[data-radix-scroll-area-viewport]` 节点，必须查询到它才能 scrollTo。
 */
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Loader2, Send, User, Sparkles } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { Streamdown } from "streamdown";

/**
 * Message type matching server-side LLM Message interface
 *
 * 与服务端 `invokeLLM()` 所接受的消息结构完全对齐，因此调用方可以把这个数组
 * 原封不动地传给 tRPC mutation，中间无需任何映射。
 * - `system`    — 系统提示词，**不会在 UI 中显示**（会被 displayMessages 过滤掉）
 * - `user`      — 用户输入，右对齐、纯文本渲染（保留换行）
 * - `assistant` — 模型回复，左对齐、按 Markdown 渲染
 */
export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * AIChatBox 的 props 契约。
 * 必填只有 `messages` 与 `onSendMessage`，其余均有默认值。
 */
export type AIChatBoxProps = {
  /**
   * Messages array to display in the chat.
   * Should match the format used by invokeLLM on the server.
   *
   * 完整对话历史（含 system）。组件只读不写；其中 role === "system" 的条目会被过滤不显示。
   */
  messages: Message[];

  /**
   * Callback when user sends a message.
   * Typically you'll call a tRPC mutation here to invoke the LLM.
   *
   * 用户提交时触发，参数是**已 trim 的**输入文本。
   * 调用方需自行把它 append 进 messages 并发起 LLM 请求 —— 组件不会自动追加消息。
   */
  onSendMessage: (content: string) => void;

  /**
   * Whether the AI is currently generating a response
   *
   * 为 true 时：显示旋转 loading 气泡、禁用发送按钮与建议问题按钮、阻止重复提交。
   */
  isLoading?: boolean;

  /**
   * Placeholder text for the input field
   */
  placeholder?: string;

  /**
   * Custom className for the container
   */
  className?: string;

  /**
   * Height of the chat box (default: 600px)
   *
   * 必须是**确定值**（不能是 auto/百分比且父级无高度），因为「顶到视口顶部」的
   * min-height 计算依赖容器实际高度；高度不确定时该效果会失效。
   */
  height?: string | number;

  /**
   * Empty state message to display when no messages
   *
   * 无消息时的引导文案。
   */
  emptyStateMessage?: string;

  /**
   * Suggested prompts to display in empty state
   * Click to send directly
   *
   * 仅在空态展示的建议问题；点击**直接调用 onSendMessage**，不经过输入框。
   */
  suggestedPrompts?: string[];
};

/**
 * A ready-to-use AI chat box component that integrates with the LLM system.
 *
 * Features:
 * - Matches server-side Message interface for seamless integration
 * - Markdown rendering with Streamdown
 * - Auto-scrolls to latest message
 * - Loading states
 * - Uses global theme colors from index.css
 *
 * ---
 * 中文说明：开箱即用的 AI 聊天框（**受控组件**）。
 *
 * 职责边界：只做「渲染 + 收集输入」，**不持有对话历史、不调用任何 API**。
 * 消息数组、loading 标志、LLM 请求全部由调用方管理，因此同一组件可服务于
 * 不同的后端 procedure（推荐聊天 / 演示数据 / 未来的其它场景）。
 *
 * 内部状态仅一个 `input`（输入框草稿）；另有一个派生的 `minHeightForLastMessage`
 * 用于实现「发送后把用户消息顶到视口顶部」的阅读体验（详见组件内 effect 注释）。
 *
 * @param props 见 `AIChatBoxProps`
 * @副作用 无网络/存储副作用；仅操作 DOM 滚动位置与输入框焦点
 * @权限 无（纯展示组件，权限由调用方页面控制）
 *
 * @example
 * ```tsx
 * const ChatPage = () => {
 *   const [messages, setMessages] = useState<Message[]>([
 *     { role: "system", content: "You are a helpful assistant." }
 *   ]);
 *
 *   const chatMutation = trpc.ai.chat.useMutation({
 *     onSuccess: (response) => {
 *       // Assuming your tRPC endpoint returns the AI response as a string
 *       setMessages(prev => [...prev, {
 *         role: "assistant",
 *         content: response
 *       }]);
 *     },
 *     onError: (error) => {
 *       console.error("Chat error:", error);
 *       // Optionally show error message to user
 *     }
 *   });
 *
 *   const handleSend = (content: string) => {
 *     const newMessages = [...messages, { role: "user", content }];
 *     setMessages(newMessages);
 *     chatMutation.mutate({ messages: newMessages });
 *   };
 *
 *   return (
 *     <AIChatBox
 *       messages={messages}
 *       onSendMessage={handleSend}
 *       isLoading={chatMutation.isPending}
 *       suggestedPrompts={[
 *         "Explain quantum computing",
 *         "Write a hello world in Python"
 *       ]}
 *     />
 *   );
 * };
 * ```
 */
export function AIChatBox({
  messages,
  onSendMessage,
  isLoading = false,
  placeholder = "Type your message...",
  className,
  height = "600px",
  emptyStateMessage = "Start a conversation with AI",
  suggestedPrompts,
}: AIChatBoxProps) {
  // 唯一的内部状态：输入框草稿。对话历史由调用方持有，本组件不缓存任何消息
  const [input, setInput] = useState("");
  /** 消息滚动区外层容器；真正滚动的是它内部的 Radix viewport 节点 */
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  /** 整个聊天框最外层，用于测量总高度 */
  const containerRef = useRef<HTMLDivElement>(null);
  /** 底部输入表单，用于测量其高度以推算消息区可用高度 */
  const inputAreaRef = useRef<HTMLFormElement>(null);
  /** 输入框本体，发送后回焦，让用户可以连续输入而不必再点一次 */
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Filter out system messages
  // system 消息是给模型的指令（prompt），渲染出来会泄露内部提示词，因此一律过滤
  const displayMessages = messages.filter((msg) => msg.role !== "system");

  // Calculate min-height for last assistant message to push user message to top
  // 该值用于给「最后一条消息」撑出一个最小高度，从而把刚发出的用户消息顶到视口顶部
  const [minHeightForLastMessage, setMinHeightForLastMessage] = useState(0);

  // ── 计算「最后一条消息」的最小高度 ────────────────────────────────────────
  // 为什么需要：ChatGPT 式的阅读体验是——用户一发消息，该消息就跳到视口顶部，
  // 下方留出整屏空白等待模型回复。要做到这点，就得让最后一个块级元素至少有
  // 「一屏 - 用户消息占位」这么高，滚动到底时才能把用户消息顶上去。
  //
  // 空依赖数组：只在挂载时测一次。下面的常量都是对 Tailwind class 的硬编码换算，
  // 改了外层的 p-4 / space-y-4 就必须同步改这里的数字。
  useEffect(() => {
    if (containerRef.current && inputAreaRef.current) {
      const containerHeight = containerRef.current.offsetHeight;
      const inputHeight = inputAreaRef.current.offsetHeight;
      // 消息区可用高度 = 聊天框总高 - 底部输入区高度
      const scrollAreaHeight = containerHeight - inputHeight;

      // Reserve space for:
      // - padding (p-4 = 32px top+bottom)
      // - user message: 40px (item height) + 16px (margin-top from space-y-4) = 56px
      // Note: margin-bottom is not counted because it naturally pushes the assistant message down
      //
      // 数字来源（均为 Tailwind class 的换算值，非任意魔法数）：
      //   32 = p-4 的上下内边距各 16px
      //   56 = 单行用户消息约 40px + space-y-4 产生的 16px 上外边距
      const userMessageReservedHeight = 56;
      const calculatedHeight = scrollAreaHeight - 32 - userMessageReservedHeight;

      // 兜底 0：容器很矮（或测量时尚未布局完成）时算出负数会让 minHeight 失效
      setMinHeightForLastMessage(Math.max(0, calculatedHeight));
    }
  }, []);

  // Scroll to bottom helper function with smooth animation
  /**
   * 平滑滚动消息区到底部。
   *
   * 两个非显而易见之处：
   * 1. 必须先查询 `[data-radix-scroll-area-viewport]` —— Radix ScrollArea 的滚动发生在
   *    这个内部节点上，对外层容器调 scrollTo 完全无效。
   * 2. 包一层 requestAnimationFrame —— 发送消息后 DOM 尚未完成本帧布局，
   *    立刻读 scrollHeight 拿到的是旧值，会滚不到真正的底部。
   */
  const scrollToBottom = () => {
    const viewport = scrollAreaRef.current?.querySelector(
      '[data-radix-scroll-area-viewport]'
    ) as HTMLDivElement;

    if (viewport) {
      requestAnimationFrame(() => {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: 'smooth'
        });
      });
    }
  };

  /**
   * 发送消息。
   *
   * @param e submit 事件（也可能来自 handleKeyDown 转发的键盘事件）
   * @副作用 调用 `onSendMessage` 回调（由调用方决定是否发起 LLM 请求）、清空草稿、滚动到底、回焦输入框
   * @remarks 空白输入或正在加载时直接 return，避免重复提交
   */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedInput = input.trim();
    if (!trimmedInput || isLoading) return;

    onSendMessage(trimmedInput);
    setInput("");

    // Scroll immediately after sending
    scrollToBottom();

    // Keep focus on input
    textareaRef.current?.focus();
  };

  /**
   * 键盘快捷键：Enter 发送，Shift+Enter 换行。
   *
   * @remarks ⚠️ 未处理输入法组合态（IME composition）。日文/中文输入时按 Enter 确认候选词
   *          会被当成「发送」，导致半成品文本被提交。项目里已有 `@/hooks/useComposition`
   *          专门解决该问题，但本组件未接入（见 observations）。
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex flex-col bg-card text-card-foreground rounded-lg border shadow-sm",
        className
      )}
      style={{ height }}
    >
      {/* Messages Area */}
      {/* 空态与列表态走两套完全不同的结构：空态是居中的引导页（不需要滚动容器），
          有消息时才挂载 ScrollArea */}
      <div ref={scrollAreaRef} className="flex-1 overflow-hidden">
        {displayMessages.length === 0 ? (
          <div className="flex h-full flex-col p-4">
            <div className="flex flex-1 flex-col items-center justify-center gap-6 text-muted-foreground">
              <div className="flex flex-col items-center gap-3">
                <Sparkles className="size-12 opacity-20" />
                <p className="text-sm">{emptyStateMessage}</p>
              </div>

              {suggestedPrompts && suggestedPrompts.length > 0 && (
                <div className="flex max-w-2xl flex-wrap justify-center gap-2">
                  {suggestedPrompts.map((prompt, index) => (
                    <button
                      key={index}
                      onClick={() => onSendMessage(prompt)}
                      disabled={isLoading}
                      className="rounded-lg border border-border bg-card px-4 py-2 text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="flex flex-col space-y-4 p-4">
              {displayMessages.map((message, index) => {
                // Apply min-height to last message only if NOT loading (when loading, the loading indicator gets it)
                // 撑高职责在「最后一个可见块」上：加载中时该角色由下方的 loading 指示器承担，
                // 若两者同时设 minHeight，会一次性撑出两屏空白
                const isLastMessage = index === displayMessages.length - 1;
                const shouldApplyMinHeight =
                  isLastMessage && !isLoading && minHeightForLastMessage > 0;

                return (
                  <div
                    key={index}
                    className={cn(
                      "flex gap-3",
                      message.role === "user"
                        ? "justify-end items-start"
                        : "justify-start items-start"
                    )}
                    style={
                      shouldApplyMinHeight
                        ? { minHeight: `${minHeightForLastMessage}px` }
                        : undefined
                    }
                  >
                    {message.role === "assistant" && (
                      <div className="size-8 shrink-0 mt-1 rounded-full bg-primary/10 flex items-center justify-center">
                        <Sparkles className="size-4 text-primary" />
                      </div>
                    )}

                    <div
                      className={cn(
                        "max-w-[80%] rounded-lg px-4 py-2.5",
                        message.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground"
                      )}
                    >
                      {/* assistant 回复走 Markdown 渲染（Streamdown 能容忍未闭合的流式片段）；
                          user 输入按纯文本渲染，仅用 whitespace-pre-wrap 保留换行，
                          绝不解析 Markdown —— 避免用户输入影响排版 */}
                      {message.role === "assistant" ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <Streamdown>{message.content}</Streamdown>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap text-sm">
                          {message.content}
                        </p>
                      )}
                    </div>

                    {message.role === "user" && (
                      <div className="size-8 shrink-0 mt-1 rounded-full bg-secondary flex items-center justify-center">
                        <User className="size-4 text-secondary-foreground" />
                      </div>
                    )}
                  </div>
                );
              })}

              {isLoading && (
                <div
                  className="flex items-start gap-3"
                  style={
                    minHeightForLastMessage > 0
                      ? { minHeight: `${minHeightForLastMessage}px` }
                      : undefined
                  }
                >
                  <div className="size-8 shrink-0 mt-1 rounded-full bg-primary/10 flex items-center justify-center">
                    <Sparkles className="size-4 text-primary" />
                  </div>
                  <div className="rounded-lg bg-muted px-4 py-2.5">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Input Area */}
      {/* 用 <form> 而非 div：既能拿到原生 submit 语义（回车/按钮统一走 handleSubmit），
          也便于上面的 effect 通过 inputAreaRef 测量它的实际高度 */}
      <form
        ref={inputAreaRef}
        onSubmit={handleSubmit}
        className="flex gap-2 p-4 border-t bg-background/50 items-end"
      >
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          // rows=1 + min-h-9 起步为单行；max-h-32（128px）封顶，长文本内部滚动，
          // 防止输入区无限增高把消息区挤没
          className="flex-1 max-h-32 resize-none min-h-9"
          rows={1}
        />
        <Button
          type="submit"
          size="icon"
          disabled={!input.trim() || isLoading}
          className="shrink-0 h-[38px] w-[38px]"
        >
          {isLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </form>
    </div>
  );
}
