/**
 * ActressManagementPage — 管理后台总入口（UI 层 / 页面组件）
 *
 * 架构角色：
 *   前端「页面」层，对应路由 `/actress-management`。尽管文件名叫 ActressManagement，
 *   它实际上是**整个管理后台的外壳（shell）**：负责管理员准入校验 + 顶部导航 + Tab 分发，
 *   具体业务全部委托给 client/src/components/ 下的各个管理 UI 组件。
 *
 * 主要导出：
 *   - default ActressManagementPage — 无 props 的整页组件。
 *
 * 上游：client/src/App.tsx 路由表；AdminLoginPage 登录成功后跳转到这里。
 *
 * 下游（Tab → 子组件映射）：
 *   - gallery      → VideosPageV2        （复用前台视频列表页做「動画ギャラリー」预览）
 *   - upload       → VideoUploadForm     （视频上传，含分片上传流程）
 *   - videos       → VideoManagementUI   （视频 CRUD）
 *   - actresses    → ActressManagementUI （女优 CRUD + 人脸特征）
 *   - ads          → AdManagementUI      （广告素材 / 投放位管理）
 *   - credentials  → AdminCredentialsForm（修改管理员账号密码）
 *
 * 依赖的 tRPC 端点：
 *   - trpc.adminAuth.me     → 判定当前会话是否为管理员（准入闸门）
 *   - trpc.adminAuth.logout → 清除管理员会话 Cookie
 *
 * 关键设计决策：
 *   1. 这里刻意**不用** Manus OAuth 的 useAuth()，而是用独立的 adminAuth 会话
 *      （见 CLAUDE.md「管理员双认证」）。两套身份互不干扰。
 *   2. 准入判断是「三态」渲染：加载中 → 认证中提示；非管理员 → 拦截卡片；管理员 → 后台。
 *      前端拦截只是体验层，真正的数据保护由后端 adminProcedure 负责。
 *   3. Tab 状态只存在内存里，未同步到 URL，刷新页面会退回默认的 gallery。
 */
"use client";

import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Film, Upload, Edit2, Image as ImageIcon, KeyRound, LogOut, Megaphone } from "lucide-react";
import VideoUploadForm from "@/components/VideoUploadForm";
import ActressManagementUI from "@/components/ActressManagementUI";
import VideoManagementUI from "@/components/VideoManagementUI";
import AdminCredentialsForm from "@/components/AdminCredentialsForm";
import AdManagementUI from "@/components/AdManagementUI";
import VideosPageV2 from "./VideosPageV2";

/**
 * 管理后台外壳组件。
 *
 * 权限：admin —— 依赖 adminAuth.me 返回的 isAdmin 做前端准入；
 *       后台各子组件调用的写操作端点在服务端仍是 adminProcedure。
 *
 * 内部状态职责：
 *   - activeTab 当前选中的后台面板，取值为六个字面量之一，决定底部渲染哪个子组件
 *
 * 副作用：logout 会让后端清除管理员会话 Cookie，并跳回首页。
 */
