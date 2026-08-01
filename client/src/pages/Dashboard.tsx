/**
 * Dashboard — 普通用户个人仪表盘（UI 层 / 页面组件）
 *
 * 架构角色：
 *   前端「页面」层，对应路由 `/dashboard`。展示登录用户的个人资料与三类活动记录
 *   （聊天历史 / 搜索历史 / 收藏）。与 ActressManagementPage（管理后台）是两条完全
 *   不同的线：本页走 Manus OAuth 身份（useAuth），不涉及 adminAuth。
 *
 * 主要导出：
 *   - default Dashboard — 无 props 的整页组件，外层套 DashboardLayout（提供侧边栏/导航壳）。
 *
 * 上游：client/src/App.tsx 路由表。
 * 下游：
 *   - useAuth()                → OAuth 用户信息与 loading 态
 *   - useLanguage()            → 当前语言（ja/zh/en），驱动本页内置的翻译表
 *   - trpc.chat.getHistory     → 聊天历史（protected）
 *   - trpc.favorites.list      → 收藏列表（protected）
 *   - DashboardLayout          → 页面骨架
 *
 * 关键设计决策与坑：
 *   1. 本页的多语言文案**没有**用 client/src/locales/translations.ts，而是在组件内内联了一份
 *      translations 对象。新增语言或改文案时要注意两处不同步。
 *   2. 搜索历史目前被硬编码为空数组（见下方注释），Tab 永远显示空态 —— 后端 search 路由
 *      虽有历史记录能力，但本页尚未接线。
 *   3. 所有 query 都带 `enabled: !!user`，避免未登录时发出必然 401 的请求。
 */
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { useLanguage } from "@/contexts/LanguageContext";
import { Loader2, Heart, Clock, Search } from "lucide-react";

/**
 * 用户仪表盘组件。
 *
 * 权限：protected —— 数据端点均为 protectedProcedure；本页自身不做重定向，
 *       未登录时 user 为空、query 被 enabled 短路，界面呈现空态。
 *
 * 内部状态：本组件无 useState，全部状态来自 useAuth / useLanguage / tRPC query 缓存。
 * 副作用：只读，无任何写库/写 S3/调 LLM 操作。
 */
