/**
 * ============================================================================
 * client/src/pages/VideosPage.tsx — 视频列表页 **V1**（游客可访问）
 * ============================================================================
 *
 * 架构层级：**前端 UI 页面层**。在 `client/src/App.tsx` 中挂载于路由 `/videos`。
 *
 * ## 页面职责
 * 筛选 + 排序 + 分页地浏览全站视频：
 * 1. **女優名搜索**（受控输入 + 显式提交，不做实时搜索）
 * 2. **分类筛选**（按钮组，选项来自 `videos.getCategories`）
 * 3. **排序**（新着順 / 人気順 / 評価順）
 * 4. **已激活筛选条**（chip 形式，可单独移除或一键重置）
 * 5. **页码分页**（带首尾页 + 当前页 ±1 的省略号折叠）
 *
 * ## 主要导出
 * - `default VideosPage` —— 路由级组件，无 props。
 *
 * ## 上下游依赖
 * - 上游：`client/src/App.tsx` 的 wouter 路由表；首页各分类区块的「すべて見る」按钮指向本页。
 * - 下游 tRPC procedure（**均为 `publicProcedure`**）：
 *   - `videos.list`          入参 `{ page, limit, sortBy, category?, actressName? }`，
 *                            返回 `{ videos: [...含 actresses], pagination: { page, limit, total, totalPages } }`
 *   - `videos.getCategories` 返回去重后的分类名 `string[]`
 * - 下游路由：点击卡片跳转 `/video/:id`（`VideoDetailPage`）。
 *
 * ## V1 vs V2（`VideosPageV2.tsx`）
 * | | 本页 (V1) | V2 |
 * |---|---|---|
 * | 后端 | `videos.*`（public，游客可看） | `videosV2.*`（protected，需登录） |
 * | 分页 | 服务端返回 total/totalPages，可渲染完整页码 | 只有 offset/limit，靠「本页不满」猜是否还有下一页 |
 * | 筛选 | 分类 + 女優名 | 仅分类 |
 * 因此 **V1 不能被 V2 取代**：面向游客的浏览路径依赖 V1 的 public 权限与真实总数。
 *
 * ## 关键设计决策 / 坑
 * - **任何筛选条件变更都会 `setPage(1)`**，否则会停留在新结果集里不存在的页码上，出现空白页。
 * - `category` / `actressName` 用 **空串表示「不筛选」**，传给后端前用 `|| undefined` 转换，
 *   因为后端的 zod schema 期望的是 `undefined` 而不是空字符串。
 * - 分类「すべて」按钮传的哨兵值是 `"__all__"`，而非空串 —— shadcn/ui 的 `Select`
 *   不允许 value 为空字符串，这个哨兵是为兼容当时的 Select 实现留下的（现已改用 Button 组）。
 * - `searchInput`（输入框实时值）与 `actressName`（已提交的查询条件）刻意分离，
 *   避免每敲一个字符就触发一次网络请求。
 */
import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Play, Heart, Eye } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";

/**
 * 视频列表页 V1（路由 `/videos`）。
 *
 * @props 无 —— 路由级组件，筛选状态全部保存在组件内部（**不同步到 URL**，
 *        因此刷新页面或分享链接都会丢失当前筛选条件，见 observations）。
 * @副作用 只读：两个 tRPC query，无任何写操作。
 * @权限 public —— 依赖的两个 procedure 都是 `publicProcedure`，游客可正常浏览。
 */
