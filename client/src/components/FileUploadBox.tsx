/**
 * FileUploadBox —— 拖拽式文件上传面板（UI 组件层）
 *
 * ## 在架构中的位置
 * 属于**前端可复用组件层** (`client/src/components/`)，是 ChatPage 的子组件。
 * 它把「选文件 → 本地预览 → Base64 编码 → tRPC 上传 → （图片额外）LLM 分析」
 * 这一整条链路封装成一个自包含的面板，父组件只需提供一个 `onFileUpload` 回调。
 *
 * ## 主要导出
 * - `default FileUploadBox`：唯一导出，受控程度很低的「自管理」组件
 *   （选中的文件、预览、进度全部是内部 state，父组件拿不到也不用管）。
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/pages/ChatPage.tsx`（在聊天框上方展开的上传面板）。
 * - 下游依赖：
 *   - `trpc.fileUpload.uploadFile`  (protected mutation) → S3 写入 + user_uploads 建记录
 *   - `trpc.fileUpload.analyzeImage`(protected mutation) → 调用多模态 LLM 描述图片
 *   - `sonner` 的 toast 做全部用户反馈（本组件不向父级抛错）
 *
 * ## 关键设计决策与坑
 * 1. **Base64 over tRPC**：文件通过 `FileReader.readAsDataURL` 转成 Base64 再走
 *    JSON body 上传，而不是 multipart。好处是复用现成的 tRPC 类型链路、无需额外
 *    REST 端点；代价是 payload 膨胀约 33%，且整份文件常驻内存 —— 所以默认
 *    `maxFileSize` 只有 100MB，真正的大视频走的是 `video-upload-v2` 分片通道。
 * 2. **图片自动分析**：上传成功后若判定为 image，会立刻再打一次 LLM。分析失败
 *    **不阻断**流程，仍会把上传结果回调给父组件（只是少了 analysisData）。
 *    判定依据是**文件真实 MIME**（而非 `getFileType()` 的三分类兜底值），
 *    这样 PDF 等非图片类型不会被误送去视觉分析。
 * 3. **文案全为日语硬编码**，未接入 `LanguageContext` 的 i18n（见 observations）。
 * 4. 进度条是**模拟**的，不是真实上传进度（tRPC JSON mutation 拿不到 upload
 *    progress 事件）；模拟定时器在 mutation 发起**之前**启动、在 finally 与
 *    组件卸载时清理（见 handleUpload 注释）。
 */
import React, { useEffect, useRef, useState } from "react";
import { Upload, X, Image, Video, File } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

/**
 * FileUploadBox 的 props 契约。
 *
 * @property onFileUpload      上传（及图片分析）完成后的回调。
 *                             实参顺序：第 1 个是 S3 公开 URL，第 2 个是 S3 对象键
 *                             `fileKey`（形如 `uploads/<uid>/<ts>-<name>`）；
 *                             第 3 个 `analysisData` 仅在「图片且 LLM 分析成功」时才有值，
 *                             其中的 `fileType` 字段才是粗分类（image/video/audio）。
 *                             修复：形参名原为 `fileType`，与三处调用点实际传入的
 *                             `data.fileKey` 不符，此处按真实语义更名为 `fileKey`。
 * @property maxFileSize       单文件大小上限，单位 **MB**（默认 100）。仅做前端拦截，
 *                             服务端未做等价校验。
 * @property acceptedFileTypes 传给 `<input accept>` 的扩展名数组。**只影响系统文件选择器
 *                             的过滤**，拖拽路径完全不校验扩展名。
 */
interface FileUploadBoxProps {
  // 修复：第 2 个形参实际传的是 S3 对象键，原名 `fileType` 会误导父组件，改名为 `fileKey`
  onFileUpload?: (fileUrl: string, fileKey: string, analysisData?: any) => void;
  maxFileSize?: number; // in MB
  acceptedFileTypes?: string[];
}

/**
 * 渲染一个「空态拖拽区」/「已选文件卡片」二选一的上传面板。
 *
 * 内部状态职责划分：
 * - `fileInputRef`   —— 指向隐藏的 `<input type="file">`，点击拖拽区时用它触发系统选择器。
 * - `selectedFile`   —— 当前待上传的文件；它同时也是**视图切换开关**：
 *                       null → 显示拖拽区，非 null → 显示文件卡片。
 * - `preview`        —— 图片时为 base64 data URL（直接喂给 `<img src>`）；
 *                       视频时为哨兵字符串 `"video"`（占位图分支），其他类型为空串。
 * - `isUploading`    —— 上传中标志，用于禁用按钮 + 显示进度条。
 * - `uploadProgress` —— 0~100 的模拟进度百分比。
 *
 * @副作用 调用两个 tRPC mutation（写 S3 / 写库 / 调 LLM），并弹出 toast。
 */
