/**
 * ============================================================================
 * client/src/components/DashboardLayout.tsx — 仪表盘外壳布局（UI 布局组件层）
 * ============================================================================
 *
 * ## 架构定位
 * 属于**前端布局组件层**（client/src/components/）。它是「带侧边导航的后台页面」的通用外壳，
 * 同时承担三件事：
 *   1. **登录门禁** —— 未登录时不渲染 children，直接展示登录引导页
 *   2. **加载态** —— 会话校验期间渲染骨架屏，消除布局抖动
 *   3. **可拖拽侧栏** —— 宽度持久化到 localStorage
 *
 * ## 主要导出
 * - `default DashboardLayout` — 外层壳：处理 auth 分支 + 提供 SidebarProvider 与宽度 CSS 变量
 * - （内部）`DashboardLayoutContent` — 真正的侧栏 + 主区渲染，必须在 SidebarProvider 内部，
 *   因为它用到了 `useSidebar()`（折叠状态只能从 Provider 的 context 拿）
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/pages/Dashboard.tsx`（用它包裹页面内容）
 * - 下游依赖：
 *   - `@/_core/hooks/useAuth`（OAuth 会话状态与 logout）
 *   - `@/components/ui/sidebar`（shadcn/ui 的 Sidebar 体系）
 *   - `./DashboardLayoutSkeleton`（loading 占位）
 *   - `@/const` 的 `getLoginUrl()`（跳转 Manus OAuth 登录页）
 *   - `wouter` 的 `useLocation`（当前路由，用于高亮菜单项）
 *
 * ## ⚠️ 关键设计决策与坑
 * 1. **`menuItems` 是模板占位数据**（"Page 1" / "Page 2" → "/" 与 "/some-path"），
 *    尚未替换为 OpenAdult 的真实后台菜单。接入新页面时需要改这里（见 observations）。
 * 2. **侧栏宽度通过 CSS 变量 `--sidebar-width` 传给 SidebarProvider**，而不是 inline width：
 *    shadcn 的 Sidebar 内部多处（占位符、浮层、过渡）都读这个变量，直接改 style 会不同步。
 * 3. **拖拽期间 `disableTransition`**：否则 CSS transition 会让侧栏「追着鼠标慢半拍」，
 *    产生明显的橡皮筋延迟感。
 * 4. **localStorage 读取放在 useState 惰性初始化里**，只在首次挂载执行一次；
 *    SSR 环境下会因为访问 localStorage 而报错，但本项目是纯 SPA（Vite），不受影响。
 */
import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { getLoginUrl } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import { LayoutDashboard, LogOut, PanelLeft, Users } from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { Button } from "./ui/button";

/**
 * 侧边栏导航项定义（图标 / 文案 / 目标路径）。
 *
 * ⚠️ 目前仍是脚手架自带的**占位数据**，"Page 1" / "Page 2" 与 `/some-path`
 * 在 OpenAdult 中并不存在对应页面。接入真实后台菜单时改这里即可，
 * 渲染与高亮逻辑（`location === item.path`）无需变动。
 */
const menuItems = [
  { icon: LayoutDashboard, label: "Page 1", path: "/" },
  { icon: Users, label: "Page 2", path: "/some-path" },
];

/** localStorage 键名：跨会话记住用户拖拽出来的侧栏宽度 */
const SIDEBAR_WIDTH_KEY = "sidebar-width";
/** 默认侧栏宽度（px）。必须与 DashboardLayoutSkeleton 里写死的 w-[280px] 保持一致 */
const DEFAULT_WIDTH = 280;
/** 拖拽下限（px）：再窄就放不下「图标 + 文字」的菜单项，文字会被截断 */
const MIN_WIDTH = 200;
/** 拖拽上限（px）：防止用户把侧栏拖到几乎占满屏幕、主内容区无处可放 */
const MAX_WIDTH = 480;

