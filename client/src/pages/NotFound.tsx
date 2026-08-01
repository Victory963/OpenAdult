/**
 * NotFound — 404 兜底页（UI 层 / 页面组件）
 *
 * 架构角色：
 *   前端「页面」层最末端的 catch-all 路由。在 client/src/App.tsx 的路由表中
 *   注册为最后一条无 path 的 <Route>，任何未匹配的前端路径都会落到这里。
 *   注意它只处理 **前端路由** 未命中；服务端 404（如 /api/* 打错）由 Express 直接返回。
 *
 * 主要导出：
 *   - default NotFound — 无 props、无数据请求、无副作用的纯静态展示组件。
 *
 * 上游：client/src/App.tsx 路由表。
 * 下游：仅依赖 wouter 的 useLocation 做客户端跳转，不调用任何 tRPC 接口。
 *
 * 注意：本页是唯一使用浅色配色（slate-50/white）的页面，与站点默认暗色主题不一致；
 *       文案也是英文硬编码，未接入 LanguageContext。属于框架脚手架遗留页面。
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Home } from "lucide-react";
import { useLocation } from "wouter";

/**
 * 404 页面组件。
 *
 * 权限：public（无鉴权）。
 * 副作用：无（不写库、不写 S3、不调 LLM）。
 */
export default function NotFound() {
  const [, setLocation] = useLocation();

  /** 点击「Go Home」：用 wouter 做客户端软跳转回首页，不触发整页刷新 */
  const handleGoHome = () => {
    setLocation("/");
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
      <Card className="w-full max-w-lg mx-4 shadow-lg border-0 bg-white/80 backdrop-blur-sm">
        <CardContent className="pt-8 pb-8 text-center">
          {/* 图标层叠：底层是脉冲动画的红色圆形光晕（absolute inset-0），
              上层是实心告警图标（relative 保证盖在光晕之上） */}
          <div className="flex justify-center mb-6">
            <div className="relative">
              <div className="absolute inset-0 bg-red-100 rounded-full animate-pulse" />
              <AlertCircle className="relative h-16 w-16 text-red-500" />
            </div>
          </div>

          <h1 className="text-4xl font-bold text-slate-900 mb-2">404</h1>

          <h2 className="text-xl font-semibold text-slate-700 mb-4">
            Page Not Found
          </h2>

          <p className="text-slate-600 mb-8 leading-relaxed">
            Sorry, the page you are looking for doesn't exist.
            <br />
            It may have been moved or deleted.
          </p>

          <div
            id="not-found-button-group"
            className="flex flex-col sm:flex-row gap-3 justify-center"
          >
            <Button
              onClick={handleGoHome}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg transition-all duration-200 shadow-md hover:shadow-lg"
            >
              <Home className="w-4 h-4 mr-2" />
              Go Home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
