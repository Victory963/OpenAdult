/**
 * FaceSearchPage — 女优相似度检索页（UI 层 / 页面组件）
 *
 * 架构角色：
 *   前端「页面」层，对应路由 `/face-search`。提供两种互斥的检索模式：
 *     - "name"  按女优名检索（默认模式）：返回相似女优列表 + 该女优的出演视频
 *     - "image" 按人脸图片检索：先把图片落 S3，再交给后端做 LLM 面部特征分析并比对
 *
 * 主要导出：
 *   - default FaceSearchPage — 无 props 的整页组件。
 *
 * 上游：client/src/App.tsx 路由表；ChatPage / Home 的入口按钮。
 * 下游：
 *   - trpc.fileUpload.uploadFile     → server/file-upload.ts（写 S3，返回可访问 URL）
 *   - trpc.faceSearch.searchByImage  → server/routers/faceSearch.ts（调 LLM 图像分析 + 向量比对，写 face_search_history）
 *   - trpc.faceSearch.searchByName   → server/routers/faceSearch.ts（按名字模糊匹配 + 关联视频）
 *
 * 关键设计决策与坑：
 *   1. 项目不使用 face-api.js（Node 端无 DOM），改由 LLM 提取面部特征描述再比对，
 *      因此「相似度」是语义相似度而非几何特征距离，阈值语义与传统人脸库不同（见 CLAUDE.md）。
 *   2. 两种模式的结果结构不同（name → { actresses, videos }，image → { matches, analysis }），
 *      下方用 results / actressResults / videoResults 三个派生变量把差异收敛到一处，
 *      让后面的 JSX 只写一套渲染逻辑。
 *   3. 两种模式的结果各自存在独立 state，切换模式不会清空对方的结果（有意保留，便于来回对比）。
 */
import { useState, useRef } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, Upload, Search, Play, Clock, Eye } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

/**
 * 女优相似度检索页组件。
 *
 * 权限：public —— 页面本身不做登录守卫；`user?.id` 只是作为可选参数传给后端用于
 *       记录 face_search_history，未登录时为 undefined，检索照常可用。
 *
 * 内部状态职责：
 *   - searchMode    当前检索模式（"name" | "image"），决定输入区与结果区的渲染分支
 *   - imagePreview  选中图片的 data URL：既用于右侧缩略图预览，也是上传时 base64 的来源
 *                   （所以它同时承担「预览」和「待上传数据」两个角色）
 *   - actressName   名字检索的受控输入
 *   - isLoading     检索中标志，驱动按钮禁用与全屏 loading 卡片
 *   - nameResults   名字检索结果 { actresses, videos, message }
 *   - imageResults  图片检索结果 { matches, analysis, message }
 *   - fileInputRef  隐藏的 <input type="file">，由自定义按钮 click() 代理触发
 *
 * 副作用：写 S3（图片模式）、调 LLM（图片模式）、写 face_search_history（后端侧）。
 */
