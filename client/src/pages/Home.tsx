/**
 * ============================================================================
 * client/src/pages/Home.tsx — 站点首页（搜索入口 + 分类推荐流）
 * ============================================================================
 *
 * 架构层级：**前端 UI 页面层**。在 `client/src/App.tsx` 中挂载于路由 `/`，
 * 是未登录游客与已登录用户共用的落地页。
 *
 * ## 页面职责
 * 1. **导航栏**：根据登录态 / 管理员态切换按钮组（聊天、女優検索、動画、管理画面 或 ログイン）。
 * 2. **搜索区（MISSAV 风格）**：一个纯前端搜索框，回车或点击按钮时
 *    先落一条搜索历史，再跳转到 `/search?q=...` 由 `SearchResultsPage` 真正执行检索。
 * 3. **搜索历史条**：展示去重后的最近文本搜索词，可一键清空。
 * 4. **分类推荐流**：6 个横向分类区块（おすすめ / 中出し / 巨乳 / 人妻・主婦 / 新作 / ランダム），
 *    每块调用一次 `videosV2.list`，**仅在已登录时启用**（V2 是 protectedProcedure）。
 * 5. **页脚**：品牌信息、占位友链、以及非管理员可见的「管理者ログイン」入口。
 *
 * ## 主要导出
 * - `default Home`         —— 页面组件（无 props，路由级组件）。
 * - `VideoCategory`（模块内私有）—— 单个分类区块的展示组件。
 *
 * ## 上下游依赖
 * - 上游：`client/src/App.tsx` 的 wouter 路由表。
 * - 下游 tRPC procedure：
 *   - `adminAuth.me`        （public）    读管理员 cookie，决定导航栏显示「管理画面」还是「ダッシュボード」
 *   - `auth.me`             （public）    读 OAuth 登录态
 *   - `videosV2.list`       （protected） 分类视频流 ×6
 *   - `searchHistory.list / save / delete / clearAll` （protected）
 *   - `recommendations.list / generate` （protected）
 * - 下游组件：`@/components/VideoCard`；工具：`@/lib/videoUrl` 的 `resolvePreviewUrl`。
 *
 * ## 关键设计决策 / 坑
 * - **双套认证并存**：`auth.me`（Manus OAuth，决定内容可见性）与
 *   `adminAuth.me`（独立管理员密码，决定后台入口可见性）互不影响，必须分别查询。
 * - **登录门禁**：所有 `videosV2.*` 查询都带 `enabled: isAuthenticated`。这不是性能优化，
 *   而是**必需的** —— videosV2 是 `protectedProcedure`，游客调用会直接 UNAUTHORIZED。
 *   因此游客看到的首页只有搜索框，没有任何视频流。
 * - **推荐降级链**：优先用 `recommendations.list`（LLM + 本地打分产出的个性化结果），
 *   为空时回落到 `videosV2.list(sortBy:"popular")`，保证首屏永不空白。
 * - **搜索历史在跳转前写入**，此时还不知道命中数，故 `resultsCount` 恒为 0（见下方注释）。
 * - 文案全部为日文硬编码（本页未接入 `LanguageContext` 的 i18n）。
 */
import { Button } from "@/components/ui/button";
import { Link, useLocation } from "wouter";
import { MessageCircle, Search, Heart, BarChart3, Users, Zap, Film, Upload, Smile } from "lucide-react";
import VideoCard from "@/components/VideoCard";
import { resolveVideoUrl, resolvePreviewUrl } from "@/lib/videoUrl";
import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";

/**
 * 首页组件（路由 `/`）。
 *
 * @props 无 —— 路由级组件，所有数据均通过 tRPC hooks 自取。
 * @副作用 读多个 tRPC query；用户交互时写搜索历史（mutation）；登录按钮触发整页跳转到 OAuth 门户。
 * @权限 页面本身对所有人开放；视频流部分依赖 `protectedProcedure`，游客不可见。
 */
