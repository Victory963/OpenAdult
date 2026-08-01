/**
 * ============================================================================
 * client/src/pages/VideosPageV2.tsx — 视频列表页 **V2**（需登录，紧凑网格版）
 * ============================================================================
 *
 * 架构层级：**前端 UI 页面层**。在 `client/src/App.tsx` 中挂载（与 V1 的 `/videos` 并存的另一条路由）。
 *
 * ## 页面职责
 * 1. **吸顶头部**（`sticky top-0`）：标题 + 搜索框 + 排序按钮组 + 分类按钮组，滚动时常驻。
 * 2. **视频网格**：响应式 1/2/4 列，卡片含封面、时长角标、悬停播放遮罩、女優标签、观看数/评分。
 * 3. **翻页**：仅「前へ / 次へ」，无页码。
 *
 * ## 主要导出
 * - `default VideosPageV2` —— 路由级组件，无 props。
 *
 * ## 上下游依赖
 * - 下游 tRPC procedure（**均为 `protectedProcedure`，需登录**）：
 *   - `videosV2.list`          入参 `{ limit, offset, category?, sortBy }`，
 *                              返回**扁平数组**（注意：与 V1 不同，**不含 pagination 元信息**）
 *   - `videosV2.getCategories` 返回分类名 `string[]`
 * - 下游路由：点击卡片跳到 `/video/:id`（`VideoDetailPage`）。
 *
 * ## 与 V1（`VideosPage.tsx`）的差异 —— 这是理解本文件的关键
 * | | V1 | 本页 (V2) |
 * |---|---|---|
 * | 权限 | public，游客可浏览 | **protected，游客拿到 UNAUTHORIZED** |
 * | 分页语义 | `page` 1-based，后端回传 total/totalPages | `offset = page * limit`，page **0-based**，后端不回总数 |
 * | 「下一页」可用性 | 由 totalPages 精确判断 | 只能靠**启发式**：本页不满 limit 即视为最后一页 |
 * | 女優名筛选 | 支持 | 不支持（搜索框未接线，见 observations） |
 *
 * ## 关键设计决策 / 坑
 * - **后端不回总数**是 V2 为了避免 V1「全表拉进内存再 slice」而做的取舍：
 *   SQL 层真分页换来性能，代价是前端只能做「加载更多」式翻页。
 * - **页码 0-based**：`offset = page * limit` 的算式要求 page 从 0 起，
 *   显示时才 `page + 1`。改动此处务必同时改这两处，否则会跳页或重复。
 * - 头部 `sticky top-0 z-40`：z 值需低于全局弹层（首页导航用的是 z-50），避免遮挡。
 * - 卡片点击用 `window.location.href` 做**整页跳转**而非 wouter 的 `navigate`，
 *   会丢失 SPA 状态并重新加载全部资源（见 observations）。
 */
"use client";

import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Loader2, Search, Play, Heart, Eye } from "lucide-react";
import { toast } from "sonner";

/**
 * 视频列表页 V2。
 *
 * @props 无 —— 路由级组件；筛选与页码全在内部 state，不同步 URL。
 * @副作用 只读（两个 tRPC query）；点击卡片时触发整页导航。
 * @权限 protected —— 依赖的 procedure 需登录；游客访问会请求失败并显示「動画が見つかりません」。
 */
