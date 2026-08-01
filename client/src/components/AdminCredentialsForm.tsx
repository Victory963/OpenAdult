/**
 * ============================================================================
 * client/src/components/AdminCredentialsForm.tsx — 管理员账号密码修改表单（UI 组件层）
 * ============================================================================
 *
 * ## 架构定位
 * 属于**前端组件层**（client/src/components/）。是管理面板
 * `client/src/pages/ActressManagementPage.tsx` 中 `credentials` Tab 的唯一内容。
 *
 * 它服务的是 OpenAdult 的**第二套认证体系**（见 CLAUDE.md 设计决策 #4）：
 * - 第一套：Manus OAuth + `session` cookie（普通用户）
 * - 第二套（本组件）：用户名 + 密码 + `admin_session_id` cookie（管理面板专用）
 * 因此这里改的**不是** OAuth 用户密码，而是 `admin_credentials` 表中的管理员凭据。
 *
 * ## 主要导出
 * - `default AdminCredentialsForm` — 无 props 的自包含表单组件。
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/pages/ActressManagementPage.tsx`（activeTab === "credentials"）
 * - 下游依赖：
 *   - `trpc.adminAuth.changeCredentials`（mutation）→ server/routers/admin-auth.ts
 *   - `trpc.adminAuth.me`（成功后 invalidate，用于刷新页面顶部显示的管理员用户名）
 *
 * ## ⚠️ 关键设计决策与坑
 * 1. **后端默认凭据是 admin / admin**（首次登录时自动播种），部署后必须靠本表单立即改掉，
 *    否则管理面板等同于无防护。本组件因此是部署流程中的关键一环，而非可选功能。
 * 2. **表单文案为日语**（面向日本站点运营者），错误提示也是日语，不要改成中文。
 * 3. **前端校验与后端校验并存**：这里的「6 文字以上」只是提升体验的前置拦截，
 *    真正的强制约束在 server 端的 zod schema 里；两处若要调整需同步。
 * 4. **成功后不清空 `newUsername`**：见 onSuccess —— 只重置三个密码字段。
 *    这是为了让运营者能看到自己刚设的新 ID（详见 observations 中的说明）。
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyRound, CheckCircle } from "lucide-react";

/**
 * 管理员认证信息（ID / 密码）修改表单。
 *
 * 内部状态职责：
 * - `currentPassword`  — 当前密码，作为「二次确认」凭证提交给后端校验
 * - `newUsername`      — 新管理员 ID；**留空表示不修改用户名**（提交时转成 undefined）
 * - `newPassword`      — 新密码（前端要求 ≥ 6 位）
 * - `confirmPassword`  — 新密码二次输入，仅用于前端一致性比对，不会提交给后端
 * - `error`            — 前端校验失败或后端返回的错误文案（日语），null 表示无错误
 * - `success`          — 是否显示「変更しました」成功提示条
 *
 * 副作用：调用 `adminAuth.changeCredentials` 会**写数据库**（更新 admin_credentials 表），
 * 成功后 invalidate `adminAuth.me` 以刷新缓存中的管理员身份信息。
 *
 * @权限 admin —— 后端 procedure 通过「当前密码」而非 cookie 角色来授权；
 *                但本组件只在已登录管理面板的页面中渲染。
 * @returns 一张包含四个输入框 + 错误/成功提示 + 提交按钮的 Card
 */
export default function AdminCredentialsForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // tRPC 查询缓存操作句柄，用于修改成功后主动失效 adminAuth.me
  const utils = trpc.useUtils();

  /**
   * 提交凭据变更的 tRPC mutation。
   *
   * onSuccess 里刻意**只清空三个密码字段而保留 newUsername**：
   * 密码是敏感值，留在 DOM 里没有意义且有风险；而新 ID 留着可以让运营者
   * 肉眼确认「我刚才把 ID 改成了什么」，避免改完就忘导致锁死管理面板。
   *
   * invalidate(`adminAuth.me`) 是必要的：页面其它位置（如 ActressManagementPage 顶栏）
   * 缓存着旧用户名，若不失效会一直显示改名前的 ID，直到刷新页面。
   */
  const changeCredentialsMutation = trpc.adminAuth.changeCredentials.useMutation({
    onSuccess: async () => {
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await utils.adminAuth.me.invalidate();
    },
    onError: (err) => {
      // 后端 TRPCError 的 message 已是日语文案，可直接展示；兜底给一句通用失败提示
      setError(err.message || "変更に失敗しました");
    },
  });

  /**
   * 表单提交处理：先做三级前端校验，全部通过后才发起 mutation。
   *
   * 校验顺序（任一失败即 return，不发网络请求）：
   * 1. 当前密码非空 —— 后端必须靠它做二次确认，空值提交必然被拒
   * 2. 新密码 ≥ 6 位 —— 与后端 zod 的最小长度约束保持一致
   * 3. 两次新密码一致 —— 纯前端约束，`confirmPassword` 不会发送给后端
   *
   * @param e 表单 submit 事件；先 preventDefault 阻止浏览器整页刷新
   * @副作用 触发 changeCredentialsMutation → 写数据库
   */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 每次提交先清空上一轮的错误/成功提示，避免新旧状态叠加显示
    setError(null);
    setSuccess(false);

    if (!currentPassword.trim()) {
      setError("現在のパスワードを入力してください");
      return;
    }
    if (!newPassword.trim() || newPassword.length < 6) {
      setError("新しいパスワードは6文字以上で入力してください");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("新しいパスワードと確認用パスワードが一致しません");
      return;
    }

    // newUsername 传 undefined 而非空字符串：后端据此区分「不改用户名」与「改成空串」
    changeCredentialsMutation.mutate({
      currentPassword,
      newUsername: newUsername.trim() || undefined,
      newPassword,
    });
  };

  return (
    <Card className="bg-slate-800 border-slate-700">
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-purple-400" />
          <CardTitle className="text-white text-lg">管理者認証情報の変更</CardTitle>
        </div>
        <CardDescription className="text-slate-400">
          管理者のIDとパスワードを変更できます。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="currentPassword" className="text-slate-300">
              現在のパスワード
            </Label>
            <Input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="現在のパスワード"
              className="bg-slate-700 border-slate-600 text-white placeholder-slate-500 focus:border-purple-500"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="newUsername" className="text-slate-300">
              新しいID（変更しない場合は空白）
            </Label>
            <Input
              id="newUsername"
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="新しいID（省略可）"
              className="bg-slate-700 border-slate-600 text-white placeholder-slate-500 focus:border-purple-500"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="newPassword" className="text-slate-300">
              新しいパスワード（6文字以上）
            </Label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="新しいパスワード"
              className="bg-slate-700 border-slate-600 text-white placeholder-slate-500 focus:border-purple-500"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword" className="text-slate-300">
              新しいパスワード（確認）
            </Label>
            <Input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="パスワードを再入力"
              className="bg-slate-700 border-slate-600 text-white placeholder-slate-500 focus:border-purple-500"
            />
          </div>

          {error && (
            <div className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded px-3 py-2">
              {error}
            </div>
          )}

          {success && (
            <div className="flex items-center gap-2 text-green-400 text-sm bg-green-900/20 border border-green-800 rounded px-3 py-2">
              <CheckCircle className="w-4 h-4" />
              認証情報を変更しました
            </div>
          )}

          <Button
            type="submit"
            disabled={changeCredentialsMutation.isPending}
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white"
          >
            {changeCredentialsMutation.isPending ? "変更中..." : "変更を保存"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