export default function VideosPage() {
  // 分页状态。**1-based**（与后端 videos.list 的 page 入参约定一致），
  // 注意 V2 页面用的是 0-based 的 offset 页码，两者不要混淆。
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<"newest" | "popular" | "rating">("newest");
  // 分类筛选条件。空串 = 不筛选（见文件头说明）。
  const [category, setCategory] = useState<string>("");
  // 已提交的女優名查询条件 —— 变更即触发请求。
  const [actressName, setActressName] = useState<string>("");
  // 输入框的实时值 —— 只在点击「検索」或回车时才同步到 actressName。
  // 拆成两个 state 是为了实现「显式提交」语义，避免逐字符打接口。
  const [searchInput, setSearchInput] = useState<string>("");

  // 视频列表查询。React Query 以入参对象为缓存键，
  // 因此 page / sortBy / category / actressName 任一变化都会自动重新请求，
  // 无需手写 refetch 或 useEffect。
  // limit: 12 —— 对应 4 列栅格恰好 3 整行，桌面端不留残缺行。
  // `|| undefined`：把 UI 用的空串归一成后端期望的「字段缺省」。
  // Get videos
  const videosQuery = trpc.videos.list.useQuery({
    page,
    limit: 12,
    sortBy,
    category: category || undefined,
    actressName: actressName || undefined,
  });

  // 分类选项。全站共享且几乎不变，React Query 的默认缓存足以避免重复拉取。
  // Get categories
  const categoriesQuery = trpc.videos.getCategories.useQuery();

  /**
   * 提交女優名搜索：把输入框的值转正为查询条件。
   * 由「検索」按钮点击与输入框回车两处共用。
   * @副作用 setState ×2，间接触发 videosQuery 重新请求。
   */
  const handleSearch = () => {
    setActressName(searchInput);
    // 换了搜索词，结果集完全不同，旧页码大概率越界 → 必须回到第 1 页。
    setPage(1);
  };

  /**
   * 切换分类筛选。
   * @param newCategory 分类名；哨兵值 `"__all__"` 表示「すべて」（清除筛选），
   *                    会被归一为空串。
   * @副作用 setState ×2，间接触发 videosQuery 重新请求。
   */
  const handleCategoryChange = (newCategory: string) => {
    setCategory(newCategory === "__all__" ? "" : newCategory);
    setPage(1);
  };

  /**
   * 切换排序方式。
   * @param newSort 只可能是 "newest" | "popular" | "rating" 三者之一；
   *                因调用点是 `(["newest","popular","rating"] as const).map()`，
   *                这里的 `as` 断言是安全的（形参声明为 string 是为了通用性）。
   * @副作用 setState ×2。排序变化同样重置页码 —— 第 3 页的「新着順」与
   *         第 3 页的「人気順」内容毫无关联，保留页码只会让用户困惑。
   */
  const handleSortChange = (newSort: string) => {
    setSortBy(newSort as "newest" | "popular" | "rating");
    setPage(1);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">動画一覧</h1>
          <p className="text-slate-300">
            理想の動画を見つけよう
          </p>
        </div>

        {/* Filters */}
        <Card className="mb-8 bg-slate-800 border-slate-700">
          <CardContent className="p-6">
            {/*
              已激活筛选条：仅在「存在非默认条件」时出现。
              判据里 `sortBy !== "newest"` 而不是 `sortBy` —— newest 是默认排序，
              把它也显示成一个可移除的 chip 会造成「明明没筛选却有筛选条」的错觉。
              每个 chip 的 ✕ 只清除自身条件，右上角「すべてリセット」一次性清空全部
              （注意它同时要清 `searchInput`，否则输入框会残留已失效的搜索词）。
            */}
            {/* Active Filters Display */}
            {(category || actressName || sortBy !== "newest") && (
              <div className="mb-4 pb-4 border-b border-slate-700">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-slate-300">アクティブフィルター:</p>
                  <Button
                    onClick={() => {
                      setCategory("");
                      setActressName("");
                      setSearchInput("");
                      setSortBy("newest");
                      setPage(1);
                    }}
                    variant="ghost"
                    className="text-xs text-slate-400 hover:text-slate-200"
                  >
                    すべてリセット
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {category && (
                    <div className="flex items-center gap-2 bg-purple-600/30 text-purple-300 px-3 py-1 rounded-full text-sm">
                      <span>カテゴリ: {category}</span>
                      <button
                        onClick={() => {
                          setCategory("");
                          setPage(1);
                        }}
                        className="ml-1 hover:text-purple-200"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                  {actressName && (
                    <div className="flex items-center gap-2 bg-pink-600/30 text-pink-300 px-3 py-1 rounded-full text-sm">
                      <span>女優: {actressName}</span>
                      <button
                        onClick={() => {
                          setActressName("");
                          setSearchInput("");
                          setPage(1);
                        }}
                        className="ml-1 hover:text-pink-200"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                  {sortBy !== "newest" && (
                    <div className="flex items-center gap-2 bg-blue-600/30 text-blue-300 px-3 py-1 rounded-full text-sm">
                      <span>
                        ソート:
                        {sortBy === "popular" ? "人気順" : "評価順"}
                      </span>
                      <button
                        onClick={() => {
                          setSortBy("newest");
                          setPage(1);
                        }}
                        className="ml-1 hover:text-blue-200"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {/* Search by actress name */}
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  女優名で検索
                </label>
                <div className="flex gap-2">
                  <Input
                    placeholder="女優名を入力..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === "Enter") handleSearch();
                    }}
                    className="bg-slate-700 border-slate-600 text-white"
                  />
                  <Button
                    onClick={handleSearch}
                    className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
                  >
                    検索
                  </Button>
                </div>
              </div>

              {/* Category filter */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  カテゴリ
                </label>
                {/*
                  分类按钮组的三态渲染：加载中 → 有数据 → 无分类。
                  「すべて」按钮通过高亮态 `category === ""` 与具体分类互斥，
                  点击时传哨兵值 "__all__"（见 handleCategoryChange 的说明）。
                */}
                {categoriesQuery.isLoading ? (
                  <div className="text-slate-400 text-sm">読み込み中...</div>
                ) : categoriesQuery.data && categoriesQuery.data.length > 0 ? (
                  <div className="space-y-2">
                    <Button
                      onClick={() => handleCategoryChange("__all__")}
                      variant={category === "" ? "default" : "outline"}
                      className={
                        category === ""
                          ? "w-full bg-gradient-to-r from-purple-600 to-pink-600"
                          : "w-full border-slate-600 text-slate-300 hover:text-white"
                      }
                    >
                      すべて
                    </Button>
                    <div className="flex flex-wrap gap-2">
                      {categoriesQuery.data.map((cat) => (
                        <Button
                          key={cat}
                          onClick={() => handleCategoryChange(cat)}
                          variant={category === cat ? "default" : "outline"}
                          className={
                            category === cat
                              ? "bg-gradient-to-r from-purple-600 to-pink-600 text-white"
                              : "border-slate-600 text-slate-300 hover:text-white"
                          }
                          size="sm"
                        >
                          {cat}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-slate-400 text-sm">カテゴリなし</p>
                )}
              </div>

              {/* Sort */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  並び順
                </label>
                <div className="space-y-2">
                  {(["newest", "popular", "rating"] as const).map((sort) => (
                    <Button
                      key={sort}
                      onClick={() => handleSortChange(sort)}
                      variant={sortBy === sort ? "default" : "outline"}
                      className={
                        sortBy === sort
                          ? "w-full bg-gradient-to-r from-blue-600 to-cyan-600"
                          : "w-full border-slate-600 text-slate-300 hover:text-white"
                      }
                      size="sm"
                    >
                      {
                        sort === "newest"
                          ? "新着順"
                          : sort === "popular"
                            ? "人気順"
                            : "評価順"
                      }
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/*
          结果区三态：加载中（转圈）→ 有结果（栅格 + 分页）→ 无结果（空态卡片）。
          注意这里没有单独的错误分支：请求失败时 `data` 为 undefined，
          会落进最后的「動画が見つかりません」，把网络错误显示成了「没有数据」。
        */}
        {/* Videos Grid */}
        {videosQuery.isLoading ? (
          <div className="flex justify-center items-center h-96">
            <Loader2 className="w-8 h-8 text-slate-500 animate-spin" />
          </div>
        ) : videosQuery.data?.videos && videosQuery.data.videos.length > 0 ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
              {videosQuery.data.videos.map((video: any) => (
                <Link key={video.id} href={`/video/${video.id}`}>
                  <Card className="bg-slate-800 border-slate-700 hover:border-purple-500 transition-all cursor-pointer group overflow-hidden">
                    {video.thumbnailUrl && (
                      <div className="relative overflow-hidden h-48">
                        <img
                          src={video.thumbnailUrl}
                          alt={video.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                        <div className="absolute inset-0 bg-black/40 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                          <Play className="w-12 h-12 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </div>
                    )}
                    <CardContent className="p-4">
                      <h3 className="text-lg font-semibold text-white mb-2 line-clamp-2">
                        {video.title}
                      </h3>

                      {/*
                        出演女優标签：最多展示 3 个，超出部分折叠成「+N」。
                        `actresses` 由后端 videos.list 通过一次批量 IN 查询装配好，
                        这里直接读，不会产生额外请求。
                      */}
                      {/* Actresses */}
                      {video.actresses && video.actresses.length > 0 && (
                        <div className="mb-3">
                          <p className="text-xs text-slate-400 mb-1">出演女優:</p>
                          <div className="flex flex-wrap gap-1">
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
                        </div>
                      )}

                      {/* Stats */}
                      <div className="flex items-center justify-between text-sm text-slate-400">
                        <div className="flex items-center gap-1">
                          <Eye className="w-4 h-4" />
                          {video.views || 0}
                        </div>
                        <div className="flex items-center gap-1">
                          <Heart className="w-4 h-4" />
                          {video.rating || "0"}
                        </div>
                      </div>

                      {/* Category */}
                      {video.category && (
                        <p className="text-xs text-slate-500 mt-2">
                          {video.category}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>

            {/*
              ====================================================================
              分页控件：滑动窗口式页码折叠
              --------------------------------------------------------------------
              总页数可能非常大，不能把 1..N 全部渲染出来，因此按以下规则裁剪：

                1) `Array.from({length: totalPages}, (_, i) => i + 1)`
                   先生成完整的 1..N 页码数组（1-based，故 +1）；
                2) `.filter(...)` 只保留三类页码：
                     · 首页 `p === 1`                      —— 始终提供「跳回开头」
                     · 尾页 `p === totalPages`             —— 始终提供「跳到结尾」
                     · 当前页邻域 `page-1 <= p <= page+1`  —— 上一页/本页/下一页
                   最终最多渲染 5 个按钮（1 … c-1 c c+1 … N 去重后）。
                3) `.map((p, idx, arr))` 渲染时，若「前一个保留下来的页码」与当前页码
                   不连续（`arr[idx-1] !== p - 1`），就在前面插一个 `...` 表示断档。
                   这一步必须放在 filter **之后**，因为断档只有在裁剪完才能判断。

              仅当 `totalPages > 1` 时整块才渲染 —— 只有一页时分页控件毫无意义。
              前/后翻按钮各自用 `Math.max(1, ...)` / `Math.min(totalPages, ...)` 夹紧，
              与 `disabled` 形成双保险，防止越界页码被发到后端。
              ====================================================================
            */}
            {/* Pagination */}
            {videosQuery.data.pagination && videosQuery.data.pagination.totalPages > 1 && (
              <div className="flex justify-center items-center gap-2">
                <Button
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                  variant="outline"
                  className="border-slate-700 text-slate-300 hover:text-white"
                >
                  前へ
                </Button>

                {Array.from(
                  { length: videosQuery.data.pagination.totalPages },
                  (_, i) => i + 1
                )
                  .filter(
                    (p) =>
                      p === 1 ||
                      p === videosQuery.data.pagination.totalPages ||
                      (p >= page - 1 && p <= page + 1)
                  )
                  .map((p, idx, arr) => (
                    <div key={p}>
                      {idx > 0 && arr[idx - 1] !== p - 1 && (
                        <span className="text-slate-500">...</span>
                      )}
                      <Button
                        onClick={() => setPage(p)}
                        variant={page === p ? "default" : "outline"}
                        className={
                          page === p
                            ? "bg-gradient-to-r from-purple-600 to-pink-600"
                            : "border-slate-700 text-slate-300 hover:text-white"
                        }
                      >
                        {p}
                      </Button>
                    </div>
                  ))}

                <Button
                  onClick={() =>
                    setPage(
                      Math.min(
                        videosQuery.data.pagination.totalPages,
                        page + 1
                      )
                    )
                  }
                  disabled={page === videosQuery.data.pagination.totalPages}
                  variant="outline"
                  className="border-slate-700 text-slate-300 hover:text-white"
                >
                  次へ
                </Button>
              </div>
            )}
          </>
        ) : (
          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="p-12 text-center">
              <p className="text-slate-400">
                動画が見つかりません
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
