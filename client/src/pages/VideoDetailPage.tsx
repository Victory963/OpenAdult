/**
 * ============================================================================
 * client/src/pages/VideoDetailPage.tsx — 视频详情页（播放器 + 元信息）
 * ============================================================================
 *
 * 架构层级：**前端 UI 页面层**。在 `client/src/App.tsx` 中挂载于路由 `/video/:id`，
 * 是列表页（VideosPage / VideosPageV2）、首页分类流、搜索结果页的共同落点。
 *
 * ## 页面职责
 * 1. **播放区**：把视频交给 `@/components/VideoPlayer` 渲染。
 * 2. **主栏**：标题、播放数、评分、发行日期、收藏/分享按钮、简介、分类与标签。
 * 3. **侧栏**：出演女優列表（`sticky top-8`，随主栏滚动常驻）。
 *
 * ## 主要导出
 * - `default VideoDetailPage` —— 路由级组件，无 props；视频 ID 从 URL path 参数解析。
 *
 * ## 上下游依赖
 * - 上游：wouter 路由 `/video/:id`。
 * - 下游 tRPC procedure：`videos.getById`（**V1，`publicProcedure`**，游客可看）。
 *   返回视频行本体 + 装配好的 `actresses` 数组。
 *   注意此处刻意用 V1 而非 videosV2.getById —— 后者是 protected，会挡住游客。
 * - 下游组件：`VideoPlayer`（内部自行处理 HLS、续播位置、广告插播与埋点）。
 * - 下游工具：`@/lib/videoUrl` 的 `resolveVideoUrl`。
 *
 * ## 渲染状态机（自上而下短路返回，顺序不可调换）
 *   1. `!videoId`            → 转圈（URL 无 id 或解析失败）
 *   2. `videoQuery.isLoading`→ 转圈
 *   3. `isError || !data`    → 「ビデオが見つかりません」卡片
 *   4. 正常                  → 完整详情页
 *
 * ## 关键设计决策 / 坑
 * - **播放地址必须过 `resolveVideoUrl`**：分片上传的视频其 `videoUrl` 存的是
 *   `multi-chunk:...` 伪协议，浏览器无法直接播放，需改指向 `/api/video-stream/:id`
 *   由服务端按序拼流。历史遗留的绝对 URL 也在该函数里被归一为相对路径
 *   （便于域名轮换时不失效）。
 * - **播放数不在本页自增**：`videos.getById` 是纯读操作，页面也没有额外的埋点调用。
 * - **续播位置由 VideoPlayer 负责**（`resumePlayback.get/update`），本页只透传 `videoId`。
 */
