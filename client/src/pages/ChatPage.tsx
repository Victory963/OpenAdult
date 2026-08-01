/**
 * ChatPage — AI 聊天推荐页（UI 层 / 页面组件）
 *
 * 架构角色：
 *   属于前端「页面」层，对应路由 `/chat`（在 client/src/App.tsx 中注册）。
 *   它是「自然语言检索 + 多模态检索」的统一入口：用户既可以用文字提问，
 *   也可以上传人脸图片做女优相似度检索，或上传任意图片/视频做图像检索。
 *
 * 主要导出：
 *   - default ChatPage — 整页组件，无 props，自带鉴权守卫（未登录直接渲染提示页）。
 *
 * 上游（谁渲染它）：
 *   client/src/App.tsx 的路由表；首页 Home.tsx 的入口按钮跳转到 `/chat`。
 *
 * 下游（它调用谁）：
 *   - trpc.chat.sendMessage      → server/routers.ts 的 chat 路由（protected，写 chat_messages 表 + 调 LLM）
 *   - trpc.chat.getHistory       → 拉取历史消息（protected）
 *   - trpc.search.faceSearch     → server/search.ts，人脸相似度检索（调 LLM 图像分析）
 *   - trpc.search.imageSearch    → server/search.ts，图像内容检索（调 LLM 打标签）
 *   - trpc.fileUpload.uploadFile → server/file-upload.ts，把 base64 内容写入 S3 并返回可访问 URL
 *   - 子组件 FileUploadBox / FilePickerButton
 *
 * 关键设计决策与坑：
 *   1. 消息列表是「本地 state + 服务端历史」的混合体：historyQuery 回来后会**整体覆盖**
 *      messages（见下方 useEffect），因此本地追加的检索结果卡片在历史刷新时会丢失。
 *   2. 消息 id 用 `Date.now()` 生成而非服务端主键 —— 仅用作 React list key，不参与任何持久化。
 *   3. 图片必须先上传到 S3 拿到公网 URL，再传给检索接口；后端 LLM 只接受 URL，不接受 base64。
 *   4. 文案全部为日语硬编码（本页未接入 LanguageContext）。
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Send, ArrowLeft, Image, Search, Sparkles, Grid3x3 } from "lucide-react";
import { useLocation } from "wouter";
import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Streamdown } from "streamdown";
import FileUploadBox from "@/components/FileUploadBox";
import FilePickerButton from "@/components/FilePickerButton";
import { useAuth } from "@/_core/hooks/useAuth";

/**
 * 聊天消息的前端视图模型（View Model）。
 *
 * 注意：这里的字段是「服务端历史记录」与「本地即时构造的检索结果」的并集：
 *   - id / role / content / createdAt：两者都有；
 *   - videos / actresses：仅本地构造的助手消息才有（服务端 chat_messages 表不持久化结构化结果），
 *     所以刷新页面后这些卡片会消失，只剩下纯文本正文。
 *
 * @property id         React list key，由 `Date.now()` 生成，非数据库主键
 * @property role       "user" = 用户提问气泡（右侧渐变），"assistant" = AI 回复气泡（左侧深色）
 * @property content    Markdown 文本，助手消息交给 <Streamdown> 渲染
 * @property videos     推荐/命中的视频卡片，点击跳转 `/video/:id`
 * @property actresses  推荐/命中的女优卡片，点击跳转 `/search?q=<名字>`；similarity 为 0~1 的相似度
 */
interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
  videos?: Array<{ id: number; title: string; thumbnailUrl?: string | null; category?: string | null; rating?: number | null }> | any[];
  actresses?: Array<{ id: number; name: string; profileImage?: string | null; similarity?: number }> | any[];
}

/**
 * AI 聊天推荐页组件。
 *
 * 权限：protected —— 依赖 `useAuth()` 的 isAuthenticated 做前端守卫；
 *       后端 chat.* 也是 protectedProcedure，因此绕过前端守卫仍会被拒。
 *
 * 内部状态职责：
 *   - messages        对话流（唯一渲染数据源）
 *   - inputValue      输入框受控值
 *   - isLoading       全局「请求中」互斥锁：同时禁用发送按钮、两个文件选择按钮，并显示「考え中...」气泡
 *   - showFileUpload  是否展开 FileUploadBox 拖拽上传面板
 *   - selectedFileUrl 记录最近一次上传成功的文件 URL（当前仅存储，未参与渲染或后续请求）
 *   - messagesEndRef  列表末尾哨兵节点，用于自动滚动到底部
 *
 * 副作用：写 chat_messages 表（经由 chat.sendMessage）、写 S3（经由 fileUpload.uploadFile）、
 *         触发服务端 LLM 调用。
 */
