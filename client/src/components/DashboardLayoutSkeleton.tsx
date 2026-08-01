/**
 * ============================================================================
 * client/src/components/DashboardLayoutSkeleton.tsx — 仪表盘骨架屏（UI 组件层）
 * ============================================================================
 *
 * ## 架构定位
 * 属于**前端组件层**（client/src/components/）中的「加载占位」类组件。
 * 纯展示、无状态、无 props、不发任何请求。
 *
 * ## 主要导出
 * - `DashboardLayoutSkeleton` — 与 DashboardLayout 结构同构的灰块占位界面。
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/components/DashboardLayout.tsx`
 *   —— 在 `useAuth()` 的 `loading === true` 期间（即 OAuth 会话校验还没返回时）渲染本组件，
 *      避免出现「先闪一下未登录页 → 再跳成已登录界面」的布局抖动。
 * - 下游依赖：`./ui/skeleton` 的 `Skeleton`（shadcn/ui 的脉冲动画占位块）。
 *
 * ## ⚠️ 关键设计决策与坑
 * 1. **尺寸必须与真实布局对齐**：侧栏写死 `w-[280px]`，对应 DashboardLayout 中的
 *    `DEFAULT_WIDTH = 280`。若那边改了默认宽度，这里也要同步改，否则加载完成的瞬间
 *    会看到侧栏横向跳动。这是一处**手工维护的耦合**，没有共享常量。
 * 2. 骨架块的高度（h-10 菜单项、h-9 头像、h-32 卡片…）都是对真实元素高度的近似模仿，
 *    数值本身没有语义，只为视觉上「形状对得上」。
 */
import { Skeleton } from './ui/skeleton';

/**
 * 仪表盘加载态骨架屏。
 *
 * 结构与 DashboardLayout 一一对应：
 * - 左侧固定 280px 侧栏：Logo 区 + 3 个菜单项 + 底部用户信息区
 * - 右侧主内容区：标题条 + 3 张统计卡片（响应式 1/2/3 列）+ 一块大内容区
 *
 * @returns 全屏（min-h-screen）的静态占位布局，无任何交互
 */
export function DashboardLayoutSkeleton() {
  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar skeleton —— 宽度 280px 必须与 DashboardLayout 的 DEFAULT_WIDTH 保持一致 */}
      <div className="w-[280px] border-r border-border bg-background p-4 space-y-6">
        {/* Logo area —— 对应真实布局里的「折叠按钮 + Navigation 标题」 */}
        <div className="flex items-center gap-3 px-2">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-4 w-24" />
        </div>

        {/* Menu items —— 固定占 3 行；真实菜单项数由 menuItems 决定，这里只是视觉近似 */}
        <div className="space-y-2 px-2">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>

        {/*
          User profile area at bottom —— 头像 + 用户名 + 邮箱两行文字的占位。
          注意：此处用 `absolute` 定位，但最近的祖先并没有 `relative`，
          因此实际是相对整个视口（initial containing block）定位的，
          在窄屏下可能与主内容区重叠（详见 observations，未做修改）。
        */}
        <div className="absolute bottom-4 left-4 right-4">
          <div className="flex items-center gap-3 px-1">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-2 w-32" />
            </div>
          </div>
        </div>
      </div>

      {/* Main content skeleton —— flex-1 吃掉侧栏之外的全部横向空间 */}
      <div className="flex-1 p-4 space-y-4">
        {/* Content blocks：标题条 → 三张统计卡（响应式 1/2/3 列）→ 一块大内容区 */}
        <Skeleton className="h-12 w-48 rounded-lg" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