import React, { useState } from "react";
import { useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import VideoPlayer from "@/components/VideoPlayer";
import { resolveVideoUrl } from "@/lib/videoUrl";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Heart, Eye, Share2, Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * 视频详情页（路由 `/video/:id`）。
 *
 * @props 无 —— 视频 ID 来自 URL path 参数。
 * @副作用 只读一个 tRPC query；分享按钮可能调起系统分享面板。
 * @权限 public —— `videos.getById` 是 `publicProcedure`，游客可直接访问详情页。
 */
export default function VideoDetailPage() {
  // wouter 的 useRoute 返回 [是否匹配, 参数对象]。这里只取参数：
  // 组件既然被渲染出来，说明路由必然已匹配，无需再判断第一个返回值。
  const [, params] = useRoute("/video/:id");
  // path 参数永远是字符串，后端 zod schema 要求 number，故此处转换。
  // ⚠️ `parseInt` 对非数字串返回 NaN，而 NaN 是假值，会一路走到下面
  //    `if (!videoId)` 的分支 —— 表现为**永久转圈**而不是「未找到」（见 observations）。
  const videoId = params?.id ? parseInt(params.id) : null;

  // 主查询。`videoId || 0` 只是为了满足入参类型（zod 要求 positive int，0 会被拒），
  // 真正的守卫是 `enabled: !!videoId` —— id 缺失时根本不会发出请求。
  // Fetch video data from API
  const videoQuery = trpc.videos.getById.useQuery(
    { videoId: videoId || 0 },
    { enabled: !!videoId }
  );

  // 收藏态。⚠️ 仅为组件内的**本地 UI 状态**，未接入 `favorites` 相关 procedure，
  // 刷新页面即丢失，也不会写入数据库（见 observations）。
  const [isFavorite, setIsFavorite] = useState(false);

  /**
   * 切换收藏状态并弹提示。
   * @副作用 setState；弹出 sonner toast。**当前不产生任何网络请求**。
   *
   * 注意 toast 文案基于**切换前**的 `isFavorite` 判断：
   * 此刻 setState 尚未生效，`isFavorite` 仍是旧值，
   * 因此「旧值为 true」对应的提示是「已从收藏移除」，逻辑是对的。
   */
  const handleAddFavorite = () => {
    setIsFavorite(!isFavorite);
    toast.success(
      isFavorite ? "お気に入りから削除しました" : "お気に入りに追加しました"
    );
  };

  /**
   * 分享当前视频。
   * @副作用 支持 Web Share API 的环境（主要是移动端浏览器）调起系统分享面板；
   *         否则只弹一个 toast 提示。
   *
   * ⚠️ 降级分支只显示「リンクをコピーしました」，**并没有真的写入剪贴板**
   *    （缺少 `navigator.clipboard.writeText` 调用），见 observations。
   */
  const handleShare = () => {
    if (navigator.share) {
      navigator.share({
        title: videoQuery.data?.title || "動画",
        text: videoQuery.data?.description || "",
        url: window.location.href,
      });
    } else {
      toast.success("リンクをコピーしました");
    }
  };

  // --------------------------------------------------------------------------
  // 渲染状态机的三个提前返回分支（顺序不可调换，详见文件头）。
  // 它们都在所有 Hook 调用**之后**，符合 Hooks 规则（不能条件式调用 Hook）。
  // --------------------------------------------------------------------------

  // 分支 1：URL 里没有可用的 id。此时请求根本没发出，
  // 用转圈占位（严格说这里更适合展示「未找到」，见 observations）。
  if (!videoId) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="w-8 h-8 text-slate-500 animate-spin" />
      </div>
    );
  }

  // 分支 2：请求进行中。
  if (videoQuery.isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="w-8 h-8 text-slate-500 animate-spin" />
      </div>
    );
  }

  // 分支 3：出错或无数据。
  // 后端在视频不存在时抛的是普通 Error（映射为 500）而非 NOT_FOUND，
  // 前端无法区分「视频不存在」与「数据库故障」，故这里合并成同一个文案。
  if (videoQuery.isError || !videoQuery.data) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-950 text-white flex items-center justify-center">
        <Card className="bg-slate-800 border-slate-700 max-w-md">
          <CardContent className="p-6 text-center">
            <p className="text-slate-300">ビデオが見つかりません</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // 走到这里 data 必然存在（上面三个分支已排除全部空态），
  // 取个短别名，下方 JSX 不必反复写 videoQuery.data。
  const video = videoQuery.data;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-950 text-white">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/*
          播放器。四个 prop 的契约：
          - videoUrl：**必须**经 `resolveVideoUrl` 归一化 —— 分片视频的 `multi-chunk:` 伪协议
            会被转成 `/api/video-stream/:id`，历史绝对 URL 会被转成相对路径。
            `|| ""` 兜底空串，让 VideoPlayer 自行走「无源」空态而不是收到 null 报错。
          - thumbnailUrl：作为 poster 图，同样用 `|| ""` 兜底。
          - videoId：**可选但强烈建议传** —— VideoPlayer 靠它启用续播位置读写
            （`resumePlayback.get/update`）、HLS 清单查询与广告插播埋点；
            不传则这些功能全部静默关闭。
            `videoId || undefined` 是把 `null` 归一成 `undefined` 以匹配可选 prop 的类型。
        */}
        {/* Video Player */}
        <div className="mb-8">
          <VideoPlayer
            videoUrl={resolveVideoUrl(video.videoUrl, video.id) || ""}
            title={video.title}
            thumbnailUrl={video.thumbnailUrl || ""}
            videoId={videoId || undefined}
          />
        </div>

        {/* Video Info */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            {/* Title and Stats */}
            <div className="mb-6">
              <h1 className="text-3xl font-bold mb-4">{video.title}</h1>
              <div className="flex items-center gap-6 text-slate-400 mb-4">
                <div className="flex items-center gap-2">
                  <Eye className="w-5 h-5" />
                  <span>{(video.views || 0).toLocaleString()} 再生</span>
                </div>
                <div className="flex items-center gap-2">
                  <span>⭐ {video.rating || 0}</span>
                </div>
                {/*
                  发行日期。tRPC 用 superjson 序列化，Date 已能跨网络还原，
                  这里再包一层 `new Date()` 是为了兼容后端可能回传字符串的情况。
                  固定用 ja-JP 区域格式（本页未接入 i18n），无日期时显示「日付不明」。
                */}
                <div className="text-sm">
                  {video.releaseDate
                    ? new Date(video.releaseDate).toLocaleDateString("ja-JP")
                    : "日付不明"}
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-4 mb-6">
              <Button
                onClick={handleAddFavorite}
                className={
                  isFavorite
                    ? "bg-pink-600 hover:bg-pink-700"
                    : "bg-slate-700 hover:bg-slate-600"
                }
              >
                <Heart
                  className={`w-5 h-5 mr-2 ${isFavorite ? "fill-current" : ""}`}
                />
                {isFavorite ? "お気に入り済み" : "お気に入りに追加"}
              </Button>
              <Button
                onClick={handleShare}
                variant="outline"
                className="border-slate-600 text-slate-300 hover:text-white"
              >
                <Share2 className="w-5 h-5 mr-2" />
                シェア
              </Button>
            </div>

            {/* Description */}
            {video.description && (
              <Card className="bg-slate-800 border-slate-700 mb-6">
                <CardContent className="p-6">
                  <h2 className="text-xl font-semibold mb-3">説明</h2>
                  <p className="text-slate-300 leading-relaxed">
                    {video.description}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Category and Tags */}
            <Card className="bg-slate-800 border-slate-700">
              <CardContent className="p-6">
                {video.category && (
                  <div className="mb-4">
                    <h3 className="text-sm font-medium text-slate-400 mb-2">
                      カテゴリ
                    </h3>
                    <span className="inline-block bg-purple-600/30 text-purple-300 px-3 py-1 rounded-full text-sm">
                      {video.category}
                    </span>
                  </div>
                )}
                {/*
                  标签。`videos.tags` 在数据库里是 JSON 列（`$type<string[]>()` 仅编译期约束），
                  运行时可能是 null，故先判空再 map。
                  标签本身用作 key —— 依赖同一视频内标签不重复这一前提。
                  样式带 hover/cursor-pointer 但**没有点击行为**，目前不可按标签检索。
                */}
                {video.tags && video.tags.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-slate-400 mb-2">
                      タグ
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {video.tags.map((tag) => (
                        <span
                          key={tag}
                          className="bg-slate-700 text-slate-300 px-3 py-1 rounded-full text-sm hover:bg-slate-600 cursor-pointer transition"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/*
            侧栏：出演女優。`sticky top-8` 让它在主栏长内容滚动时保持可见。
            `actresses` 由 `videos.getById` 在服务端一并装配好（视频 → video_actresses → actresses），
            本页不额外发请求。
            每张卡片带 hover/cursor-pointer 与「プロフィールを見る」文案，
            但**尚未接线到女優详情路由**，点击无反应。
          */}
          {/* Sidebar - Actresses */}
          <div>
            <Card className="bg-slate-800 border-slate-700 sticky top-8">
              <CardContent className="p-6">
                <h2 className="text-xl font-semibold mb-4">出演女優</h2>
                {video.actresses && video.actresses.length > 0 ? (
                  <div className="space-y-3">
                    {video.actresses.map((actress) => (
                      <div
                        key={actress.id}
                        className="p-3 bg-slate-700/50 rounded hover:bg-slate-700 transition cursor-pointer"
                      >
                        <p className="font-medium text-white">{actress.name}</p>
                        <p className="text-xs text-slate-400 mt-1">
                          プロフィールを見る
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-slate-400 text-sm">出演女優情報がありません</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