/**
 * 仪表盘布局外壳。按 auth 状态分三条渲染路径：
 *   loading → 骨架屏；未登录 → 登录引导页；已登录 → SidebarProvider + 真实布局。
 *
 * @param children 已登录时渲染在主内容区（`<main>`）中的页面内容；
 *                 未登录/加载中时**完全不会被渲染**，因此子页面无需自己判断登录态。
 * @returns 整页布局元素
 * @副作用 侧栏宽度变化时写入 localStorage
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 惰性初始化：仅首次挂载时读一次 localStorage，避免每次 render 都碰同步存储 API
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  // 宽度持久化：拖拽过程中 sidebarWidth 会高频变化，这里每次变更都同步落盘。
  // localStorage 是同步 API，但写入量极小（一个数字字符串），实测无卡顿。
  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  // 会话校验尚未返回：先上骨架屏。若直接渲染登录页会出现「闪一下未登录」的抖动
  if (loading) {
    return <DashboardLayoutSkeleton />
  }

  // 未登录：不渲染 children，改为展示登录引导，点击后整页跳转到 Manus OAuth
  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <div className="flex flex-col items-center gap-6">
            <h1 className="text-2xl font-semibold tracking-tight text-center">
              Sign in to continue
            </h1>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              Access to this dashboard requires authentication. Continue to launch the login flow.
            </p>
          </div>
          <Button
            onClick={() => {
              window.location.href = getLoginUrl();
            }}
            size="lg"
            className="w-full shadow-lg hover:shadow-xl transition-all"
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  // 已登录：把宽度以 CSS 变量形式注入 SidebarProvider。
  // shadcn 的 Sidebar 内部（占位 div、fixed 浮层、折叠过渡）统一读取 --sidebar-width，
  // 所以必须走变量而不是给某个元素直接设 width，否则各层宽度会不同步。
  // 断言为 CSSProperties 是因为 TS 的 CSSProperties 不接受自定义属性名。
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

/**
 * DashboardLayoutContent 的 props 契约。
 * - `children`        页面主内容
 * - `setSidebarWidth` 由父组件下传的宽度 setter；宽度状态本身留在父组件，
 *                     因为 SidebarProvider 需要在更外层就拿到它来生成 CSS 变量
 */
type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

/**
 * 侧栏 + 主内容区的实际渲染体。
 *
 * **必须作为 SidebarProvider 的后代渲染** —— 它调用了 `useSidebar()`，
 * 折叠状态（expanded/collapsed）只存在于 Provider 的 context 中。
 * 这也是本文件拆成「外壳 + 内容」两个组件的唯一原因。
 *
 * 内部状态职责：
 * - `isResizing`     是否正处于拖拽调宽过程中（决定是否挂载全局鼠标监听）
 * - `sidebarRef`     指向侧栏外层容器，用于计算拖拽时的宽度基准（左边界）
 * - `isCollapsed`    从 `useSidebar()` 派生的折叠标志
 * - `activeMenuItem` 当前路由命中的菜单项，仅用于移动端顶栏显示标题
 *
 * @param props 见 DashboardLayoutContentProps
 * @returns Fragment：左侧 Sidebar（含拖拽把手）+ 右侧 SidebarInset
 */
