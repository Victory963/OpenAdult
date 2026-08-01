/**
 * SearchResultsPage — 综合搜索结果页（UI 层 / 页面组件）
 *
 * 架构角色：
 *   前端「页面」层，对应路由 `/search?q=<关键词>`。是全站文本搜索的落地页，
 *   同时展示两类结果：命中的女优（横向头像滚动条，MISSAV 风格）与命中的视频（网格）。
 *   站内多处会跳到这里：Home 的搜索框、ChatPage 的女优卡片、FaceSearchPage 的女优卡片。
 *
 * 主要导出：
 *   - default SearchResultsPage — 无 props，检索词完全由 URL 查询参数 `q` 驱动。
 *
 * 上游：client/src/App.tsx 路由表。
 * 下游：
 *   - trpc.actresses.search    → 女优名匹配（服务端过滤）
 *   - trpc.videosV2.list       → 拉取视频列表（enabled:false，仅手动 refetch）
 *   - trpc.searchHistory.save  → 记录一条搜索历史（写 search_history 表）
 *   - VideoCard 组件           → 单个视频卡片渲染
 *
 * 关键设计决策与坑：
 *   1. **视频搜索是纯客户端过滤**：并没有把关键词发给后端，而是 `videosV2.list` 一次性
 *      拉最多 100 条视频，再在浏览器里按标题/描述/分类/女优名做 includes 匹配。
 *      这意味着搜索范围被硬限制在「最新 100 条视频」以内，超出部分永远搜不到。
 *      女优搜索则相反，走的是服务端 query。
 *   2. 分类筛选与排序也在客户端完成（filter + sort），因此改筛选/排序会触发重新 refetch 全量再过滤。
 *   3. 检索词有两个来源需要区分：`urlQuery`（地址栏里的真实检索词，用于标题与女优查询）
 *      和 `searchQuery`（输入框受控值，用户可随时改动但未提交）。
 */