export default function FileUploadBox({
  onFileUpload,
  maxFileSize = 100,
  acceptedFileTypes = [".jpg", ".jpeg", ".png", ".gif", ".mp4", ".webm", ".pdf"],
}: FileUploadBoxProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string>("");
  // 修复：模拟进度定时器句柄改用 ref 持有，才能在 finally 与组件卸载时可靠清理
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 停止模拟进度定时器（幂等，可重复调用） */
  const stopProgressSimulation = () => {
    if (progressTimerRef.current !== null) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  };

  // 修复：组件卸载时清理模拟进度定时器，避免对已卸载组件调用 setState
  useEffect(() => {
    return () => {
      if (progressTimerRef.current !== null) {
        clearInterval(progressTimerRef.current);
        progressTimerRef.current = null;
      }
    };
  }, []);

  // 两个 protected mutation：未登录时调用会被 tRPC 中间件拒绝（UNAUTHORIZED）。
  // 这里用 mutateAsync 而非 mutate，是为了在 handleUpload 里用 try/catch 串行编排。
  const uploadFileMutation = trpc.fileUpload.uploadFile.useMutation();
  const analyzeImageMutation = trpc.fileUpload.analyzeImage.useMutation();

  /**
   * 上传成功后的收尾流程：先无条件复位 UI，再按类型决定是否追加 LLM 分析。
   *
   * 之所以**先复位再分析**，是因为分析可能耗时数秒，先把面板清空能让用户
   * 立刻继续做别的事；分析结果稍后通过 `onFileUpload` 回调补送给父组件。
   *
   * @param data     `uploadFile` mutation 的返回值 `{ success, url, fileKey, filename }`
   * @param fileType 由 `getFileType()` 推断出的粗分类（image/video/audio）
   * @param mimeType 浏览器给出的**原始 MIME**，用于判定是否值得走视觉分析
   * @副作用 可能触发一次 LLM 调用（analyzeImage）；触发父组件的 onFileUpload 回调。
   */
  const handleUploadSuccess = async (
    data: any,
    fileType: string,
    mimeType: string
  ) => {
    toast.success("ファイルアップロード成功");
    setUploadProgress(0);
    setIsUploading(false);
    setSelectedFile(null);
    setPreview("");

    // 仅图片走 LLM 视觉分析：视频/音频当前后端虽有 analyzeVideo 过程，
    // 但本组件不调用（成本高且需要抽帧），故直接把 URL 回调出去即可。
    // 修复：判定依据从 fileType 改为**原始 MIME**。getFileType() 对 PDF 等
    //       非 image/video/audio 类型会兜底返回 "image"（因为后端 enum 只有三个值），
    //       原判定会把 PDF 送进 analyzeImage，白白消耗一次多模态调用且必然失败。
    // 画像の場合は自動的に分析を実行
    if (fileType === "image" && mimeType.startsWith("image/")) {
      try {
        // loading toast 无自动关闭时间，必须靠下面的 toast.dismiss() 手动收掉。
        // 注意 dismiss() 不带 id 会关闭**页面上所有** toast（见 observations）。
        toast.loading("画像を分析中...");
        const analysisResult = await analyzeImageMutation.mutateAsync({
          imageUrl: data.url,
          prompt: "この画像について詳しく説明してください。含まれている人物、物、シーン、テキストなど、見えるすべてのものを分析してください。",
        });
        toast.dismiss();
        toast.success("画像分析完了");
        // 第三个参数 analysisData 里额外塞了 timestamp，方便父组件（ChatPage）
        // 把这条分析结果当作一条带时间戳的消息插进聊天流。
        // 分析結果をコールバックに渡す（URLと分析結果を含める）
        onFileUpload?.(data.url, data.fileKey, {
          analysis: analysisResult.analysis,
          fileType: "image",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        // 降级路径：分析失败不算上传失败，文件已经在 S3 上了，
        // 所以照样把 URL 回调出去，只是没有 analysisData。
        toast.error("画像分析に失敗しました");
        // 分析失敗時も、アップロード結果は渡す
        onFileUpload?.(data.url, data.fileKey);
      }
    } else {
      onFileUpload?.(data.url, data.fileKey);
    }
  };

  /**
   * 根据浏览器给出的 MIME type 推断服务端需要的粗分类。
   *
   * 服务端 `uploadFile` 的 `fileType` 入参是 `z.enum(["image","video","audio"])`，
   * 不接受第四种值，所以这里必须收敛成三选一 —— 对 PDF 等既不属于三者的类型，
   * 兜底返回 "image" 只是为了通过服务端校验；**是否走视觉分析请勿依赖本函数的返回值**，
   * 改用文件原始 MIME 判定（见 handleUploadSuccess）。
   */
  const getFileType = (file: File): "image" | "video" | "audio" => {
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "audio";
    return "image"; // default
  };

  /**
   * 选中文件后的统一入口（点击选择与拖拽放下都走这里）：校验大小 → 存 state → 生成预览。
   *
   * @param file 用户通过 `<input>` 或拖拽提供的 File 对象
   */
  const handleFileSelect = (file: File) => {
    // maxFileSize 以 MB 为单位，这里换算成字节：MB × 1024（KB）× 1024（B）。
    // 提前拦截可以避免把大文件读成 Base64 撑爆浏览器内存。
    // ファイルサイズチェック
    if (file.size > maxFileSize * 1024 * 1024) {
      toast.error(`ファイルサイズが大きすぎます（最大${maxFileSize}MB）`);
      return;
    }

    setSelectedFile(file);

    // 预览生成策略按类型分叉：
    //   - 图片：读成 data URL 直接内联渲染（不用 URL.createObjectURL，因而无需手动 revoke）；
    //   - 视频：只放哨兵值 "video"，渲染一个静态占位图 —— 生成视频首帧要走 canvas 抽帧，
    //           成本高且此处没必要；
    //   - 其他（如 PDF）：不设预览，`preview` 保持空串，卡片里只显示文件名+图标。
    // プレビュー生成
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setPreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    } else if (file.type.startsWith("video/")) {
      setPreview("video"); // ビデオの場合はプレースホルダー
    }
  };

  /**
   * dragover 必须 `preventDefault()`，否则浏览器默认行为会拒绝放下（drop 事件根本不触发）。
   * `stopPropagation()` 防止事件冒泡到外层容器导致整页被当成拖拽目标。
   */
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  /**
   * 处理拖拽放下：同样要阻止默认行为（否则浏览器会直接在新标签页打开该文件）。
   * 只取 `files[0]` —— 本组件是单文件上传，多选时静默忽略其余文件。
   *
   * 注意：此路径**不校验** `acceptedFileTypes`，只有大小校验（在 handleFileSelect 内）。
   */
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileSelect(files[0]);
    }
  };

  /**
   * 执行上传：读文件 → 剥离 data URL 前缀 → 调用 `uploadFile` mutation → 收尾。
   *
   * 整个过程包在 `FileReader.onload` 回调里，所以本函数虽然标了 async，
   * 但它返回的 Promise **在上传真正完成之前就已经 resolve 了**
   * （await 点在回调内部，而回调不是被 await 的）。调用方不能靠 `await handleUpload()`
   * 来判断上传是否结束，只能观察 `isUploading` state。
   *
   * @副作用 写 S3、写 user_uploads 表、可能触发 LLM；全程用 toast 反馈。
   */
  const handleUpload = async () => {
    if (!selectedFile) {
      toast.error("ファイルを選択してください");
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    // ファイルをBase64に変換
    const reader = new FileReader();
    reader.onload = async (e) => {
      // readAsDataURL 的结果形如 "data:image/png;base64,iVBORw0KGgo..."，
      // 服务端只要逗号后面的纯 Base64 载荷，所以按 "," split 取 [1]。
      const base64Data = (e.target?.result as string).split(",")[1];
      const fileType = getFileType(selectedFile);
      const mimeType = selectedFile.type;

      // 「模拟」进度条：tRPC 的 JSON mutation 拿不到 XHR 的 upload progress 事件，
      // 所以用定时器伪造一个递增百分比。
      //   - 200ms  = 刷新间隔，肉眼观感流畅又不至于频繁 re-render；
      //   - +0~30% = 每步随机增量，让进度看起来"不匀速"更像真实网络；
      //   - 封顶 90% = 故意不到 100%，留最后 10% 给真正的完成事件，
      //                避免"进度满了但还没好"的违和感。
      // 修复：这段原本写在 try/catch **之后**，上传早已结束才开始跑（此时 isUploading
      //       已置回 false、进度条已从 DOM 卸载，用户全程看不到进度），且只在 prev>=90
      //       时才 clearInterval，组件提前卸载就会泄漏。现改为在 mutateAsync **之前**
      //       启动，并在 finally 中无条件停止（卸载时另有 useEffect 兜底清理）。
      // プログレス表示（シミュレーション）
      stopProgressSimulation();
      progressTimerRef.current = setInterval(() => {
        setUploadProgress((prev) => {
          if (prev >= 90) {
            stopProgressSimulation();
            return 90;
          }
          return prev + Math.random() * 30;
        });
      }, 200);

      try {
        // アップロード
        const uploadResult = await uploadFileMutation.mutateAsync({
          filename: selectedFile.name,
          mimeType,
          fileData: base64Data,
          fileType,
        });

        // 上传真正完成：先停掉模拟进度并补满到 100%，再进入收尾（可能耗时数秒的 LLM 分析）
        stopProgressSimulation();
        setUploadProgress(100);

        // アップロード成功後、分析を実行
        await handleUploadSuccess(uploadResult, fileType, mimeType);
      } catch (error) {
        toast.error(`アップロード失敗: ${error instanceof Error ? error.message : "不明なエラー"}`);
        setUploadProgress(0);
        setIsUploading(false);
      } finally {
        stopProgressSimulation();
      }
    };
    reader.readAsDataURL(selectedFile);
  };

  /** 按 MIME 大类挑选卡片左侧的图标；未知类型退化为通用 File 图标。 */
  const getFileIcon = (file: File) => {
    if (file.type.startsWith("image/")) return <Image className="w-8 h-8" />;
    if (file.type.startsWith("video/")) return <Video className="w-8 h-8" />;
    return <File className="w-8 h-8" />;
  };

  return (
    <div className="w-full">
      {/* 视图二选一：selectedFile 为空 → 拖拽投放区；有值 → 已选文件详情卡片 */}
      {!selectedFile ? (
        <div
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className="border-2 border-dashed border-gray-400 rounded-lg p-8 text-center hover:border-blue-500 transition-colors cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="w-12 h-12 mx-auto mb-4 text-gray-400" />
          <p className="text-lg font-semibold mb-2">ファイルをアップロード</p>
          <p className="text-sm text-gray-500 mb-4">
            ドラッグ&ドロップまたはクリックして選択
          </p>
          <p className="text-xs text-gray-400">
            対応形式: 画像、ビデオ、音声（最大{maxFileSize}MB）
          </p>
          {/*
            隐藏的原生 file input：整个虚线框的 onClick 通过 ref 代为触发它，
            这样就能自定义外观而不必与浏览器默认的丑陋控件搏斗。
            与 FilePickerButton 一致：每次 change 后都把 value 清空，
            否则「选 a.png → 点 X 取消 → 再选 a.png」时 value 未变、change 不触发，
            表现为「点了没反应」。
          */}
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptedFileTypes.join(",")}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                handleFileSelect(file);
              }
              // 修复：重置 value，保证重复选择同一个文件仍能触发 change
              e.target.value = "";
            }}
            className="hidden"
          />
        </div>
      ) : (
        <div className="border-2 border-gray-300 rounded-lg p-6">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-4">
              <div className="text-blue-500">
                {getFileIcon(selectedFile)}
              </div>
              <div className="flex-1">
                <p className="font-semibold truncate">{selectedFile.name}</p>
                <p className="text-sm text-gray-500">
                  {(selectedFile.size / 1024 / 1024).toFixed(2)}MB
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                setSelectedFile(null);
                setPreview("");
                setUploadProgress(0);
              }}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* 图片预览：preview 为 data URL 时才渲染（排除 "video" 哨兵值） */}
          {preview && preview !== "video" && (
            <div className="mb-4">
              <img
                src={preview}
                alt="プレビュー"
                className="max-h-48 rounded-lg object-cover"
              />
            </div>
          )}

          {/* 视频占位图：哨兵值分支，不做真实首帧抽取 */}
          {preview === "video" && (
            <div className="mb-4 bg-gray-100 rounded-lg h-32 flex items-center justify-center">
              <Video className="w-12 h-12 text-gray-400" />
            </div>
          )}

          {/* 进度条仅在 isUploading 期间挂载；宽度由 uploadProgress 百分比驱动 */}
          {isUploading && (
            <div className="mb-4">
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-sm text-gray-500 mt-2">
                アップロード中... {Math.round(uploadProgress)}%
              </p>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleUpload}
              disabled={isUploading}
              className="flex-1"
            >
              {isUploading ? "アップロード中..." : "アップロード"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setSelectedFile(null);
                setPreview("");
                setUploadProgress(0);
              }}
              disabled={isUploading}
            >
              キャンセル
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