export default function Home() {
  // wouter 的编程式导航：只取第二个元素（navigate），当前 location 用不到。
  const [, navigate] = useLocation();
  // 登录态镜像。之所以复制到本地 state 而不是直接用 `Boolean(meQuery.data)`，
  // 是为了让下面 6 个 `enabled: isAuthenticated` 的 query 有一个稳定的开关引用。
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [recentVideos, setRecentVideos] = useState<any[]>([]);
  // 搜索框受控输入；提交后不清空，方便用户在历史条与输入框之间来回修改。
  const [searchQuery, setSearchQuery] = useState("");

  
  // 管理员认证（独立密码体系，与 Manus OAuth 完全并行）。
  // 只影响导航栏 / 页脚里后台入口的显示，不参与内容鉴权。
  // retry:false —— 未登录时必然返回 isAdmin:false，重试没有意义；
  // refetchOnWindowFocus:false —— 避免切标签页时反复打接口。
  // Query admin auth status (separate from Manus OAuth)
  const adminMeQuery = trpc.adminAuth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  // OAuth 登录态。返回 null 即视为游客（同样禁用重试与聚焦刷新）。
  // Query user auth status directly
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  // 把 query 结果同步进本地 state。
  // 触发时机：`auth.me` 首次返回、或缓存失效后重新返回时各跑一次。
  // 无需清理函数（纯 setState，不注册任何订阅 / 定时器）。
  useEffect(() => {
    setIsAuthenticated(Boolean(meQuery.data));
    setIsLoading(meQuery.isLoading);
  }, [meQuery.data, meQuery.isLoading]);

  // ==========================================================================
  // 分类视频流：6 个独立的 videosV2.list 查询
  // --------------------------------------------------------------------------
  // 之所以拆成 6 次请求而不是一次批量接口：videosV2.list 只支持「单分类 + 单排序」，
  // 没有提供多分类聚合的 procedure。tRPC/React Query 会把它们并发发出，
  // 且各自独立缓存 —— 某一类失败不影响其余区块渲染。
  //
  // 参数约定：
  //   limit: 6  —— 与 VideoCategory 的 4 列栅格搭配，桌面端 1.5 行、移动端 3 行，视觉不留空档。
  //   offset: 0 —— 首页只展示头部内容，翻页交给 `/videos` 列表页。
  //   enabled: isAuthenticated —— **必需**，videosV2 是 protectedProcedure（见文件头说明）。
  //   retry: false —— 未登录时的 UNAUTHORIZED 是确定性失败，重试只会放大无效请求。
  //
  // category 字段是**日文分类名原文**，直接与 videos.category 列做等值匹配，
  // 因此这些字符串必须与后台录入的分类名逐字一致，改动前需先核对数据库现有取值。
  // ==========================================================================
  // Fetch videos by category
  const recommendedQuery = trpc.videosV2.list.useQuery(
    { limit: 6, offset: 0, sortBy: "popular" },
    { enabled: isAuthenticated, retry: false }
  );

  const creampieQuery = trpc.videosV2.list.useQuery(
    { limit: 6, offset: 0, category: "中出し", sortBy: "newest" },
    { enabled: isAuthenticated, retry: false }
  );

  const bustQuery = trpc.videosV2.list.useQuery(
    { limit: 6, offset: 0, category: "巨乳", sortBy: "newest" },
    { enabled: isAuthenticated, retry: false }
  );

  const matureQuery = trpc.videosV2.list.useQuery(
    { limit: 6, offset: 0, category: "人妻・主婦", sortBy: "newest" },
    { enabled: isAuthenticated, retry: false }
  );

  const newQuery = trpc.videosV2.list.useQuery(
    { limit: 6, offset: 0, category: "新作", sortBy: "newest" },
    { enabled: isAuthenticated, retry: false }
  );

  // ⚠️ 注意：本查询的入参与上面的 `recommendedQuery` 完全相同（popular / limit 6 / offset 0），
  // React Query 会按 [procedure, input] 做缓存键，因此两者命中同一份缓存，
  // 「ランダム」区块实际展示的与「おすすめ」兜底内容一致，并不随机（详见交付说明的 observations）。
  const randomQuery = trpc.videosV2.list.useQuery(
    { limit: 6, offset: 0, sortBy: "popular" },
    { enabled: isAuthenticated, retry: false }
  );

  // 搜索历史：取 20 条是为了给下方的「过滤 + 去重」留出余量，
  // 最终只渲染去重后的前 8 条（见搜索框下方的 IIFE）。
  // Fetch search history
  const searchHistoryQuery = trpc.searchHistory.list.useQuery(
    { limit: 20 },
    { enabled: isAuthenticated, retry: false }
  );

  // 删除单条历史。服务端会先校验记录归属再删除（防越权）。
  // 注：当前 UI 未提供单条删除按钮，此 mutation 处于未接线状态。
  // Delete search history
  const deleteHistoryMutation = trpc.searchHistory.delete.useMutation({
    onSuccess: () => {
      searchHistoryQuery.refetch();
    },
  });

  // 清空全部历史（垃圾桶图标）。成功后手动 refetch 让历史条立即消失，
  // 而不是等待 React Query 的缓存自然失效。
  // Clear all search history
  const clearAllHistoryMutation = trpc.searchHistory.clearAll.useMutation({
    onSuccess: () => {
      searchHistoryQuery.refetch();
    },
  });

  // 写入一条搜索历史。此处**故意不配 onSuccess 刷新**：
  // 提交后立刻跳转到 /search，当前页面即将卸载，刷新列表没有意义。
  // Save search history
  const saveHistoryMutation = trpc.searchHistory.save.useMutation();

  // 个性化推荐（只读）。服务端不会因这次读取而触发生成，
  // 用户从未生成过推荐时返回空数组，由下面的降级逻辑接管。
  // Fetch recommendations
  const recommendationsQuery = trpc.recommendations.list.useQuery(
    { limit: 6 },
    { enabled: isAuthenticated, retry: false }
  );

  // 重新生成推荐（会调用 LLM 并清空重写该用户的推荐表）。
  // 刻意**不在页面加载时自动触发** —— 生成流水线开销大（LLM ×1 + 全量重写），
  // 首页每次访问都跑会造成明显成本与延迟。
  // onError 静默吞掉：推荐属于锦上添花，失败时应无声降级到热门视频，不打扰用户。
  // 注：目前没有任何 UI 会调用它，是预留的手动刷新入口。
  // Generate recommendations (only called explicitly, not on page load)
  const generateRecommendationsMutation = trpc.recommendations.generate.useMutation({
    onSuccess: () => {
      recommendationsQuery.refetch();
    },
    onError: () => {
      // Silently ignore all errors from recommendation generation
    },
  });

  // 推荐降级链：个性化推荐 → 热门视频。
  // 判空必须同时检查 data 存在与长度大于 0：新用户的推荐表为空数组，
  // 若只判 `data &&` 会渲染出一个空白区块。
  // Use recommendations if available, otherwise use popular videos
  const recommendedVideos = recommendationsQuery.data && recommendationsQuery.data.length > 0
    ? recommendationsQuery.data
    : recommendedQuery.data || [];

  /**
   * 发起 Manus OAuth 登录：拼装授权 URL 并整页跳转到门户。
   *
   * @副作用 修改 `window.location.href`（离开 SPA，无法用 wouter 导航替代 ——
   *         OAuth 门户是外部站点）。配置缺失或异常时弹 `alert` 提示。
   *
   * ## 流程
   *   本页 → OAuth 门户 `/app-auth` → 用户授权 → 门户重定向回
   *   `{origin}/api/oauth/callback` → 服务端换 token 并种 JWT Cookie → 回到站内。
   *
   * ## 参数说明
   * - `redirectUri` 用 `window.location.origin` 动态拼装，使同一份前端产物
   *   在本地、预览域名、生产域名下都能正确回跳（域名轮换场景尤其重要）。
   * - `state` 这里是 `btoa(redirectUri)`，服务端回调时解码即可知道该回哪个源站。
   *   ⚠️ 它是**可预测的确定值**，只承担「传递回跳地址」的职责，
   *   不具备 OAuth 规范中 state 应有的 CSRF 防护能力。
   * - `type=signIn` 让门户直接进入登录态而非注册引导页。
   *
   * 环境变量由 Vite 在**构建期**内联（`VITE_` 前缀才会暴露给浏览器），
   * 因此缺失时只能在运行期发现，故有下面的显式校验。
   */
  const handleLogin = () => {
    try {
      const oauthPortalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL;
      const appId = import.meta.env.VITE_APP_ID;
      
      if (!oauthPortalUrl || !appId) {
        console.error("OAuth configuration missing");
        alert("ログイン機能が利用できません。後ほど再度お試しください。");
        return;
      }
      
      const redirectUri = `${window.location.origin}/api/oauth/callback`;
      const state = btoa(redirectUri);
      const url = new URL(`${oauthPortalUrl}/app-auth`);
      url.searchParams.set("appId", appId);
      url.searchParams.set("redirectUri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("type", "signIn");
      
      window.location.href = url.toString();
    } catch (error) {
      console.error("Login error:", error);
      alert("ログイン処理中にエラーが発生しました。");
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Navigation */}
      <nav className="border-b border-slate-800 bg-slate-950/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-r from-purple-600 to-pink-600 rounded-lg flex items-center justify-center">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold text-white">OpenAdult</h1>
          </div>
          <div className="flex items-center gap-4">
            {isAuthenticated ? (
              <>
                <Link href="/chat">
                  <Button variant="outline" className="border-slate-700 text-slate-300 hover:text-white hover:border-slate-600">
                    <MessageCircle className="w-4 h-4 mr-2" />
                    チャット
                  </Button>
                </Link>
                <Link href="/face-search" className="text-decoration-none">
                  <Button variant="outline" className="border-slate-700 text-slate-300 hover:text-white">
                    <Smile className="w-4 h-4 mr-2" />
                    女優検索
                  </Button>
                </Link>
                <Link href="/videos" className="text-decoration-none">
                  <Button variant="outline" className="border-slate-700 text-slate-300 hover:text-white">
                    <Film className="w-4 h-4 mr-2" />
                    動画
                  </Button>
                </Link>
                {/*
                  主 CTA 按钮按「管理员密码认证」结果二选一：
                  管理员 → 后台管理入口；普通用户 → 个人仪表盘。
                  这里用的是 adminMeQuery（独立密码体系）而非 OAuth 的 user.role，
                  两套认证互不相通，务必不要换成 meQuery。
                */}
                {adminMeQuery.data?.isAdmin ? (
                  <Link href="/actress-management" className="text-decoration-none">
                    <Button className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700">
                      <Users className="w-4 h-4 mr-2" />
                      管理画面
                    </Button>
                  </Link>
                ) : (
                  <Link href="/dashboard" className="text-decoration-none">
                    <Button className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700">
                      ダッシュボード
                    </Button>
                  </Link>
                )}
              </>
            ) : (
              <Button
                onClick={handleLogin}
                className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
              >
                ログイン
              </Button>
            )}
          </div>
        </div>
      </nav>

      {/* MISSAV Style Hero Section */}
      <section className="py-12 bg-gradient-to-b from-slate-900 to-slate-950">
        <div className="max-w-7xl mx-auto px-4">
          {/* Search Section */}
          <div className="max-w-2xl mx-auto">
            <div className="text-center mb-6">
              <h1 className="text-3xl font-bold text-white mb-1">
                任意の検索 <span className="text-pink-500">JAV</span>
              </h1>
              <p className="text-slate-400 text-sm">
                無検閲のAI検索で理想の動画を発見
              </p>
            </div>

            {/*
              搜索框。提交有两个等价入口（回车 / 点击「検索」按钮），两处逻辑刻意保持一致：
                1) `searchQuery.trim()` 非空才响应，避免空查询污染历史；
                2) 先 `saveHistoryMutation.mutate(...)` 落历史（fire-and-forget，不等待返回），
                3) 再 `navigate()` 跳到 `/search`，由 SearchResultsPage 真正执行检索。
              注意 `resultsCount: 0` 是**占位值** —— 此刻结果尚未产生，
              真实命中数由服务端搜索入口自行再记一条历史。
              查询串必须经 `encodeURIComponent`：日文关键词与 `+` 组合语法都含 URL 保留字符。
            */}
            {/* Search Box */}
            <div className="relative">
              <div className="flex items-center bg-white rounded-lg overflow-hidden">
                <input
                  type="text"
                  placeholder="+ を使用して複数のキーワードを組み合わせる"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && searchQuery.trim()) {
                      saveHistoryMutation.mutate({
                        query: searchQuery,
                        searchType: "text",
                        resultsCount: 0,
                      });
                      navigate(`/search?q=${encodeURIComponent(searchQuery)}`);
                    }
                  }}
                  className="flex-1 border-0 bg-white text-slate-900 placeholder-slate-400 focus:ring-0 outline-none px-4 py-3"
                />
                <button
                  onClick={() => {
                    if (searchQuery.trim()) {
                      saveHistoryMutation.mutate({
                        query: searchQuery,
                        searchType: "text",
                        resultsCount: 0,
                      });
                      navigate(`/search?q=${encodeURIComponent(searchQuery)}`);
                    }
                  }}
                  className="flex items-center gap-1 px-4 py-3 text-slate-600 hover:text-slate-900 border-l border-slate-200 transition-colors"
                >
                  <Search className="w-4 h-4" />
                  <span className="text-sm">検索</span>
                </button>
              </div>
            </div>

            {/*
              搜索历史条（MISSAV 风格：常驻显示在搜索框正下方，不做折叠）。
              这里用 IIFE 而非抽成组件，是因为过滤/去重逻辑只服务于本处渲染，
              且需要在「过滤后为空」时整体返回 null（不留空白间距）。
            */}
            {/* Search History - Always visible below search box (MISSAV style) */}
            {isAuthenticated && searchHistoryQuery.data && (() => {
              // ------------------------------------------------------------------
              // 两级清洗，把 search_history 表里混杂的记录还原成「可点击的关键词」：
              //
              // 第 1 级 —— 剔除非文本检索：人脸检索 / 图像检索写入的 query 是
              //   JSON 字符串（形如 `{"imageUrl":"..."}` 或 `[...]`），直接展示会是一串乱码，
              //   点击后拼进 `/search?q=` 也毫无意义。判据是「searchType 为 text」或
              //   「内容不以 { / [ 开头」。
              //
              // 第 2 级 —— 按 query 文本去重：同一个词反复搜会产生多条记录，
              //   用 `seen` Set 保留最先出现的一条。由于服务端已按时间倒序返回，
              //   「最先出现」即「最近一次搜索」，符合用户预期。
              //
              // 注意：`seen` 必须声明在 filter 之外，靠闭包在遍历过程中累积状态。
              // ------------------------------------------------------------------
              // Filter out face search entries (JSON format) and deduplicate
              const seen = new Set<string>();
              const textHistory = searchHistoryQuery.data
                .filter((item: any) =>
                  item.searchType === "text" || (!item.query.startsWith("{") && !item.query.startsWith("["))
                )
                .filter((item: any) => {
                  if (seen.has(item.query)) return false;
                  seen.add(item.query);
                  return true;
                });
              // 全被过滤掉时不渲染容器，避免搜索框下方出现一段空白 margin。
              if (textHistory.length === 0) return null;
              return (
                <div className="mt-3 flex items-center justify-between w-full">
                  <div className="flex items-center gap-0 flex-wrap flex-1 min-w-0">
                    {/*
                      只取前 8 条：单行横排的视觉上限，再多会挤掉右侧的清空按钮。
                      分隔逗号用 `idx < len - 1` 判断，保证末项后面不留悬空逗号。
                    */}
                    {textHistory.slice(0, 8).map((item: any, idx: number) => (
                      <span key={item.id} className="flex items-center">
                        <button
                          className="text-sm text-amber-400 hover:text-amber-300 transition-colors"
                          onClick={() => {
                            setSearchQuery(item.query);
                            navigate(`/search?q=${encodeURIComponent(item.query)}`);
                          }}
                        >
                          {item.query}
                        </button>
                        {idx < textHistory.slice(0, 8).length - 1 && (
                          <span className="text-slate-500 mx-1">,</span>
                        )}
                      </span>
                    ))}
                  </div>
                  <button
                    onClick={() => clearAllHistoryMutation.mutate()}
                    className="text-slate-500 hover:text-red-400 transition-colors p-1 flex-shrink-0 ml-3"
                    title="履歴をすべて削除"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                </div>
              );
            })()}
          </div>
        </div>
      </section>

      {/*
        分类推荐流。整块用 `isAuthenticated` 门禁包裹：
        videosV2.list 是 protectedProcedure，游客即使渲染出来也只会拿到 UNAUTHORIZED，
        因此索性整段不渲染，游客首页只保留搜索入口。
        每个区块的 `reason` 文案是给用户看的「为什么推荐这些」，纯静态描述，不来自服务端。
      */}
      {/* Videos Section - MISSAV Style Categories */}
      {isAuthenticated && (
        <section className="max-w-7xl mx-auto px-4 py-12">
          {/* あなたにおすすめ */}
          <VideoCategory
            title="⭐ あなたにおすすめ"
            videos={recommendedVideos}
            reason="あなたの検索履歴と興味に基づいたパーソナライズ推奨"
          />
          
          {/* 中出し */}
          <VideoCategory
            title="💦 中出し"
            videos={creampieQuery.data || []}
            reason="中出しカテゴリの最新作品を厳選"
          />
          
          {/* 巨乳 */}
          <VideoCategory
            title="👙 巨乳"
            videos={bustQuery.data || []}
            reason="巨乳カテゴリの人気作を厳選"
          />
          
          {/* 人妻・主婦 */}
          <VideoCategory
            title="👩 人妻・主婦"
            videos={matureQuery.data || []}
            reason="人妻・主婦カテゴリの最新作を紹介"
          />
          
          {/* 新作 */}
          <VideoCategory
            title="🆕 新作"
            videos={newQuery.data || []}
            reason="最新リリースをいち早く推奨"
          />
          
          {/* ランダム */}
          <VideoCategory
            title="🎲 ランダム"
            videos={randomQuery.data || []}
            reason="予想外の作品を推奨"
          />
        </section>
      )}

      {/*
        功能介绍区。整块带 `hidden` 类被 CSS 隐藏（改版为 MISSAV 风格后不再展示），
        DOM 仍保留以便随时改回，删除前请确认没有其他地方依赖这些文案。
      */}
      {/* Features Section - Hidden for MISSAV style */}
      <section className="max-w-7xl mx-auto px-4 py-20 hidden">
        <h3 className="text-3xl font-bold text-white text-center mb-12">
          主な機能
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-6 hover:border-purple-600 transition">
            <MessageCircle className="w-8 h-8 text-purple-600 mb-4" />
            <h4 className="text-lg font-semibold text-white mb-2">AIチャット検索</h4>
            <p className="text-slate-400">Hereticモデルを搭載した完全無検閲のAIアシスタント</p>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-6 hover:border-purple-600 transition">
            <Search className="w-8 h-8 text-purple-600 mb-4" />
            <h4 className="text-lg font-semibold text-white mb-2">自然言語検索</h4>
            <p className="text-slate-400">自然な会話で動画を検索できる高度なNLPエンジン</p>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-6 hover:border-purple-600 transition">
            <Heart className="w-8 h-8 text-purple-600 mb-4" />
            <h4 className="text-lg font-semibold text-white mb-2">お気に入り管理</h4>
            <p className="text-slate-400">好みの動画を保存して、いつでもアクセス可能</p>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-6 hover:border-purple-600 transition">
            <BarChart3 className="w-8 h-8 text-purple-600 mb-4" />
            <h4 className="text-lg font-semibold text-white mb-2">スマート推奨</h4>
            <p className="text-slate-400">視聴履歴と嗜好に基づくパーソナライズされた推奨</p>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-6 hover:border-purple-600 transition">
            <Users className="w-8 h-8 text-purple-600 mb-4" />
            <h4 className="text-lg font-semibold text-white mb-2">女優プロフィール</h4>
            <p className="text-slate-400">詳細な女優情報と関連動画を一元管理</p>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-6 hover:border-purple-600 transition">
            <Zap className="w-8 h-8 text-purple-600 mb-4" />
            <h4 className="text-lg font-semibold text-white mb-2">続き再生</h4>
            <p className="text-slate-400">前回の再生位置から自動的に再開</p>
          </div>
        </div>
      </section>



      {/* MISSAV Style Footer Section */}
      <section className="bg-slate-900/50 border-t border-slate-800 py-16">
        <div className="max-w-7xl mx-auto px-4">
          {/* Back to Top Button */}
          <div className="text-center mb-12">
            <button className="text-slate-300 hover:text-white transition flex items-center justify-center mx-auto gap-2">
              <span>↑</span>
              <span>トップに戻る</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-8">
            {/* Left Column - Brand Info */}
            <div className="lg:col-span-1">
              <h3 className="text-white font-bold text-lg mb-3">OpenAdult</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                無検閲のAI検索で理想の成人動画を発見。ダウンロード不要で風速再生。
              </p>
            </div>

            {/* Links Columns */}
            <div>
              <h4 className="text-white font-semibold mb-3">リンク</h4>
              <ul className="space-y-2">
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">最近の更新</a></li>
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">新作</a></li>
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">無修正リーク</a></li>
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">英語字幕</a></li>
              </ul>
            </div>

            <div>
              <h4 className="text-white font-semibold mb-3">カテゴリ</h4>
              <ul className="space-y-2">
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">女優</a></li>
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">ジャンル</a></li>
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">メーカー</a></li>
              </ul>
            </div>

            <div>
              <h4 className="text-white font-semibold mb-3">その他</h4>
              <ul className="space-y-2">
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">お問い合わせ</a></li>
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">利用規約</a></li>
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">動画をアップロード</a></li>
              </ul>
            </div>

            <div>
              <h4 className="text-white font-semibold mb-3">パートナー</h4>
              <ul className="space-y-2">
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">ThePornDude</a></li>
                <li><a href="#" className="text-slate-400 hover:text-white text-sm transition">JerkDolls</a></li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-slate-950/50 py-8">
        <div className="max-w-7xl mx-auto px-4 text-center text-slate-400">
          <p>&copy; 2026 <span className="text-white font-semibold">OpenAdult</span></p>
          {/*
            管理员登录入口只对「尚未通过管理员认证」的访客显示 —— 已登录管理员
            导航栏已有「管理画面」按钮，此处再放一个入口会重复。
            注意这只是 UI 层的隐藏，`/admin-login` 路由本身始终可直接访问。
          */}
          {!adminMeQuery.data?.isAdmin && (
            <p className="mt-2">
              <Link href="/admin-login" className="text-slate-500 hover:text-slate-300 text-xs transition">
                管理者ログイン
              </Link>
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}

/**
 * 单个分类区块：标题 + 推荐理由 + 「すべて見る」入口 + 4 列视频栅格。
 *
 * 模块内私有组件（未导出），只被 Home 使用；纯展示，无内部状态、无副作用。
 *
 * @param props.title  区块标题，含 emoji 前缀（如 "⭐ あなたにおすすめ"）。
 * @param props.videos 视频数组。类型为 `any[]` 是因为它可能来自两个形状不同的来源：
 *                     `videosV2.list`（视频行）或 `recommendations.list`（推荐行），
 *                     两者字段并不完全一致，此处靠可选链式取值兼容。
 * @param props.reason 可选的「为什么推荐」说明文案，缺省时不渲染该行。
 * @returns 一个 mb-12 的区块；`videos` 为空时渲染 4 个占位骨架卡。
 */
function VideoCategory({ title, videos, reason }: { title: string; videos: any[]; reason?: string }) {
  return (
    <div className="mb-12">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-2xl font-bold text-white">{title}</h3>
          {reason && (
            <p className="text-sm text-slate-400 mt-2">💡 {reason}</p>
          )}
        </div>
        <Link href="/videos">
          <Button variant="outline" className="border-slate-700 text-slate-300 hover:text-white text-sm">
            すべて見る
          </Button>
        </Link>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {videos.length > 0 ? (
          videos.map((video: any, idx: number) => (
            // key 拼进 title 与 idx 而非只用 video.id：
            // 同一部视频可能同时出现在多个分类区块中，单用 id 会在 React 的兄弟节点间冲突；
            // 且推荐流返回的行有可能重复，加 idx 才能保证 key 全局唯一。
            <VideoCard
              key={`${title}-${video.id}-${idx}`}
              id={video.id}
              title={video.title}
              thumbnailUrl={video.thumbnailUrl}
              // 悬停预览地址需要经 resolvePreviewUrl 转换：分片上传的视频
              // videoUrl 形如 `multi-chunk:...`，浏览器无法直接播放，
              // 必须改指向 `/api/video-thumbnail/:id`（只取第一个分片）。
              previewUrl={resolvePreviewUrl(video.videoUrl, video.id)}
              duration={video.duration}
              category={video.category}
              actresses={video.actresses}
              rating={video.rating}
              views={video.views}
            />
          ))
        ) : (
          // 空态占位：渲染 4 张骨架卡（对应桌面端一整行），
          // 避免加载中或该分类无数据时区块高度塌陷、页面上下跳动。
          // ⚠️ 这些卡片带 hover / cursor-pointer 样式却无任何点击行为，
          // 视觉上容易被误认为真实内容（详见交付说明的 observations）。
          [1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-slate-900/50 border border-slate-800 rounded-lg overflow-hidden hover:border-purple-600 transition group cursor-pointer">
              <div className="relative h-40 bg-slate-800 flex items-center justify-center">
                <Film className="w-12 h-12 text-slate-600" />
              </div>
              <div className="p-3">
                <h4 className="text-xs font-semibold text-white truncate">動画 {i}</h4>
                <p className="text-xs text-slate-400 mt-1">女優名</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