export default function ChatPage() {
  const { user, isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showFileUpload, setShowFileUpload] = useState(false);
  const [selectedFileUrl, setSelectedFileUrl] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // 四个 tRPC 端点各自独立 mutation：聊天、人脸检索、图像检索、文件上传
  const chatMutation = trpc.chat.sendMessage.useMutation();
  // limit: 50 —— 只回放最近 50 条，避免首屏渲染过多气泡
  const historyQuery = trpc.chat.getHistory.useQuery({ limit: 50 });
  const faceSearchMutation = trpc.search.faceSearch.useMutation();
  const imageSearchMutation = trpc.search.imageSearch.useMutation();
  const fileUploadMutation = trpc.fileUpload.uploadFile.useMutation();

  /**
   * 「顔認識」按钮的回调：上传人脸图片 → 调用人脸相似度检索 → 把结果作为一条助手消息插入对话流。
   *
   * 流程（三段式，缺一不可）：
   *   1. FileReader 把 File 读成 data URL，再切掉 `data:<mime>;base64,` 前缀取出纯 base64；
   *   2. fileUpload.uploadFile 把 base64 写入 S3，换回一个后端/CDN 可访问的 URL；
   *   3. search.faceSearch 拿该 URL 去做 LLM 图像分析 + 向量比对。
   * 之所以要先落 S3 而不是直接把 base64 发给检索接口，是因为后端 LLM 图像分析只接受 URL，
   * 且 base64 直传会撑爆 tRPC 请求体。
   *
   * @param file 用户从 FilePickerButton 选中的图片文件（jpg/jpeg/png/gif）
   * @returns void（结果通过 setMessages 副作用体现）
   * 副作用：写 S3；调用 LLM；追加 messages。失败时插入一条日语错误提示消息。
   */
  const handleFaceSearchFileSelect = async (file: File) => {
    try {
      setIsLoading(true);
      // Convert file to base64
      const reader = new FileReader();
      reader.onload = async (e) => {
        // readAsDataURL 的结果形如 "data:image/png;base64,AAAA..."，
        // 后端只要逗号后面的纯 base64 载荷，mime 另行通过 mimeType 字段传递
        const base64Data = (e.target?.result as string).split(",")[1];
        // 归一化为后端 fileType 枚举；非 image/video 一律落到 audio 分支
        const fileType = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "audio";
        
        try {
          // Upload file first
          const uploadResult = await fileUploadMutation.mutateAsync({
            filename: file.name,
            mimeType: file.type,
            fileData: base64Data,
            fileType: fileType as "image" | "video" | "audio",
          });
          // Then perform face search
          // threshold: 0.7 —— 人脸相似度下限（0~1）。这里取值比 FaceSearchPage 的 0.3 严格得多，
          // 因为聊天流里只应插入「高置信」结果，避免刷屏噪音
          const result = await faceSearchMutation.mutateAsync({
            imageUrl: uploadResult.url,
            threshold: 0.7,
          });
          const resultMessage: Message = {
            id: Date.now(),
            role: "assistant",
            content: `顔認識検索結果: ${result.message}`,
            createdAt: new Date(),
            actresses: result.actresses || [],
            videos: result.videos || [],
          };
          setMessages((prev) => [...prev, resultMessage]);
        } catch (error) {
          console.error("Face search error:", error);
          const errorMessage: Message = {
            id: Date.now(),
            role: "assistant",
            content: "顔認識に失敗しました。別の画像をお試しください。",
            createdAt: new Date(),
          };
          setMessages((prev) => [...prev, errorMessage]);
        } finally {
          setIsLoading(false);
        }
      };
      // 修复：注册 onerror/onabort 解除 isLoading 死锁。
      // readAsDataURL 是异步的，读取失败（文件被移除/无权限/超大）时 onload 永不触发，
      // 外层 try/catch 也捕获不到，会让 isLoading 永久停在 true —— 发送按钮与两个
      // 文件选择按钮被永久禁用，只能刷新页面恢复。
      reader.onerror = () => {
        console.error("File read error:", reader.error);
        const errorMessage: Message = {
          id: Date.now(),
          role: "assistant",
          content: "顔認識に失敗しました。別の画像をお試しください。",
          createdAt: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
        setIsLoading(false);
      };
      reader.onabort = () => {
        setIsLoading(false);
      };
      // 注意：readAsDataURL 是异步的，真正的业务逻辑都在上面的 onload 回调里，
      // 外层 try/catch 只能捕获 readAsDataURL 本身的同步异常
      reader.readAsDataURL(file);
    } catch (error) {
      console.error("File read error:", error);
      setIsLoading(false);
    }
  };

  /**
   * 「画像検索」按钮的回调：上传图片/短视频 → 调用图像内容检索 → 把命中结果摘要成一条助手消息。
   *
   * 与 handleFaceSearchFileSelect 的区别：
   *   - 走 search.imageSearch（按画面内容打标签匹配视频），而不是按人脸比对女优；
   *   - 接受的文件类型更宽（含 mp4/webm）；
   *   - 结果只渲染成纯文本摘要（标签列表 + 命中数量），不挂 videos/actresses 卡片。
   *
   * @param file 用户选中的图片或视频文件
   * 副作用：写 S3；调用 LLM 图像分析；追加 messages。
   */
  const handleImageSearchFileSelect = async (file: File) => {
    try {
      setIsLoading(true);
      // Convert file to base64
      const reader = new FileReader();
      reader.onload = async (e) => {
        // 同上：剥离 data URL 前缀，只保留 base64 载荷
        const base64Data = (e.target?.result as string).split(",")[1];
        const fileType = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "audio";
        
        try {
          // Upload file first
          const uploadResult = await fileUploadMutation.mutateAsync({
            filename: file.name,
            mimeType: file.type,
            fileData: base64Data,
            fileType: fileType as "image" | "video" | "audio",
          });
          // Then perform image search
          const result = await imageSearchMutation.mutateAsync({
            imageUrl: uploadResult.url,
          });
          const resultMessage: Message = {
            id: Date.now(),
            role: "assistant",
            content: `画像検索結果: ${result.message}\n\n分析タグ: ${(result.analysis.tags as string[])?.join(", ") || "なし"}\n見つかった動画: ${result.videos.length}本`,
            createdAt: new Date(),
          };
          setMessages((prev) => [...prev, resultMessage]);
        } catch (error) {
          console.error("Image search error:", error);
        } finally {
          setIsLoading(false);
        }
      };
      // 修复：同 handleFaceSearchFileSelect —— 异步读取失败必须解除 isLoading，
      // 否则整个输入区（发送 + 两个文件选择按钮）会被永久禁用
      reader.onerror = () => {
        console.error("File read error:", reader.error);
        setIsLoading(false);
      };
      reader.onabort = () => {
        setIsLoading(false);
      };
      reader.readAsDataURL(file);
    } catch (error) {
      console.error("File read error:", error);
      setIsLoading(false);
    }
  };

  // Load chat history
  // 触发时机：historyQuery 首次拿到数据、或任何原因导致该 query 重新 fetch 成功时。
  // 行为是「整体覆盖」而非合并 —— 一旦 history 被 invalidate/refetch，
  // 本地追加的检索结果消息（含 videos/actresses 卡片）会被服务端纯文本历史顶掉。
  // 无清理函数：纯 state 同步，不注册任何订阅。
  useEffect(() => {
    if (historyQuery.data) {
      setMessages(
        historyQuery.data.map((msg) => ({
          // 用 createdAt 的毫秒时间戳当 key（而非 msg.id），与本地 Date.now() 生成的 id 保持同一量纲
          id: new Date(msg.createdAt).getTime(),
          role: msg.role as "user" | "assistant",
          content: msg.content,
          createdAt: new Date(msg.createdAt),
        }))
      );
    }
  }, [historyQuery.data]);

  // Auto scroll to bottom
  // 触发时机：messages 数组引用变化（每次追加消息都会新建数组）。
  // 依赖整个 messages 而非 messages.length，因此历史覆盖时也会滚到底。
  // 无清理函数：scrollIntoView 是一次性命令式调用。
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /**
   * 表单提交回调：发送文本消息给 AI 并把回复追加到对话流。
   *
   * 采用「乐观追加」策略：先把用户气泡插入 UI，再等服务端回复，
   * 保证输入后立刻有视觉反馈。若请求失败，用户气泡会保留在界面上（不回滚）。
   *
   * @param e 表单 submit 事件，需 preventDefault 阻止页面刷新
   * 副作用：写 chat_messages 表；触发服务端 LLM；追加 messages；清空输入框。
   */
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    // 空白输入或上一次请求未结束时直接丢弃，避免并发请求打乱对话顺序
    if (!inputValue.trim() || isLoading) return;

    // タイムスタンプベースの一意なIDを生成
    const userId = Date.now();
    const userMessage: Message = {
      id: userId,
      role: "user",
      content: inputValue,
      createdAt: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue("");
    setIsLoading(true);

    try {
      const response = await chatMutation.mutateAsync({
        content: inputValue,
      });

      // アシスタントメッセージのIDもタイムスタンプベースで生成
      // +1 是为了在「用户消息与助手消息落在同一毫秒」时避开 React key 冲突
      const assistantId = Date.now() + 1;
      const assistantMessage: Message = {
        id: assistantId,
        role: "assistant",
        content: response.message,
        createdAt: new Date(),
        videos: response.videos || [],
        actresses: response.actresses || [],
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      console.error("Chat error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // 前端鉴权守卫：未登录直接渲染「需要登录」提示页，不渲染任何对话 UI。
  // 这只是体验优化，真正的访问控制由后端 protectedProcedure 保证。
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white mb-4">ログインが必要です</h1>
          <Button onClick={() => setLocation("/")} className="bg-gradient-to-r from-purple-600 to-pink-600">
            ホームに戻る
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/")}
              className="text-slate-400 hover:text-white"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div>
              <h1 className="text-xl font-bold text-white">AI検索アシスタント</h1>
              <p className="text-sm text-slate-400">
                Heretic LLM搭載 - 無検閲で理想の動画を検索
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Messages Container */}
      {/* 三态渲染：空对话 → 引导示例；有对话 → 气泡列表；请求中 → 末尾追加 loading 气泡 */}
      <div className="flex-1 overflow-y-auto max-w-4xl mx-auto w-full px-4 py-8">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-6xl mb-4">💬</div>
            <h2 className="text-2xl font-bold text-white mb-2">
              何かお探しですか？
            </h2>
            <p className="text-slate-400 mb-8 max-w-md">
              「最近人気の熟女もの」「〇〇に似た女優の動画」など、自然言語で検索できます。
            </p>
            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-6 max-w-md text-left">
              <p className="text-sm text-slate-300 mb-3 font-semibold">例：</p>
              <ul className="space-y-2 text-sm text-slate-400">
                <li>• 「最近人気の熟女ものを探してます」</li>
                <li>• 「巨乳で中出しシーンが多い動画」</li>
                <li>• 「〇〇に似た女優の作品」</li>
                <li>• 「新作で評価が高いもの」</li>
              </ul>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${
                  message.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-2xl lg:max-w-3xl px-4 py-3 rounded-lg ${
                    message.role === "user"
                      ? "bg-gradient-to-r from-purple-600 to-pink-600 text-white"
                      : "bg-slate-800 text-slate-100 border border-slate-700"
                  }`}
                >
                  {/* 助手消息走 Markdown 渲染并可附带结构化卡片；用户消息只渲染纯文本，
                      避免用户输入的 Markdown/HTML 被解析（XSS 面） */}
                  {message.role === "assistant" ? (
                    <div>
                      <Streamdown>{message.content}</Streamdown>
                      
                      {/* Display recognized/recommended actresses */}
                      {message.actresses && message.actresses.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-slate-700">
                          <h4 className="text-sm font-semibold mb-3 text-slate-200">🎭 おすすめ女優</h4>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            {message.actresses.map((actress) => (
                              <div key={actress.id} onClick={() => setLocation(`/search?q=${encodeURIComponent(actress.name)}`)} className="bg-slate-700/50 rounded p-2 text-center cursor-pointer hover:bg-slate-600/50 transition">
                                {actress.profileImage && (
                                  <img src={actress.profileImage} alt={actress.name} className="w-full h-24 object-cover rounded mb-2" />
                                )}
                                <p className="text-xs font-semibold text-slate-100">{actress.name}</p>
                                {actress.similarity && (
                                  <p className="text-xs text-slate-400">相似度: {(actress.similarity * 100).toFixed(1)}%</p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {/* Display recommended videos */}
                      {/* 最多渲染 9 条（3x3 网格），并用 max-h-64 + 内部滚动限制高度，
                          防止单条助手消息把整个对话流撑得过长 */}
                      {message.videos && message.videos.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-slate-700">
                          <h4 className="text-sm font-semibold mb-3 text-slate-200">🎬 関連動画 ({message.videos.length}本)</h4>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-64 overflow-y-auto">
                            {message.videos.slice(0, 9).map((video) => (
                              <div key={video.id} onClick={() => setLocation(`/video/${video.id}`)} className="bg-slate-700/50 rounded overflow-hidden hover:bg-slate-600/50 transition cursor-pointer group">
                                {video.thumbnailUrl && (
                                  <div className="relative h-24 overflow-hidden">
                                    <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover group-hover:scale-105 transition" />
                                    {video.rating && (
                                      <div className="absolute top-1 right-1 bg-yellow-500/80 text-xs font-bold px-1.5 py-0.5 rounded">★{Number(video.rating).toFixed(1)}</div>
                                    )}
                                  </div>
                                )}
                                <div className="p-2">
                                  <p className="text-xs font-semibold text-slate-100 line-clamp-2">{video.title}</p>
                                  {video.category && (
                                    <p className="text-xs text-slate-400 mt-1">{video.category}</p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm">{message.content}</p>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-slate-800 border border-slate-700 text-slate-100 px-4 py-3 rounded-lg flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">考え中...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="border-t border-slate-800 bg-slate-950/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 py-4">
          {/* File Upload Box */}
          {showFileUpload && (
            <div className="mb-4 pb-4 border-b border-slate-800">
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-sm font-semibold text-white">ファイルをアップロード</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowFileUpload(false)}
                  className="text-slate-400 hover:text-white"
                >
                  ✕
                </Button>
              </div>
              {/* maxFileSize: 100 (MB)、acceptedFileTypes 与后端 file-upload 路由的校验保持一致；
                  上传成功后若后端附带了 LLM 图像分析结果，直接作为一条助手消息回显 */}
              <FileUploadBox
                onFileUpload={(fileUrl, fileKey, analysisData) => {
                  console.log("File uploaded:", fileUrl, fileKey, analysisData);
                  setSelectedFileUrl(fileUrl);
                  if (analysisData && analysisData.analysis) {
                    const analysisMessage: Message = {
                      id: messages.length,
                      role: "assistant",
                      content: `**画像分析結果:**\n\n${analysisData.analysis}`,
                      createdAt: new Date(),
                    };
                    setMessages((prev) => [...prev, analysisMessage]);
                  }
                  setShowFileUpload(false);
                }}
                maxFileSize={100}
                acceptedFileTypes={[".jpg", ".jpeg", ".png", ".gif", ".mp4", ".webm", ".pdf"]}
              />
            </div>
          )}
          
          {/* 输入区四件套：①切换上传面板 ②人脸识别检索 ③图像检索 ④文本输入 + 发送 */}
          <form onSubmit={handleSendMessage} className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setShowFileUpload(!showFileUpload)}
              title="ファイルをアップロード"
              className="text-slate-400 hover:text-white border-slate-700 hover:bg-slate-800"
            >
              <Image className="w-5 h-5" />
            </Button>
            <FilePickerButton
              onFileSelect={handleFaceSearchFileSelect}
              acceptedFileTypes={[".jpg", ".jpeg", ".png", ".gif"]}
              label="顔認識"
              variant="outline"
              size="sm"
              disabled={isLoading}
              className="text-slate-400 hover:text-white border-slate-700 hover:bg-slate-800 gap-1"
            >
              <Sparkles className="w-4 h-4" />
            </FilePickerButton>
            <FilePickerButton
              onFileSelect={handleImageSearchFileSelect}
              acceptedFileTypes={[".jpg", ".jpeg", ".png", ".gif", ".mp4", ".webm"]}
              label="画像検索"
              variant="outline"
              size="sm"
              disabled={isLoading}
              className="text-slate-400 hover:text-white border-slate-700 hover:bg-slate-800 gap-1"
            >
              <Search className="w-4 h-4" />
            </FilePickerButton>
            <Input
              type="text"
              placeholder="検索クエリを入力..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              disabled={isLoading}
              className="flex-1 bg-slate-800 border-slate-700 text-white placeholder-slate-500 focus:border-purple-500"
            />
            <Button
              type="submit"
              disabled={isLoading || !inputValue.trim()}
              className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white px-6"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