export default function FaceSearchPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [searchMode, setSearchMode] = useState<"image" | "name">("name");
  const [imagePreview, setImagePreview] = useState<string>("");
  const [actressName, setActressName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [nameResults, setNameResults] = useState<any>(null);
  const [imageResults, setImageResults] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const searchByImageMutation = trpc.faceSearch.searchByImage.useMutation();
  const searchByNameMutation = trpc.faceSearch.searchByName.useMutation();
  const uploadFileMutation = trpc.fileUpload.uploadFile.useMutation();

  /**
   * 文件选择回调：只负责生成本地预览，**不做上传**。
   * 真正的上传推迟到用户点击「画像で検索」时（见 handleSearchByImage），
   * 避免用户反复换图产生大量无用的 S3 对象。
   *
   * @param e file input 的 change 事件
   * 副作用：设置 imagePreview（data URL 字符串）
   */
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Show preview
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImagePreview(ev.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  /**
   * 执行「按图片检索」：上传 → 检索 → 渲染结果 + toast 反馈。
   *
   * 权限：public procedure；`userId` 传入后后端会写一条 face_search_history。
   * 副作用：写 S3；调 LLM 图像分析；更新 imageResults；弹 toast。
   * 抛错：所有异常统一被 catch 成 toast.error，不向上冒泡。
   */
  const handleSearchByImage = async () => {
    if (!imagePreview) {
      toast.error("画像を選択してください");
      return;
    }

    setIsLoading(true);
    // 先清空旧结果，避免新检索期间界面还停留在上一次的匹配列表上
    setImageResults(null);
    try {
      // Upload image to S3 first
      // imagePreview 形如 "data:image/xxx;base64,AAAA..."，取逗号后的纯 base64 载荷。
      // 文件名带时间戳保证 S3 key 唯一，避免并发检索互相覆盖。
      const base64Data = imagePreview.split(",")[1];
      const uploadResult = await uploadFileMutation.mutateAsync({
        filename: `face-search-${Date.now()}.jpg`,
        fileData: base64Data,
        mimeType: "image/jpeg",
        fileType: "image",
      });

      // Search by uploaded image URL
      // threshold: 0.3 —— 相似度下限（0~1）。这里刻意放得很宽（ChatPage 用的是 0.7），
      // 因为本页是「专门来找相似女优」的场景，宁可多召回让用户自己挑，也不要空结果
      const result = await searchByImageMutation.mutateAsync({
        imageUrl: uploadResult.url,
        userId: user?.id,
        threshold: 0.3,
      });
      setImageResults(result);
      if (result.matches.length > 0) {
        toast.success(`${result.matches.length}人の相似女優が見つかりました`);
      } else {
        toast.info("マッチする女優が見つかりませんでした");
      }
    } catch (error: any) {
      toast.error(error.message || "画像検索に失敗しました");
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * 执行「按女优名检索」。
   *
   * 与图片模式的差别：无需上传，直接把名字交给后端做匹配，
   * 返回值除相似女优列表外还带该女优的出演视频（videos）。
   *
   * 权限：public procedure；userId 可选，用于写检索历史。
   * 副作用：更新 nameResults；弹 toast。异常统一转 toast.error。
   */
  const handleSearchByName = async () => {
    if (!actressName.trim()) {
      toast.error("女優名を入力してください");
      return;
    }

    setIsLoading(true);
    setNameResults(null);
    try {
      // limit: 10 —— 相似女优最多返回 10 人，与三列网格（约 3~4 行）的展示容量匹配
      const result = await searchByNameMutation.mutateAsync({
        actressName: actressName.trim(),
        userId: user?.id,
        limit: 10,
      });
      setNameResults(result);
      if (result.actresses.length > 0) {
        toast.success(result.message);
      } else {
        toast.info(result.message);
      }
    } catch (error: any) {
      toast.error(error.message || "名前検索に失敗しました");
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * 把视频时长（秒）格式化为 `H:MM:SS` 或 `M:SS`。
   *
   * 规则：不足 1 小时时省略小时段；分/秒补零到两位（首段不补零，如 "5:07"、"1:05:07"）。
   * 边界：null/undefined/0 一律返回空串，调用方据此隐藏时长角标。
   *
   * @param seconds 视频总时长（秒），可能为空
   * @returns 供 UI 直接渲染的时长文本；无效输入返回 ""
   */
  const formatDuration = (seconds: number | null | undefined) => {
    if (!seconds) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // ---- 两种检索模式的结果归一化 ----
  // 两个后端接口返回的字段名不同（name 模式是 actresses/videos，image 模式是 matches），
  // 这里统一映射成三个派生变量，使下方 JSX 只需写一套渲染分支：
  //   results        当前模式的原始响应（仅用于取 message / 判断「是否已检索过」）
  //   actressResults 女优卡片列表（两种模式都有）
  //   videoResults   出演视频列表（仅 name 模式有，image 模式恒为 null，对应区块不渲染）
  const results = searchMode === "name" ? nameResults : imageResults;
  const actressResults = searchMode === "name" ? nameResults?.actresses : imageResults?.matches;
  const videoResults = searchMode === "name" ? nameResults?.videos : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">
            女優相似度検索
          </h1>
          <p className="text-slate-300">
            顔画像から相似した女優を検索します
          </p>
        </div>

        {/* Search Mode Tabs */}
        <div className="flex gap-4 mb-6">
          <Button
            variant={searchMode === "image" ? "default" : "outline"}
            onClick={() => setSearchMode("image")}
            className="flex items-center gap-2"
          >
            <Upload className="w-4 h-4" />
            画像検索
          </Button>
          <Button
            variant={searchMode === "name" ? "default" : "outline"}
            onClick={() => setSearchMode("name")}
            className="flex items-center gap-2"
          >
            <Search className="w-4 h-4" />
            名前検索
          </Button>
        </div>

        {/* Search Input */}
        <Card className="mb-8 bg-slate-800 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white">
              {searchMode === "image" ? "顔画像をアップロード" : "女優名を入力"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {searchMode === "image" ? (
              <div className="space-y-4">
                <div className="flex gap-4 items-start">
                  <div className="flex-1">
                    {/* 原生 file input 被隐藏，仅作为「文件选择器」的句柄；
                        视觉上的虚线大按钮通过 ref.click() 代理触发，
                        这样才能用 shadcn Button 的样式而不受浏览器原生控件外观限制 */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleImageUpload}
                      className="hidden"
                    />
                    <Button
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full h-32 border-dashed border-2 border-slate-600 hover:border-blue-500 flex flex-col items-center justify-center gap-2"
                    >
                      <Upload className="w-8 h-8 text-slate-400" />
                      <span className="text-slate-400">
                        クリックして画像を選択
                      </span>
                    </Button>
                  </div>
                  {imagePreview && (
                    <div className="w-32 h-32 rounded-lg overflow-hidden border border-slate-600">
                      <img
                        src={imagePreview}
                        alt="Preview"
                        className="w-full h-full object-cover"
                      />
                    </div>
                  )}
                </div>
                <Button
                  onClick={handleSearchByImage}
                  disabled={isLoading || !imagePreview}
                  className="w-full flex items-center justify-center gap-2"
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )}
                  画像で検索
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Input
                  placeholder="女優名を入力（例：佐々木あき）"
                  value={actressName}
                  onChange={(e) => setActressName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearchByName()}
                  className="bg-slate-700 border-slate-600 text-white"
                />
                <Button
                  onClick={handleSearchByName}
                  disabled={isLoading}
                  className="flex items-center gap-2"
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )}
                  検索
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Results */}
        {/* results 非空即代表「已检索过一次」，用于在空态卡片与结果区之间切换 */}
        {results && (
          <div className="space-y-8">
            {/* Actress Results */}
            {actressResults && actressResults.length > 0 && (
              <div>
                <h2 className="text-2xl font-bold text-white mb-4">
                  {searchMode === "image" ? "相似女優一覧" : "検索結果"}
                  <span className="text-sm font-normal text-slate-400 ml-2">
                    ({actressResults.length}人)
                  </span>
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {actressResults.map((actress: any) => (
                    <Card
                      key={actress.actressId}
                      className="bg-slate-800 border-slate-700 hover:border-purple-500 transition-colors cursor-pointer"
                      onClick={() => setLocation(`/search?q=${encodeURIComponent(actress.name)}`)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center gap-4 mb-3">
                          {actress.profileImage ? (
                            <img
                              src={actress.profileImage}
                              alt={actress.name}
                              className="w-16 h-16 rounded-full object-cover"
                            />
                          ) : (
                            <div className="w-16 h-16 rounded-full bg-slate-700 flex items-center justify-center">
                              <span className="text-2xl text-slate-400">
                                {actress.name.charAt(0)}
                              </span>
                            </div>
                          )}
                          <div className="flex-1">
                            <h3 className="text-lg font-semibold text-white">
                              {actress.name}
                            </h3>
                            {actress.japaneseName && actress.japaneseName !== actress.name && (
                              <p className="text-sm text-slate-400">{actress.japaneseName}</p>
                            )}
                            {actress.videoCount > 0 && (
                              <p className="text-xs text-slate-500">
                                {actress.videoCount}本の動画
                              </p>
                            )}
                          </div>
                        </div>
                        {/* Similarity bar */}
                        {/* similarity 是 0~1 的小数：文本用整数百分比，进度条直接用同一数值当宽度百分比 */}
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm text-slate-400">
                            {searchMode === "image" ? "相似度" : "マッチ度"}
                          </span>
                          <span className="text-lg font-bold text-purple-400">
                            {(actress.similarity * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div className="w-full bg-slate-700 rounded-full h-2">
                          <div
                            className="bg-purple-500 h-2 rounded-full transition-all"
                            style={{
                              width: `${actress.similarity * 100}%`,
                            }}
                          />
                        </div>
                        {actress.reason && (
                          <p className="text-xs text-slate-500 mt-2">{actress.reason}</p>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Video Results (name search only) */}
            {/* 图片模式下 videoResults 恒为 null，本区块整体不渲染 */}
            {videoResults && videoResults.length > 0 && (
              <div>
                <h2 className="text-2xl font-bold text-white mb-4">
                  出演動画
                  <span className="text-sm font-normal text-slate-400 ml-2">
                    ({videoResults.length}本)
                  </span>
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {videoResults.map((video: any) => (
                    <Card
                      key={video.id}
                      className="bg-slate-800 border-slate-700 hover:border-blue-500 transition-colors cursor-pointer overflow-hidden"
                      onClick={() => setLocation(`/video/${video.id}`)}
                    >
                      <div className="relative aspect-video bg-slate-900">
                        {video.thumbnailUrl ? (
                          <img
                            src={video.thumbnailUrl}
                            alt={video.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Play className="w-12 h-12 text-slate-600" />
                          </div>
                        )}
                        {video.duration && (
                          <div className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDuration(video.duration)}
                          </div>
                        )}
                        {video.category && (
                          <div className="absolute top-2 left-2 bg-purple-600/80 text-white text-xs px-2 py-0.5 rounded">
                            {video.category}
                          </div>
                        )}
                      </div>
                      <CardContent className="p-3">
                        <h3 className="text-sm font-medium text-white line-clamp-2 mb-1">
                          {video.title}
                        </h3>
                        <div className="flex items-center gap-3 text-xs text-slate-400">
                          {video.views !== undefined && (
                            <span className="flex items-center gap-1">
                              <Eye className="w-3 h-3" />
                              {video.views.toLocaleString()}
                            </span>
                          )}
                          {video.rating && (
                            <span className="text-yellow-400">
                              ★{Number(video.rating).toFixed(1)}
                            </span>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* No results */}
            {actressResults && actressResults.length === 0 && (
              <Card className="bg-slate-800 border-slate-700">
                <CardContent className="p-12 text-center">
                  <Search className="w-12 h-12 text-slate-500 mx-auto mb-4" />
                  <p className="text-slate-400 text-lg mb-2">
                    {results.message || "結果が見つかりませんでした"}
                  </p>
                  <p className="text-slate-500 text-sm">
                    別のキーワードや画像で検索してみてください
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Image analysis info */}
            {/* LLM 面部特征分析的可解释性展示（年龄段/民族/发型/脸型/风格）。
                字段全部可选：后端 LLM 返回的 JSON 字段数不固定，故逐个做存在性判断；
                外层用 Object.keys(...).length > 0 过滤掉「返回了空对象」的情况 */}
            {searchMode === "image" && imageResults?.analysis && Object.keys(imageResults.analysis).length > 0 && (
              <Card className="bg-slate-800 border-slate-700">
                <CardHeader>
                  <CardTitle className="text-white text-sm">AI分析結果</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                    {imageResults.analysis.age_range && (
                      <div>
                        <span className="text-slate-400">年齢:</span>{" "}
                        <span className="text-white">{imageResults.analysis.age_range}</span>
                      </div>
                    )}
                    {imageResults.analysis.ethnicity && (
                      <div>
                        <span className="text-slate-400">民族:</span>{" "}
                        <span className="text-white">{imageResults.analysis.ethnicity}</span>
                      </div>
                    )}
                    {imageResults.analysis.hair_style && (
                      <div>
                        <span className="text-slate-400">髪型:</span>{" "}
                        <span className="text-white">{imageResults.analysis.hair_style}</span>
                      </div>
                    )}
                    {imageResults.analysis.face_shape && (
                      <div>
                        <span className="text-slate-400">顔型:</span>{" "}
                        <span className="text-white">{imageResults.analysis.face_shape}</span>
                      </div>
                    )}
                    {imageResults.analysis.beauty_type && (
                      <div>
                        <span className="text-slate-400">タイプ:</span>{" "}
                        <span className="text-white">{imageResults.analysis.beauty_type}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Empty State */}
        {!results && !isLoading && (
          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="p-12 text-center">
              <Search className="w-12 h-12 text-slate-500 mx-auto mb-4" />
              <p className="text-slate-400">
                検索を開始して相似女優を見つけましょう
              </p>
              <p className="text-slate-500 text-sm mt-2">
                画像をアップロードするか、女優名を入力して検索してください
              </p>
            </CardContent>
          </Card>
        )}

        {/* Loading State */}
        {isLoading && (
          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="p-12 text-center">
              <Loader2 className="w-12 h-12 text-purple-500 mx-auto mb-4 animate-spin" />
              <p className="text-slate-400">
                {searchMode === "image" ? "AI画像分析中..." : "検索中..."}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Quick Links */}
        <div className="mt-8 flex gap-4 justify-center">
          <Button
            variant="outline"
            onClick={() => setLocation("/search")}
            className="text-slate-300"
          >
            動画検索へ
          </Button>
          <Button
            variant="outline"
            onClick={() => setLocation("/chat")}
            className="text-slate-300"
          >
            AIチャット推薦へ
          </Button>
        </div>
      </div>
    </div>
  );
}