export default function VideosPageV2() {
  const [, navigate] = useLocation();
  // 搜索框的受控值。⚠️ 目前**未参与任何查询**（videosV2.list 也没有关键词入参），
  // 输入后不会有任何效果，属于未完成的 UI（详见交付说明的 observations）。
  const [searchQuery, setSearchQuery] = useState("");
  // 分类筛选。用 `undefined` 而非空串表示「すべて」，可直接透传给后端的可选字段。
  const [selectedCategory, setSelectedCategory] = useState<string | undefined>();
  const [sortBy, setSortBy] = useState<"newest" | "popular" | "rating">("newest");
  // ⚠️ **0-based** 页码（与 V1 的 1-based 相反），因为下面要用它算 offset。
  const [page, setPage] = useState(0);

  // 每页 20 条：4 列栅格恰好 5 整行，且与后端 videosV2.list 的默认 limit 一致。
  const limit = 20;
  // 偏移量由页码推导，不单独存 state —— 避免两份状态不同步。
  const offset = page * limit;

  // 视频列表。入参对象即缓存键，limit/offset/category/sortBy 任一变化都会自动重查。
  // 修复：切换排序/分类时会同时 `setPage(0)`（见下方三处按钮的 onClick），
  // 否则停在第 3 页换分类会继续带着 offset=40 去查，新分类往往不足 40 条 →
  // 返回空数组 → 误显示「動画が見つかりません」。与 V1 的 handleCategoryChange 行为对齐。
  // Fetch videos
  const videosQuery = trpc.videosV2.list.useQuery({
    limit,
    offset,
    category: selectedCategory,
    sortBy,
  });

  // Fetch categories
  const categoriesQuery = trpc.videosV2.getCategories.useQuery();

  // 统一兜底成空数组，让下方 JSX 可以无脑 `.length` / `.map()`，
  // 无需到处写可选链；加载中与请求失败在这里被抹平成同一种「空」。
  const videos = videosQuery.data || [];
  const categories = categoriesQuery.data || [];

  /**
   * 跳转到视频详情页。
   * @param videoId 视频主键
   * @副作用 修改 `window.location.href` —— 这是**整页刷新**导航，
   *         会丢弃 React Query 缓存与当前筛选/页码状态。
   *         同文件已引入 wouter 的 `navigate`，改用它即可保留 SPA 体验。
   */
  const handleVideoClick = (videoId: number) => {
    window.location.href = `/video/${videoId}`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      {/*
        吸顶头部：滚动浏览长列表时筛选器始终可达。
        `bg-slate-900/95 + backdrop-blur` 而非纯不透明色，让下方内容透出一点，
        视觉上表明这是浮层而非页面顶端。
      */}
      {/* Header */}
      <div className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur border-b border-slate-700">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-bold text-white">動画一覧</h1>
            <div className="flex items-center gap-2 bg-slate-800 rounded-lg px-3 py-2 border border-slate-700 flex-1 max-w-md">
              <Search className="w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="動画を検索..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-transparent text-white placeholder-slate-400 outline-none flex-1"
              />
            </div>
          </div>

          {/* Filters */}
          <div className="space-y-4">
            {/*
              排序按钮组。用 `as const` 断言字面量元组，使 map 回调里的 `sort`
              被推断为联合类型 `"newest" | "popular" | "rating"`，
              从而能直接传给 `setSortBy` 而无需类型断言。
            */}
            {/* Sort buttons */}
            <div className="flex gap-2">
              {(["newest", "popular", "rating"] as const).map((sort) => (
                <Button
                  key={sort}
                  variant={sortBy === sort ? "default" : "outline"}
                  size="sm"
                  // 修复：换排序必须回到第 1 页（0-based 的 0），否则沿用旧 offset 会取到空页
                  onClick={() => {
                    setSortBy(sort);
                    setPage(0);
                  }}
                  className={sortBy === sort ? "bg-purple-600" : ""}
                >
                  {sort === "newest" && "最新"}
                  {sort === "popular" && "人気"}
                  {sort === "rating" && "評価"}
                </Button>
              ))}
            </div>

            {/* Category filter */}
            {categories.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant={!selectedCategory ? "default" : "outline"}
                  size="sm"
                  // 修复：切回「すべて」同样要重置页码
                  onClick={() => {
                    setSelectedCategory(undefined);
                    setPage(0);
                  }}
                  className={!selectedCategory ? "bg-purple-600" : ""}
                >
                  すべて
                </Button>
                {categories.map((category) => (
                  <Button
                    key={category}
                    variant={selectedCategory === category ? "default" : "outline"}
                    size="sm"
                    // 修复：换分类必须回到第 1 页，否则新分类不足一页时会显示成「无内容」
                    onClick={() => {
                      setSelectedCategory(category);
                      setPage(0);
                    }}
                    className={selectedCategory === category ? "bg-purple-600" : ""}
                  >
                    {category}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Videos Grid */}
      <div className="max-w-7xl mx-auto px-4 py-8">
        {videosQuery.isLoading ? (
          <div className="flex items-center justify-center h-96">
            <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
          </div>
        ) : videos.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-slate-400 text-lg">動画が見つかりません</p>
          </div>
        ) : (
          <>
            {/* Grid Layout - 4 columns on desktop, 2 on tablet, 1 on mobile */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {videos.map((video: any) => (
                <div
                  key={video.id}
                  className="group cursor-pointer"
                  onClick={() => handleVideoClick(video.id)}
                >
                  <Card className="bg-slate-800 border-slate-700 overflow-hidden hover:border-purple-500 transition-all h-full flex flex-col">
                    {/* Thumbnail */}
                    <div className="relative bg-slate-900 aspect-video overflow-hidden">
                      {video.thumbnailUrl ? (
                        <img
                          src={video.thumbnailUrl}
                          alt={video.title}
                          className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                        />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-purple-600 to-slate-900 flex items-center justify-center">
                          <Play className="w-12 h-12 text-white/50" />
                        </div>
                      )}

                      {/* Overlay on hover */}
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <Play className="w-16 h-16 text-white" />
                      </div>

                      {/*
                        时长角标：把秒数格式化成 `m:ss`。
                        `padStart(2, "0")` 保证秒数补零（125 秒 → "2:05" 而非 "2:5"）。
                        `duration > 0` 的判断同时挡掉了 0 与缺省值，未知时长不显示角标。
                        注意：只有分:秒两段，超过 1 小时的视频会显示成 "125:30" 而非 "2:05:30"。
                      */}
                      {/* Duration badge */}
                      {video.duration > 0 && (
                        <div className="absolute bottom-2 right-2 bg-black/75 text-white text-xs px-2 py-1 rounded">
                          {Math.floor(video.duration / 60)}:{String(video.duration % 60).padStart(2, "0")}
                        </div>
                      )}
                    </div>

                    {/* Content */}
                    <div className="p-3 flex-1 flex flex-col">
                      {/* Title */}
                      <h3 className="text-white font-semibold text-sm line-clamp-2 mb-2 group-hover:text-purple-400 transition-colors">
                        {video.title}
                      </h3>

                      {/* Actresses */}
                      {video.actresses && video.actresses.length > 0 && (
                        <div className="flex gap-1 mb-2 flex-wrap">
                          {video.actresses.slice(0, 3).map((actress: any) => (
                            <span
                              key={actress.id}
                              className="text-xs bg-purple-600/30 text-purple-300 px-2 py-1 rounded"
                            >
                              {actress.name}
                            </span>
                          ))}
                          {video.actresses.length > 3 && (
                            <span className="text-xs text-slate-400">
                              +{video.actresses.length - 3}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Category */}
                      {video.category && (
                        <p className="text-xs text-slate-400 mb-2">{video.category}</p>
                      )}

                      {/* Stats */}
                      <div className="flex gap-4 text-xs text-slate-400 mt-auto">
                        <div className="flex items-center gap-1">
                          <Eye className="w-3 h-3" />
                          {video.views || 0}
                        </div>
                        <div className="flex items-center gap-1">
                          <Heart className="w-3 h-3" />
                          {/*
                            rating 在 MySQL 里是 decimal 列，Drizzle 取回来是**字符串**，
                            必须先 parseFloat 才能 toFixed(1) 统一成一位小数；
                            为 null / "0.00" 等假值时直接显示 "0"。
                          */}
                          {video.rating ? parseFloat(video.rating).toFixed(1) : "0"}
                        </div>
                      </div>
                    </div>
                  </Card>
                </div>
              ))}
            </div>

            {/*
              翻页控件（无页码，只有前/后）。
              后端 videosV2.list 不返回总数，因此「是否还有下一页」只能靠**启发式**判断：
                `videos.length < limit` → 本页没取满 → 认定已到末尾 → 禁用「次へ」。
              这个启发式在「总数恰好是 limit 的整数倍」时会失效：
              最后一页取满 20 条，「次へ」仍可点，跳过去是一片空白。
              显示用 `page + 1` 把 0-based 的内部页码转成 1-based 的人类可读页号。
            */}
            {/* Pagination */}
            <div className="flex justify-center gap-2 mt-8">
              <Button
                variant="outline"
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
              >
                前へ
              </Button>
              <span className="text-slate-400 py-2">
                ページ {page + 1}
              </span>
              <Button
                variant="outline"
                onClick={() => setPage(page + 1)}
                disabled={videos.length < limit}
              >
                次へ
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
