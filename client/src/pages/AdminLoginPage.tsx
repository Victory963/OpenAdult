/**
 * AdminLoginPage — 管理员登录页（UI 层 / 页面组件）
 *
 * 架构角色：
 *   前端「页面」层，对应路由 `/admin-login`。它服务于项目的**第二套认证体系**：
 *   站点普通用户走 Manus OAuth（useAuth / protectedProcedure），
 *   而管理后台走一套独立的用户名 + 密码认证（server/routers/admin-auth.ts），
 *   登录成功后由后端下发独立的管理员会话 Cookie。
 *   这样即使 OAuth 侧被打穿，也不会直接拿到后台权限。
 *
 * 主要导出：
 *   - default AdminLoginPage — 无 props 的整页表单组件。
 *
 * 上游：client/src/App.tsx 路由表；ActressManagementPage 在鉴权失败时会引导跳到本页。
 * 下游：
 *   - trpc.adminAuth.login → server/routers/admin-auth.ts（public procedure，校验密码后写会话 Cookie）
 *   - trpc.adminAuth.me    → 登录成功后被 invalidate，强制后台页重新拉取管理员身份
 *
 * 注意：密码通过 HTTPS + tRPC 明文字段提交，安全性依赖传输层；
 *       表单不做任何前端加密（后端负责哈希比对）。
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, Eye, EyeOff } from "lucide-react";

/**
 * 管理员登录表单组件。
 *
 * 权限：public（本页本身无需登录即可访问，否则无法登录）。
 *
 * 内部状态职责：
 *   - username / password  受控表单字段
 *   - showPassword         明文/密文切换（眼睛图标），仅影响 <Input type>
 *   - error                表单级错误提示，来源有二：前端空值校验、后端 mutation 报错
 *
 * 副作用：调用 adminAuth.login 会让后端写入管理员会话 Cookie；成功后跳转 `/actress-management`。
 */
export default function AdminLoginPage() {
  const [, navigate] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const utils = trpc.useUtils();

  const loginMutation = trpc.adminAuth.login.useMutation({
    onSuccess: async () => {
      // 必须先 invalidate adminAuth.me 再跳转：
      // 后台页 (ActressManagementPage) 用 me 查询做准入判断，
      // 若沿用登录前缓存的 "非管理员" 结果，跳过去会被立刻挡回登录页
      await utils.adminAuth.me.invalidate();
      navigate("/actress-management");
    },
    onError: (err) => {
      // 后端错误（密码错误 / 限流等）统一落到表单错误条；兜底日语文案
      setError(err.message || "ログインに失敗しました");
    },
  });

  /**
   * 表单提交：先做非空校验，再发起登录 mutation。
   *
   * @param e submit 事件，需 preventDefault 阻止浏览器原生表单提交导致整页刷新
   * 副作用：可能设置 error 状态；成功路径见 loginMutation.onSuccess。
   */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 每次提交先清空上一轮错误，避免旧错误残留造成误导
    setError(null);
    if (!username.trim() || !password.trim()) {
      setError("IDとパスワードを入力してください");
      return;
    }
    loginMutation.mutate({ username, password });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center p-4">
      <Card className="w-full max-w-md bg-slate-900 border-slate-700">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 bg-gradient-to-r from-purple-600 to-pink-600 rounded-full flex items-center justify-center mb-4">
            <Shield className="w-6 h-6 text-white" />
          </div>
          <CardTitle className="text-white text-2xl">管理者ログイン</CardTitle>
          <CardDescription className="text-slate-400">
            管理者専用ページです。IDとパスワードを入力してください。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username" className="text-slate-300">
                管理者ID
              </Label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder=""
                className="bg-slate-800 border-slate-600 text-white placeholder-slate-500 focus:border-purple-500"
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-slate-300">
                パスワード
              </Label>
              {/* relative 容器用于把「显示/隐藏密码」按钮绝对定位到输入框右内侧；
                  Input 的 pr-10 预留出这块空间，避免文字被图标压住。
                  按钮显式声明 type="button"，否则会被当作 submit 触发登录 */}
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder=""
                  className="bg-slate-800 border-slate-600 text-white placeholder-slate-500 focus:border-purple-500 pr-10"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded px-3 py-2">
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={loginMutation.isPending}
              className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white"
            >
              {loginMutation.isPending ? "ログイン中..." : "ログイン"}
            </Button>


          </form>
        </CardContent>
      </Card>
    </div>
  );
}