function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeMenuItem = menuItems.find(item => item.path === location);
  const isMobile = useIsMobile();

  // 折叠时强制退出拖拽态：折叠后拖拽把手被 `hidden` 隐藏，
  // 若用户在按住把手的同时触发了折叠（如快捷键），isResizing 会永远卡在 true，
  // 导致 body 的 col-resize 光标和 userSelect:none 一直残留。
  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

  // ── 侧栏拖拽调宽的全局事件管理 ──────────────────────────────────────────
  // 监听必须挂在 document 而非把手元素上：鼠标快速拖动时指针会脱离那条 1px 宽的把手，
  // 只有全局监听才能持续收到 mousemove，也才能在指针落到窗口任意位置时正确结束拖拽。
  //
  // 依赖数组 [isResizing, setSidebarWidth]：
  //   - isResizing 变 true  → 挂载监听 + 把 body 光标锁成 col-resize、禁用文本选中
  //   - isResizing 变 false → 走 cleanup 卸载监听并还原 body 样式
  //   - setSidebarWidth 来自父组件的 useState setter，引用稳定，实际不会触发重跑
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      // 用侧栏容器的左边界作为基准，而不是直接用 e.clientX：
      // 侧栏未必贴在视口最左侧（未来若外面套了容器/边距，直接用 clientX 会算偏）
      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      // 超出 [MIN_WIDTH, MAX_WIDTH] 时不是 clamp 而是**直接丢弃**这次更新，
      // 效果上等于宽度停在边界值，鼠标可以继续移动而侧栏不动
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      // 拖拽期间锁定全局光标形状，并禁止文本选中——否则拖动会把页面文字整片选蓝
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    // cleanup 无条件执行（即使这次 effect 没挂载监听），removeEventListener
    // 对未注册的 handler 是 no-op，因此这样写是安全的，也保证 body 样式一定被还原
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        {/*
          collapsible="icon"：折叠后不是完全消失，而是缩成一条只剩图标的窄条。
          disableTransition={isResizing}：拖拽时关掉 CSS 过渡，否则宽度动画会
          让侧栏「追着鼠标慢半拍」，产生橡皮筋般的延迟感。
        */}
        <Sidebar
          collapsible="icon"
          className="border-r-0"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-16 justify-center">
            <div className="flex items-center gap-3 px-2 transition-all w-full">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4 text-muted-foreground" />
              </button>
              {!isCollapsed ? (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold tracking-tight truncate">
                    Navigation
                  </span>
                </div>
              ) : null}
            </div>
          </SidebarHeader>

          {/* 主导航区：菜单项高亮完全由「当前路由 === item.path」决定，无独立选中状态 */}
          <SidebarContent className="gap-0">
            <SidebarMenu className="px-2 py-1">
              {menuItems.map(item => {
                const isActive = location === item.path;
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setLocation(item.path)}
                      tooltip={item.label}
                      className={`h-10 transition-all font-normal`}
                    >
                      <item.icon
                        className={`h-4 w-4 ${isActive ? "text-primary" : ""}`}
                      />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarContent>

          {/*
            底部用户区：头像取用户名首字母大写作为 fallback（无头像图）。
            折叠态下靠 `group-data-[collapsible=icon]:hidden` 隐藏文字、只留头像。
          */}
          <SidebarFooter className="p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-accent/50 transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar className="h-9 w-9 border shrink-0">
                    <AvatarFallback className="text-xs font-medium">
                      {user?.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-medium truncate leading-none">
                      {user?.name || "-"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-1.5">
                      {user?.email || "-"}
                    </p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        {/*
          拖拽把手：贴在侧栏右缘、宽 1px 的透明竖条（hover 时显现淡色）。
          zIndex 50 是为了压在 Sidebar 自身内容之上，否则按不到；折叠态直接 hidden。
          onMouseDown 只负责「开启拖拽模式」，后续的移动/结束都由上面的全局 effect 处理。
        */}
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => {
            if (isCollapsed) return;
            setIsResizing(true);
          }}
          style={{ zIndex: 50 }}
        />
      </div>

      {/* 右侧主区。移动端额外加一条 sticky 顶栏（汉堡按钮 + 当前页标题），
          因为窄屏下侧栏是抽屉式的，没有常驻的展开入口 */}
      <SidebarInset>
        {isMobile && (
          <div className="flex border-b h-14 items-center justify-between bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1">
                  <span className="tracking-tight text-foreground">
                    {activeMenuItem?.label ?? "Menu"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        <main className="flex-1 p-4">{children}</main>
      </SidebarInset>
    </>
  );
}
