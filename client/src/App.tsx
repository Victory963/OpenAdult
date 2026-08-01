/**
 * ============================================================================
 * client/src/App.tsx — 应用根组件 (UI 层 / 路由与全局 Provider 装配)
 * ============================================================================
 *
 * 架构角色：
 *   位于 main.tsx（tRPC / React Query 基础设施）与各个 pages/* 之间的一层，
 *   负责两件事：
 *     1. 声明 URL → 页面组件 的映射表（Router）；
 *     2. 按正确顺序嵌套全局 Provider（错误边界、多语言、主题、Tooltip、Toast）。
 *
 * 主要导出物：
 *   - default App : 应用根组件，由 main.tsx 渲染。
 *   - Router      : 模块内私有组件，集中管理所有前端路由。
 *
 * 上下游依赖：
 *   ← main.tsx 渲染
 *   → ./components/ErrorBoundary、./contexts/*、@/components/ui/*
 *   → ./pages/*（所有页面均为静态 import，即打包进主 chunk，未做路由级懒加载）
 *
 * 关键设计决策与坑：
 *   - 路由库使用 **wouter** 而非 react-router（见 CLAUDE.md 前端约定）；
 *     wouter 的 <Switch> 按声明顺序匹配第一个命中的 <Route>，因此
 *     无 path 的兜底 <Route> 必须写在最后。
 *   - 页面全部静态导入：首屏 bundle 较大，但避免了动态 import 在
 *     域名轮换 / CDN 切换场景下 chunk 404 的问题。
 *   - **管理后台没有前端路由守卫**：/actress-management 等页面本身可直接打开，
 *     真正的鉴权发生在服务端 adminProcedure 与 admin-auth 路由。
 */

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { LanguageProvider } from "./contexts/LanguageContext"; 
import Home from "./pages/Home";
import ChatPage from "./pages/ChatPage";
import Dashboard from "./pages/Dashboard";
import FaceSearchPage from "./pages/FaceSearchPage";
import ActressManagementPage from "./pages/ActressManagementPage";
import VideosPage from "./pages/VideosPage";
import VideoDetailPage from "./pages/VideoDetailPage";
import SearchResultsPage from "./pages/SearchResultsPage";
import AdminLoginPage from "./pages/AdminLoginPage";

/**
 * 全站路由表。
 *
 * 权限说明：这些路由本身都是"公开可达"的，页面内部再根据 useAuth() 结果
 * 决定是否展示内容或跳转登录；管理类页面的实际权限校验在服务端完成。
 *
 * 路由清单：
 *   /                     首页：搜索框 + 分类入口 (Home)
 *   /chat                 AI 聊天推荐 (ChatPage)，需登录才能发消息
 *   /dashboard            用户仪表盘：收藏 / 历史 / 偏好 (Dashboard)
 *   /face-search          女优相似度检索，支持按名称或上传图片 (FaceSearchPage)
 *   /actress-management   管理面板入口，内含女优/视频/广告等 Tab (ActressManagementPage)
 *   /videos               视频列表 V1 (VideosPage)；V2 列表以组件形式嵌在管理面板里，无独立路由
 *   /video/:id            视频详情 + HLS 播放器；:id 为 videos 表主键
 *   /search               综合搜索结果页，查询词通过 query string 传入
 *   /admin-login          管理员独立密码登录页（与 OAuth 登录相互独立）
 *   /404                  显式 404 页，供代码内主动跳转使用
 *   （无 path）           兜底路由，未匹配到任何路径时渲染 NotFound
 */
function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/chat"} component={ChatPage} />
      <Route path={"/dashboard"} component={Dashboard} />
      <Route path={"/face-search"} component={FaceSearchPage} />
      <Route path={"/actress-management"} component={ActressManagementPage} />
      <Route path={"/videos"} component={VideosPage} />
      <Route path={"/video/:id"} component={VideoDetailPage} />
      <Route path={"/search"} component={SearchResultsPage} />
      <Route path={"/admin-login"} component={AdminLoginPage} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      {/* 兜底：wouter 的 Switch 顺序匹配，本行必须保持在最后一位 */}
      <Route component={NotFound} />
    </Switch>
  );
}

/**
 * 应用根组件。
 *
 * Provider 嵌套顺序是有意为之，由外到内：
 *   1. ErrorBoundary   —— 最外层，任何 Provider 或页面渲染抛错都能被兜住，
 *                         避免白屏（注意：它捕获不到 Promise/事件回调中的异步错误）。
 *   2. LanguageProvider—— 语言优先于主题，因为部分组件的文案在挂载时即需要 language。
 *   3. ThemeProvider   —— 显式传 defaultTheme="dark"：本站默认暗色主题；
 *                         未传 switchable，故 toggleTheme 为 undefined、主题被锁定为 dark。
 *   4. TooltipProvider —— shadcn/ui (Radix) 要求所有 Tooltip 共享一个 Provider 才能
 *                         统一控制 delayDuration 等行为。
 *   5. Toaster + Router—— Toaster (sonner) 必须与页面同级挂载一次，
 *                         之后任意组件调用 toast() 都会渲染到这个容器里。
 */
function App() {
  return (
    <ErrorBoundary>
      <LanguageProvider>
        <ThemeProvider defaultTheme="dark">
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </ThemeProvider>
      </LanguageProvider>
    </ErrorBoundary>
  );
}

export default App;