export default function ActressManagementPage() {
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<"gallery" | "upload" | "videos" | "actresses" | "ads" | "credentials">("gallery");

  const utils = trpc.useUtils();

  // Use admin-specific auth (not Manus OAuth)
  // retry: false —— 未登录时后端返回错误/未授权是「预期结果」而非网络故障，
  //   重试只会拖慢拦截页的出现速度；
  // refetchOnWindowFocus: false —— 后台操作常在多标签页间切换，
  //   频繁重新校验会造成界面闪烁（loading 态 → 内容态反复切换）
  const adminMeQuery = trpc.adminAuth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const logoutMutation = trpc.adminAuth.logout.useMutation({
    onSuccess: async () => {
      // 先失效 me 缓存再跳转，否则返回后台时会短暂看到「已登录」的旧状态
      await utils.adminAuth.me.invalidate();
      navigate("/");
    },
  });

  // Show loading state while checking admin session
  // 准入三态之一：会话校验进行中。此处必须先于 isAdmin 判断返回，
  // 否则首帧 data 还是 undefined，会误判成「非管理员」并闪现拦截页
  if (adminMeQuery.isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center">
        <div className="text-slate-400">認証確認中...</div>
      </div>
    );
  }

  // Block access if not admin
  // 准入三态之二：会话不存在或非管理员 → 渲染拦截卡片并引导去 /admin-login。
  // 用可选链是因为 query 出错时 data 为 undefined（retry:false 下会很快到达这里）
  if (!adminMeQuery.data?.isAdmin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center">
        <Card className="bg-slate-800 border-slate-700 max-w-md">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3 text-red-400 mb-4">
              <AlertCircle className="w-6 h-6" />
              <p>管理者のみアクセス可能です</p>
            </div>
            <Button
              onClick={() => navigate("/admin-login")}
              className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
            >
              管理者ログインへ
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // 准入三态之三：确认是管理员，渲染完整后台。
  // 走到这里 adminMeQuery.data 一定非空，所以下方可以安全地直接读 .username
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      {/* Header */}
      {/* sticky + z-40：Tab 栏在长列表（如视频管理）滚动时始终可见 */}
      <div className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur border-b border-slate-700">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-bold text-white">管理画面</h1>
            <div className="flex items-center gap-3">
              <span className="text-slate-400 text-sm">
                管理者: <span className="text-purple-400">{adminMeQuery.data.username}</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => logoutMutation.mutate()}
                disabled={logoutMutation.isPending}
                className="border-slate-600 text-slate-300 hover:text-white hover:border-red-500"
              >
                <LogOut className="w-4 h-4 mr-1" />
                ログアウト
              </Button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-2 flex-wrap">
            <Button
              variant={activeTab === "gallery" ? "default" : "outline"}
              onClick={() => setActiveTab("gallery")}
              className={activeTab === "gallery" ? "bg-purple-600" : ""}
            >
              <Film className="w-4 h-4 mr-2" />
              動画ギャラリー
            </Button>
            <Button
              variant={activeTab === "upload" ? "default" : "outline"}
              onClick={() => setActiveTab("upload")}
              className={activeTab === "upload" ? "bg-purple-600" : ""}
            >
              <Upload className="w-4 h-4 mr-2" />
              動画アップロード
            </Button>
            <Button
              variant={activeTab === "videos" ? "default" : "outline"}
              onClick={() => setActiveTab("videos")}
              className={activeTab === "videos" ? "bg-purple-600" : ""}
            >
              <Edit2 className="w-4 h-4 mr-2" />
              動画管理
            </Button>
            <Button
              variant={activeTab === "actresses" ? "default" : "outline"}
              onClick={() => setActiveTab("actresses")}
              className={activeTab === "actresses" ? "bg-purple-600" : ""}
            >
              <ImageIcon className="w-4 h-4 mr-2" />
              女優管理
            </Button>
            <Button
              variant={activeTab === "ads" ? "default" : "outline"}
              onClick={() => setActiveTab("ads")}
              className={activeTab === "ads" ? "bg-purple-600" : ""}
            >
              <Megaphone className="w-4 h-4 mr-2" />
              広告管理
            </Button>
            <Button
              variant={activeTab === "credentials" ? "default" : "outline"}
              onClick={() => setActiveTab("credentials")}
              className={activeTab === "credentials" ? "bg-purple-600" : ""}
            >
              <KeyRound className="w-4 h-4 mr-2" />
              認証設定
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      {/* Tab 分发：用条件渲染而非 <Tabs> 组件，因此切换 Tab 会**卸载**上一个子组件，
          其内部 state（表单草稿、上传进度等）不会保留 —— 这是有意的，避免后台各面板互相串状态 */}
      <div className="max-w-7xl mx-auto px-4 py-8">
        {activeTab === "gallery" && <VideosPageV2 />}
        {activeTab === "upload" && <VideoUploadForm />}
        {activeTab === "videos" && <VideoManagementUI />}
        {activeTab === "actresses" && <ActressManagementUI />}
        {activeTab === "ads" && <AdManagementUI />}
        {activeTab === "credentials" && (
          <div className="max-w-lg">
            <AdminCredentialsForm />
          </div>
        )}
      </div>
    </div>
  );
}