import { useLocation } from "wouter";
import { useState, useEffect, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { ArrowLeft, Search, User } from "lucide-react";
import VideoCard from "@/components/VideoCard";

/**
 * 视频搜索结果的前端视图模型。
 *
 * 字段基本对应 drizzle/schema.ts 的 videos 表，但全部放宽为可选，
 * 因为数据来自 videosV2.list 的松散返回结构（不同版本字段可能缺失）。
 *
 * @property videoUrl 作为 VideoCard 的 previewUrl（悬停预览），不是播放地址
 * @property actress  关联女优数组；注意后端有 `actress` 和 `actresses` 两种命名，渲染时做了兼容
 */
interface SearchResult {
  id: number;
  title: string;
  description?: string | null;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  duration?: number | null;
  category?: string | null;
  views?: number;
  rating?: number;
  createdAt?: string;
  actress?: any[];
}

/**
 * 女优搜索结果的前端视图模型（trpc.actresses.search 的返回元素）。
 *
 * @property japaneseName 日文名，优先于 name 展示；跳转时也优先用它作为新的检索词
 * @property videoCount   该女优的作品数，展示在头像下方
 */
interface ActressResult {
  id: number;
  name: string;
  japaneseName?: string | null;
  profileImageUrl?: string | null;
  videoCount: number;
}

/**
 * 综合搜索结果页组件。
 *
 * 权限：public（视频列表与女优搜索均为 publicProcedure；searchHistory.save 若需登录，
 *       失败时不影响页面主流程，因为用的是 fire-and-forget 的 `mutate`）。
 *
 * 内部状态职责：
 *   - searchQuery      顶部搜索框的受控值（用户正在编辑的词，未必等于已生效的检索词）
 *   - results          客户端过滤 + 排序后的视频结果，渲染网格的唯一数据源
 *   - isLoading        搜索进行中标志
 *   - selectedCategory 分类筛选（null = 全部），变化会重新触发搜索
 *   - sortBy           排序方式：newest（配信开始日）/ popular（浏览量）/ rating（评分）
 *
 * 副作用：写 search_history 表（每次成功搜索一次）。
 */
export default function SearchResultsPage() {
  const [, navigate] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"newest" | "popular" | "rating">("newest");

  // 筛选下拉的固定分类列表（硬编码，未与数据库 videos.category 的实际取值联动）
  const categories = ["中出し", "巨乳", "人妻・主婦", "新作"];

  // Get search query from URL
  // 从地址栏解析已生效的检索词。注意依赖项是 `window.location.search` ——
  // 它不是 React 状态，wouter 的软跳转不会让该表达式重新求值成新引用，
  // 因此本 useMemo 实际依赖的是「组件因其它原因重渲染」这一时机。
  const urlQuery = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("q") || "";
  }, [window.location.search]);

  // Actress search query
  // 女优检索走服务端匹配；空检索词时禁用，避免打一次无意义的全量请求
  const actressSearchQuery = trpc.actresses.search.useQuery(
    { query: urlQuery },
    { enabled: urlQuery.length > 0 }
  );

  // Get videos query
  // enabled: false —— 这条 query 不自动执行，只由 performSearch 里的 refetch() 手动驱动，
  // 这样「输入关键词 / 改筛选 / 改排序」才能统一收敛到一个搜索入口。
  // limit: 100 —— 客户端过滤的取数上限，也是本页搜索能覆盖的最大视频数（见文件头注释坑 #1）
  const videosQuery = trpc.videosV2.list.useQuery(
    { limit: 100, offset: 0 },
    { enabled: false }
  );

  const saveHistoryMutation = trpc.searchHistory.save.useMutation();

  /**
   * 执行一次视频搜索：拉取视频 → 客户端关键词过滤 → 分类过滤 → 排序 → 落地到 results，
   * 最后异步记录一条搜索历史。
   *
   * @param query 关键词（大小写不敏感，做子串匹配）
   * 副作用：设置 isLoading / results；写 search_history 表。
   *         异常时把 results 清空并在控制台打日志，不向用户展示错误。
   */
  const performSearch = async (query: string) => {
    setIsLoading(true);
    try {
      // Get all videos and filter by search query
      const videosResponse = await videosQuery.refetch();
      
      if (videosResponse.data) {
        // ---- 第 1 步：关键词过滤（纯客户端）----
        // 把「标题 + 描述 + 分类」拼成一条检索文本，另把关联女优的中/日文名拼成第二条，
        // 任一命中即算匹配。全部转小写做大小写不敏感的子串匹配（无分词、无模糊纠错）。
        // `video.actresses || video.actress` 是为了兼容 V1/V2 两套路由不同的字段命名。
        let filtered = videosResponse.data.filter((video: any) => {
          const searchText = `${video.title || ""} ${video.description || ""} ${video.category || ""}`.toLowerCase();
          // Also check actress names
          const actressNames = (video.actresses || video.actress || [])
            .map((a: any) => `${a.name || ""} ${a.japaneseName || ""}`)
            .join(" ")
            .toLowerCase();
          return searchText.includes(query.toLowerCase()) || actressNames.includes(query.toLowerCase());
        });
        
        // Apply category filter
        // ---- 第 2 步：分类精确匹配（null 表示「すべて」，跳过本步）----
        if (selectedCategory) {
          filtered = filtered.filter((video: any) => video.category === selectedCategory);
        }
        
        // Apply sorting
        // ---- 第 3 步：排序 ----
        // 三种排序都用「降序」比较（b - a）：最新在前 / 播放量高在前 / 评分高在前。
        // 各字段都做了 `|| 0` 兜底，防止 undefined 参与运算得到 NaN 导致排序结果不稳定。
        // 注意这里是原地 sort，filtered 本身就是 filter 产生的新数组，不会污染 query 缓存。
        filtered.sort((a: any, b: any) => {
          if (sortBy === "newest") {
            return (new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
          } else if (sortBy === "popular") {
            return (b.views || 0) - (a.views || 0);
          } else if (sortBy === "rating") {
            return (b.rating || 0) - (a.rating || 0);
          }
          return 0;
        });
        
        setResults(filtered);
        
        // Save search to history
        // fire-and-forget：用 mutate 而非 mutateAsync，不 await 也不处理失败 ——
        // 写历史失败不应影响搜索结果的展示
        saveHistoryMutation.mutate({
          query,
          searchType: "text",
          resultsCount: filtered.length,
        });
      }
    } catch (error) {
      console.error("Search error:", error);
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Get search query from URL params
  // 依赖链：[selectedCategory, sortBy, urlQuery]
  //   - urlQuery 变化        → 用户提交了新检索词（或从别的页面带 q 跳进来）
  //   - selectedCategory 变化 → 换了分类筛选
  //   - sortBy 变化          → 换了排序方式
  // 三者任一变化都重跑整条「refetch → 过滤 → 排序」流水线（因为筛选/排序都在客户端做）。
  // 同时把地址栏里的 q 同步回搜索框，保证刷新/前进后退时输入框内容与 URL 一致。
  // 无清理函数：performSearch 内部没有可取消的订阅；若旧请求慢于新请求，
  // 后返回者会覆盖 results（存在竞态，未做请求序号防护）。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("q") || "";
    setSearchQuery(query);
    
    if (query) {
      performSearch(query);
    }
  }, [selectedCategory, sortBy, urlQuery]);

  /**
   * 顶部搜索框提交：先把检索词写回 URL（保证可分享/可回退），再立刻执行一次搜索。
   *
   * 这里同时做 navigate 和 performSearch 是**有意的冗余**：
   * 上面的 useEffect 依赖 urlQuery，而 urlQuery 由 `window.location.search` 派生，
   * 软跳转未必能可靠地重新触发它，所以直接补一次调用兜底。
   *
   * @param e 表单 submit 事件
   */
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery)}`);
      performSearch(searchQuery);
    }
  };

  // 女优结果直接取自服务端查询缓存（无本地加工）；未命中或未请求时为空数组
  const matchedActresses: ActressResult[] = actressSearchQuery.data || [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Navigation */}
      <nav className="border-b border-slate-800 bg-slate-950/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/")}
              className="text-slate-400 hover:text-white"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              戻る
            </Button>
            <h1 className="text-xl font-bold text-white">検索結果</h1>
          </div>
        </div>
      </nav>

      {/* Search Section */}
      <section className="py-8 bg-gradient-to-b from-slate-900 to-slate-950 border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4">
          <h2 className="text-2xl font-bold text-white text-center mb-6">
            {urlQuery}の検索結果
          </h2>
          <form onSubmit={handleSearch} className="max-w-2xl mx-auto">
            <div className="flex items-center gap-2 bg-white rounded-lg p-2">
              <Search className="w-5 h-5 text-slate-400" />
              <input
                type="text"
                placeholder="検索キーワードを入力..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 border-0 bg-white text-slate-900 placeholder-slate-400 focus:ring-0 outline-none px-2"
              />
              <button
                type="submit"
                className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-1 rounded transition-colors"
              >
                検索
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* Actress Profiles Section - MISSAV Style */}
      {/* 横向可滚动的圆形头像条；点击某位女优会以其（日文）名作为新检索词再搜一次，
          相当于「按女优下钻」。仅在有命中时才渲染整个区块 */}
      {matchedActresses.length > 0 && (
        <section className="py-8 border-b border-slate-800">
          <div className="max-w-7xl mx-auto px-4">
            <div className="flex items-center overflow-x-auto gap-8 pb-4 scrollbar-hide">
              {matchedActresses.map((actress) => (
                <Link
                  key={actress.id}
                  href={`/search?q=${encodeURIComponent(actress.japaneseName || actress.name)}`}
                  className="flex flex-col items-center flex-shrink-0 group cursor-pointer"
                >
                  {/* Circular Profile Image */}
                  <div className="w-24 h-24 md:w-28 md:h-28 rounded-full overflow-hidden border-2 border-slate-700 group-hover:border-purple-500 transition-colors mb-3 bg-slate-800">
                    {actress.profileImageUrl ? (
                      <img
                        src={actress.profileImageUrl}
                        alt={actress.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <User className="w-10 h-10 text-slate-500" />
                      </div>
                    )}
                  </div>
                  {/* Name */}
                  <span className="text-sm text-white font-medium text-center group-hover:text-purple-400 transition-colors whitespace-nowrap">
                    {actress.japaneseName || actress.name}
                  </span>
                  {/* Video Count */}
                  <span className="text-xs text-slate-400 mt-0.5">
                    {actress.videoCount} ビデオ
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Filters and Sorting - MISSAV Style */}
      {/* 两个原生 <select> 被 appearance-none 去掉了浏览器默认箭头，
          改用绝对定位的 ▼ 字符（pointer-events-none 以免挡住点击）。
          option 需单独加 bg-slate-800，否则展开时在部分浏览器里会是系统白底 */}
      <section className="py-4 border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="relative">
              <select
                value={selectedCategory || ""}
                onChange={(e) => setSelectedCategory(e.target.value || null)}
                className="appearance-none bg-transparent text-white text-sm font-medium cursor-pointer pr-6 focus:outline-none"
              >
                <option value="" className="bg-slate-800">フィルタ: すべて</option>
                {categories.map((cat) => (
                  <option key={cat} value={cat} className="bg-slate-800">フィルタ: {cat}</option>
                ))}
              </select>
              <span className="absolute right-0 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">▼</span>
            </div>
            <div className="relative">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="appearance-none bg-transparent text-white text-sm font-medium cursor-pointer pr-6 focus:outline-none"
              >
                <option value="newest" className="bg-slate-800">並び替え: 配信開始日</option>
                <option value="popular" className="bg-slate-800">並び替え: 人気順</option>
                <option value="rating" className="bg-slate-800">並び替え: 評価順</option>
              </select>
              <span className="absolute right-0 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">▼</span>
            </div>
          </div>
        </div>
      </section>

      {/* Results Section */}
      <section className="py-8">
        <div className="max-w-7xl mx-auto px-4">
          <div className="mb-4">
            <p className="text-slate-400 text-sm">
              {isLoading ? "検索中..." : `${results.length}件の動画が見つかりました`}
            </p>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-slate-400">検索中...</div>
            </div>
          ) : results.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* actresses 字段兼容：V2 返回 `actresses`，V1 返回 `actress`，
                  这里用 as any 绕过 SearchResult 接口只声明了 `actress` 的限制 */}
              {results.map((video) => (
                <VideoCard
                  key={video.id}
                  id={video.id}
                  title={video.title}
                  thumbnailUrl={video.thumbnailUrl || undefined}
                  previewUrl={video.videoUrl || undefined}
                  duration={video.duration || undefined}
                  category={video.category || undefined}
                  actresses={video.actress || (video as any).actresses}
                  rating={video.rating}
                  views={video.views}
                />
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <Search className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                <p className="text-slate-400">検索結果が見つかりません</p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
