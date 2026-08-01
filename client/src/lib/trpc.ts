/**
 * ============================================================================
 * client/src/lib/trpc.ts — tRPC React 客户端绑定 (UI 层 / 数据访问入口)
 * ============================================================================
 *
 * 架构角色：
 *   前端访问后端的唯一类型安全通道。项目约定「前端不直接 fetch/axios」，
 *   所有 API 调用都经由此处导出的 `trpc` 对象。
 *
 * 主要导出物：
 *   - trpc : createTRPCReact<AppRouter>() 的产物，提供
 *            · trpc.Provider              —— 在 main.tsx 中包裹整棵树
 *            · trpc.createClient(...)     —— 创建带链路配置的客户端
 *            · trpc.<router>.<proc>.useQuery / useMutation / useInfiniteQuery
 *            · trpc.useUtils()            —— 手动读写/失效缓存（见 useAuth）
 *
 * 上下游依赖：
 *   ← main.tsx（创建 client 并挂 Provider）、几乎所有 pages/ 与 components/
 *   → server/routers.ts 的 AppRouter 类型
 *
 * 关键设计决策与坑：
 *   - 这里用的是**相对路径** `../../../server/routers` 而非 `@/` 别名，
 *     因为它要跨出 client/ 目录引用服务端代码。
 *   - 该 import 必须是 `import type`：只借用类型，不会把任何服务端代码
 *     （数据库驱动、S3 SDK、密钥读取）打进前端 bundle。一旦误写成值导入，
 *     Vite 会尝试打包 server/ 整棵依赖树并泄漏服务端实现。
 *   - 类型是从服务端"流向"客户端的：改动 server/routers/* 的输入输出后，
 *     前端调用处会立刻出现类型错误，这是本项目主要的接口契约保障手段。
 */

import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../../server/routers";

export const trpc = createTRPCReact<AppRouter>();
