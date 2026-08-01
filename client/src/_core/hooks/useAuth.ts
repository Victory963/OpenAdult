/**
 * ============================================================================
 * client/src/_core/hooks/useAuth.ts — 认证状态 Hook (框架核心 / UI 层)
 * ============================================================================
 *
 * 架构角色：
 *   位于 client/src/_core/ 下，属于**框架核心**代码（与服务端 server/_core/ 对应），
 *   非必要不应改动。它是前端读取"当前登录用户"的唯一入口，把
 *   tRPC 的 auth.me 查询 + auth.logout 变更封装成一个稳定的状态对象。
 *
 * 主要导出物：
 *   - useAuth(options) : 返回 { user, loading, error, isAuthenticated, refresh, logout }
 *
 * 上下游依赖：
 *   ← Home / Dashboard / ChatPage 等所有需要判断登录态的页面与组件
 *   → trpc.auth.me（protected 语义：未登录返回 null 而非抛错）
 *   → trpc.auth.logout（清除服务端会话 Cookie）
 *   → @/const#getLoginUrl（未登录时的跳转目标）
 *
 * 关键设计决策：
 *   - 用户信息**不落 React state**，而是完全依赖 React Query 缓存：
 *     多个组件同时调用 useAuth 只会产生一次网络请求，且登出后所有调用方
 *     通过缓存失效自动同步，无需额外的全局 store。
 *   - 未登录跳转是"可选行为"（redirectOnUnauthenticated），默认关闭，
 *     因为本站大部分页面（视频列表、搜索）允许游客浏览。
 */

import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useMemo } from "react";

/**
 * useAuth 的可选配置。
 * @property redirectOnUnauthenticated 为 true 时，确认未登录后自动整页跳转；
 *                                     用于 Dashboard 这类必须登录的页面。
 * @property redirectPath              跳转目标，默认取 getLoginUrl() 生成的
 *                                     OAuth 授权页绝对 URL。
 */
type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

/**
 * 读取并操作当前登录状态。
 *
 * @param options 见 UseAuthOptions；省略时不做任何自动跳转。
 * @returns
 *   - user            : 当前用户对象，未登录为 null
 *   - loading         : me 查询进行中或登出进行中
 *   - error           : 查询或登出的错误，二者取先非空者
 *   - isAuthenticated : user 是否存在的布尔快照
 *   - refresh()       : 主动重新拉取 auth.me（返回 refetch 的 Promise）
 *   - logout()        : 调用服务端登出并清空本地缓存
 *
 * 副作用：
 *   - 向 /api/trpc 发起 auth.me 请求；
 *   - logout() 会让服务端清除会话 Cookie（写操作）；
 *   - 每次状态变化会把用户信息写入 localStorage["manus-runtime-user-info"]；
 *   - 开启 redirectOnUnauthenticated 时会整页跳转。
 *
 * 权限级别：调用本 Hook 本身无需权限；auth.me 对游客返回 null 而非 401。
 */
export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath = getLoginUrl() } =
    options ?? {};
  // tRPC 的缓存操作句柄：用于手动 setData / invalidate auth.me
  const utils = trpc.useUtils();

  // retry:false —— 未登录属于"预期结果"而非临时故障，重试只会拖慢首屏并放大 401 噪音；
  // refetchOnWindowFocus:false —— 会话有效期以年计（ONE_YEAR_MS），
  //   每次切回标签页都重新校验没有收益，反而在多标签场景下产生大量请求。
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  // 登出成功后立刻把 me 缓存写成 null，让 UI 无需等待重新请求即切到游客态（乐观更新）
  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      utils.auth.me.setData(undefined, null);
    },
  });

  /**
   * 执行登出。
   *
   * 容错设计：若服务端返回 UNAUTHORIZED，说明会话本就已失效
   * （Cookie 过期、或用户在另一标签页已登出），此时"登出"目标其实已经达成，
   * 直接吞掉错误即可，不应把它冒泡成页面错误。其它错误则原样抛出交由调用方处理。
   *
   * finally 块保证无论成功、失败还是提前 return，本地缓存都被清空并标记失效：
   *   - setData(null)  立即切换 UI 到游客态；
   *   - invalidate()   触发后台重新校验，确保与服务端最终一致。
   */
  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch (error: unknown) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        return;
      }
      throw error;
    } finally {
      utils.auth.me.setData(undefined, null);
      await utils.auth.me.invalidate();
    }
  }, [logoutMutation, utils]);

  // 把 query/mutation 的多个原始字段收敛成一个语义化状态对象。
  // 注意：这里顺带把用户信息镜像写入 localStorage，键名 "manus-runtime-user-info"
  // 供 Manus 运行时（宿主环境的调试/埋点工具）读取，业务代码不应依赖它——
  // 真实数据源始终是 React Query 缓存。
  const state = useMemo(() => {
    localStorage.setItem(
      "manus-runtime-user-info",
      JSON.stringify(meQuery.data)
    );
    return {
      user: meQuery.data ?? null,
      loading: meQuery.isLoading || logoutMutation.isPending,
      error: meQuery.error ?? logoutMutation.error ?? null,
      isAuthenticated: Boolean(meQuery.data),
    };
  }, [
    meQuery.data,
    meQuery.error,
    meQuery.isLoading,
    logoutMutation.error,
    logoutMutation.isPending,
  ]);

  // 未登录自动跳转。逐条守卫缺一不可，顺序也有讲究：
  //   1. 未开启该选项 → 直接退出（游客可浏览的页面走这条）；
  //   2. 首次加载中 / 登出请求进行中 → user 暂时为空并不代表未登录，
  //      过早跳转会在页面刚打开时把已登录用户踢去登录页；
  //   3. 已有 user → 无需跳转；
  //   4. 无 window（SSR/测试）→ 无法跳转；
  //   5. 防止在目标页面上再次跳转，避免死循环。
  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (meQuery.isLoading || logoutMutation.isPending) return;
    if (state.user) return;
    if (typeof window === "undefined") return;
    if (window.location.pathname === redirectPath) return;

    // 用 window.location.href 整页跳转而非 wouter 路由：
    // 目标是站外的 OAuth 授权页，SPA 路由无法处理跨站导航。
    window.location.href = redirectPath
  }, [
    redirectOnUnauthenticated,
    redirectPath,
    logoutMutation.isPending,
    meQuery.isLoading,
    state.user,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