export default function Dashboard() {
  const { user, loading } = useAuth();
  const { language } = useLanguage();
  
  // Get chat history
  // limit: 10 —— 仪表盘只做「最近活动」摘要，完整对话请到 /chat 页查看
  const { data: chatHistory, isLoading: chatLoading } = trpc.chat.getHistory.useQuery(
    { limit: 10 },
    { enabled: !!user }
  );

  // Note: Search history is now managed through the search router
  // 搜索历史尚未接线：这里用常量空数组 + 常量 false 占位，
  // 让下方 Tab 的渲染分支结构保持与另外两个 Tab 一致（未来接上 query 时改动最小）。
  // 当前效果：搜索历史 Tab 永远显示 noSearchHistory 空态。
  const searchHistory: unknown[] = [];
  const searchLoading = false;

  // Get favorites
  const { data: favorites, isLoading: favoritesLoading } = trpc.favorites.list.useQuery(
    { limit: 10 },
    { enabled: !!user }
  );

  /**
   * 页面内置的三语文案表（ja/zh/en）。
   *
   * 注意：这是本页私有的翻译副本，与 client/src/locales/translations.ts 相互独立。
   * 键名即语义标识，取值由下方 `t` 按当前 language 选中。
   */
  const translations = {
    ja: {
      dashboard: "ダッシュボード",
      welcome: "ようこそ",
      chatHistory: "チャット履歴",
      searchHistory: "検索履歴",
      favorites: "お気に入り",
      recentActivity: "最近のアクティビティ",
      noChatHistory: "チャット履歴がありません",
      noSearchHistory: "検索履歴がありません",
      noFavorites: "お気に入りがありません",
      userProfile: "ユーザープロフィール",
      email: "メール",
      role: "ロール",
      language: "言語",
      joinedDate: "参加日",
    },
    zh: {
      dashboard: "仪表板",
      welcome: "欢迎",
      chatHistory: "聊天历史",
      searchHistory: "搜索历史",
      favorites: "收藏夹",
      recentActivity: "最近的活动",
      noChatHistory: "没有聊天历史",
      noSearchHistory: "没有搜索历史",
      noFavorites: "没有收藏",
      userProfile: "用户资料",
      email: "电子邮件",
      role: "角色",
      language: "语言",
      joinedDate: "加入日期",
    },
    en: {
      dashboard: "Dashboard",
      welcome: "Welcome",
      chatHistory: "Chat History",
      searchHistory: "Search History",
      favorites: "Favorites",
      recentActivity: "Recent Activity",
      noChatHistory: "No chat history",
      noSearchHistory: "No search history",
      noFavorites: "No favorites",
      userProfile: "User Profile",
      email: "Email",
      role: "Role",
      language: "Language",
      joinedDate: "Joined Date",
    },
  };

  // 按当前语言取文案；language 来自 LanguageContext，可能是未收录的值，故以英文兜底
  const t = translations[language as keyof typeof translations] || translations.en;

  // 鉴权态未确定时先渲染骨架（仍套 DashboardLayout，避免布局跳动）
  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-96">
          <Loader2 className="animate-spin" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Welcome Section */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold">{t.welcome}, {user?.name}!</h1>
          <p className="text-muted-foreground mt-2">{t.recentActivity}</p>
        </div>

        {/* User Profile Card */}
        <Card>
          <CardHeader>
            <CardTitle>{t.userProfile}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">{t.email}</p>
                <p className="font-medium">{user?.email}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t.role}</p>
                <p className="font-medium capitalize">{user?.role}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t.language}</p>
                <p className="font-medium">{language.toUpperCase()}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t.joinedDate}</p>
                <p className="font-medium">
                  {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "-"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Activity Tabs */}
        {/* 三个 Tab 共用同一套「loading → 有数据 → 空态」三分支渲染模板 */}
        <Tabs defaultValue="chat" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="chat">{t.chatHistory}</TabsTrigger>
            <TabsTrigger value="search">{t.searchHistory}</TabsTrigger>
            <TabsTrigger value="favorites">{t.favorites}</TabsTrigger>
          </TabsList>

          {/* Chat History Tab */}
          <TabsContent value="chat">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4" />
                  {t.chatHistory}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {chatLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="animate-spin" />
                  </div>
                ) : chatHistory && chatHistory.length > 0 ? (
                  <div className="space-y-3">
                    {chatHistory.map((msg) => (
                      <div
                        key={msg.id}
                        className="p-3 rounded-lg bg-muted/50 border border-border"
                      >
                        <p className="text-sm font-medium capitalize text-muted-foreground">
                          {msg.role}
                        </p>
                        <p className="text-sm mt-1 line-clamp-2">{msg.content}</p>
                        <p className="text-xs text-muted-foreground mt-2">
                          {new Date(msg.createdAt).toLocaleString()}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center py-8 text-muted-foreground">{t.noChatHistory}</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Search History Tab */}
          <TabsContent value="search">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Search className="w-4 h-4" />
                  {t.searchHistory}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {searchLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="animate-spin" />
                  </div>
                ) : searchHistory && searchHistory.length > 0 ? (
                  <div className="space-y-3">
                    {/* searchHistory 目前恒为空数组，本分支是为将来接入 search 历史预留的模板。
                        item 类型为 any 且各字段均做了兜底，因为数据源尚未定型。
                        key 用 `Math.random()` 兜底会导致每次渲染都换 key（整块重挂载），
                        接线时应改为稳定主键。 */}
                    {searchHistory.map((item: any) => (
                      <div
                        key={item?.id || Math.random()}
                        className="p-3 rounded-lg bg-muted/50 border border-border"
                      >
                        <p className="text-sm font-medium">{item?.query || 'Search'}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {item?.searchType || 'text'} • {item?.resultsCount || 0} results
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {item?.createdAt ? new Date(item.createdAt).toLocaleString() : 'N/A'}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center py-8 text-muted-foreground">{t.noSearchHistory}</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Favorites Tab */}
          <TabsContent value="favorites">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Heart className="w-4 h-4" />
                  {t.favorites}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {favoritesLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="animate-spin" />
                  </div>
                ) : favorites && favorites.length > 0 ? (
                  <div className="space-y-3">
                    {favorites.map((fav) => (
                      <div
                        key={fav.id}
                        className="p-3 rounded-lg bg-muted/50 border border-border"
                      >
                        {/* 后端 getUserFavorites 实际返回的是 JOIN 出来的**视频行**
                            （`result.map(r => r.video)`），所以这里的 fav 就是一条 video：
                              - fav.id 是视频 ID（因此 "Video #id" 语义正确，但 fav.title 可用却没用上）
                              - fav.createdAt 是**视频的创建时间**，不是用户的收藏时间
                                （列表按 favorites.createdAt 排序，展示的却是 videos.createdAt） */}
                        <p className="text-sm font-medium">Video #{fav.id}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {new Date(fav.createdAt).toLocaleString()}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center py-8 text-muted-foreground">{t.noFavorites}</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
