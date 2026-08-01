/**
 * ============================================================================
 * server/routers/actressManagement.ts — 女优**人脸特征（embedding）**管理路由 V1
 * ============================================================================
 *
 * 架构层级：**API 路由层**。在 `server/routers.ts` 中以 `actressManagement` 注册，
 * 前端通过 `trpc.actressManagement.*` 调用
 * （主要使用方：`client/src/components/ActressManagementUI.tsx` 管理面板）。
 *
 * ## 职责边界（容易混淆，务必分清）
 * 本文件**不做女优档案的 CRUD**，它只管 `actress_face_embeddings` 这张表 ——
 * 也就是「以图搜人」功能的特征底库：
 * - 女优档案的增删改查 → `./actress-management-v2.ts`（`actressManagementV2`）
 * - 女优公开查询/搜索   → `server/routers.ts` 内联的 `actresses` 路由
 * - 相似度检索（消费方）→ `./faceSearch.ts` + `server/search.ts`
 * 本文件是**写入端**（建库），faceSearch 是**读取端**（查库）。
 *
 * ## 主要导出
 * - `actressManagementRouter` —— 4 个 procedure：
 *   - `uploadActressFaceImage`      （public 声明 + handler 内 admin 校验）从图片提取人脸特征并 upsert 到底库
 *   - `getActressesWithEmbeddings`  （protected）列出已建库的女优（带姓名）
 *   - `getActressById`              （protected）按 ID 读女优档案
 *   - `deleteActressFaceEmbedding`  （protected + 手写 admin 检查）删除一条特征记录
 *
 * ## 上下游依赖
 * - 上游：`server/routers.ts` → Express `/api/trpc/actressManagement.*`
 * - 下游：
 *   - `../_core/faceRecognition` 的 `extractFaceEmbedding()` / `stringifyEmbedding()`
 *   - `../db` 的 `getDb()`；schema 中的 `actresses`、`actress_face_embeddings`
 *
 * ## 关键设计决策 / 坑
 * 1. **"embedding" 不是真正的人脸向量**：Node 端跑不了 face-api.js（依赖浏览器 DOM/Canvas），
 *    因此项目改用 **LLM 视觉分析**给出十余项面部特征打分（脸型/眼型/肤色/发长…），
 *    再把这些分数当作伪向量存起来做相似度比较。详见 `server/_core/faceRecognition.ts`。
 *    → 直接后果：`uploadActressFaceImage` 每次调用都会**产生一次 LLM 费用与秒级延迟**。
 * 2. **`uploadActressFaceImage` 声明为 `publicProcedure` 但在 handler 内自行鉴权**：
 *    管理面板走的是 `./admin-auth.ts` 的独立 admin-cookie 认证，与 OAuth 的 `ctx.user` 不互通，
 *    所以这里没法用 `protectedProcedure` / `adminProcedure` 中间件。
 *    修复：改为在 handler 第一行调用本文件的 `isAdminRequest(ctx)`（两套授权体系任一通过即可），
 *    与 `./ad-management.ts` 的 `verifyAdminFromCtx()` 用法一致 —— 中间件层放行、业务层拦截，
 *    匿名请求会拿到 `TRPCError FORBIDDEN`，不会再触发 LLM 调用或写库。
 * 3. **每位女优只保留一条 embedding**：靠"先查后写"实现 upsert 语义，而非数据库唯一约束
 *    （`actress_face_embeddings` 表上没有 unique index），并发上传时可能插出重复行。
 */
import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { actressFaceEmbeddings, actresses } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { extractFaceEmbedding, stringifyEmbedding } from "../_core/faceRecognition";
import { TRPCError } from "@trpc/server";
import { jwtVerify } from "jose";
import { ENV } from "../_core/env";
import { parse as parseCookieHeader } from "cookie";

/** 管理员会话 cookie 名，必须与 `./admin-auth.ts`、`./ad-management.ts` 中的常量保持一致 */
const ADMIN_COOKIE_NAME = "admin_session_id";
/** JWT issuer 声明，校验时会比对；同样需与 `./admin-auth.ts` 一致 */
const ADMIN_JWT_ISSUER = "openadult-admin";

/**
 * 派生管理员 JWT 的 HMAC 密钥（与 `./admin-auth.ts` 的 `getAdminJwtSecret()` 同构）。
 *
 * 在 `ENV.cookieSecret` 后拼 `"_admin"` 做域分离：管理员 token 与普通用户 session token
 * 用不同密钥，拿到一种也无法伪造另一种。
 */
function getAdminJwtSecret() {
  return new TextEncoder().encode(ENV.cookieSecret + "_admin");
}

/**
 * 判断当前请求是否具备管理员身份 —— 兼容项目里**并行的两套授权体系**：
 *   1. 管理面板的独立密码认证：`admin_session_id` cookie（由 `./admin-auth.ts` 签发）；
 *   2. Manus OAuth 体系：`ctx.user.role === "admin"`（即 `adminProcedure` 的判定依据）。
 * 任一成立即视为管理员，因此无论从管理面板还是从已登录的 admin 账号调用都不会被误拦。
 *
 * 实现与 `./ad-management.ts` 的 `verifyAdminFromCtx()` 一致（该函数未导出，故此处重写一份；
 * 三处 cookie 名 / issuer / 密钥推导必须同步修改，否则会出现「登录成功但接口全部 403」）。
 *
 * @param ctx tRPC context；只用到 `ctx.req.headers.cookie` 与 `ctx.user`
 * @returns 是管理员返回 true；缺 token、签名错、过期、issuer 不匹配且 OAuth 角色也不是 admin 时返回 false
 */
async function isAdminRequest(ctx: any): Promise<boolean> {
  if (ctx?.user?.role === "admin") return true;

  const cookies = parseCookieHeader(ctx?.req?.headers?.cookie || "");
  const token = cookies[ADMIN_COOKIE_NAME];
  if (!token) return false;
  try {
    await jwtVerify(token, getAdminJwtSecret(), { issuer: ADMIN_JWT_ISSUER });
    return true;
  } catch {
    return false;
  }
}

export const actressManagementRouter = router({
  /**
   * 上传女优人脸图片 → 提取特征 → upsert 进人脸底库。
   *
   * 这是「以图搜女优」功能的**建库入口**：只有在这里录入过 embedding 的女优，
   * 才可能出现在 `faceSearch` 的检索结果中。
   *
   * @权限 admin —— procedure 本身声明为 `publicProcedure`（因为管理面板用独立 admin-cookie
   *       认证、OAuth 的 `ctx.user` 在管理面板里为空，用不了 protectedProcedure/adminProcedure
   *       中间件），管理员判断改为在 handler 内用 `isAdminRequest(ctx)` 手写完成：
   *       admin-cookie 与 OAuth admin 角色**任一成立**即放行。**勿删那段检查**。
   * @param input.actressId   目标女优 ID，正整数；必须已存在于 actresses 表。
   * @param input.imageUrl    人脸图片 URL（通常是刚上传到 S3 后拿到的可访问地址）。
   * @param input.actressName 可选，仅为调用方便利，**当前实现完全未使用**。
   * @returns `{ success: true, message, actressId, actressName }`
   *          —— 返回的 actressName 取自数据库中的档案，不是入参。
   * @副作用 **调用 LLM ×1**（视觉分析，耗时秒级且产生费用）+ 写库 1 行（UPDATE 或 INSERT）。
   * @throws TRPCError FORBIDDEN —— 非管理员调用（在任何 LLM 调用与写库之前就被拦下）。
   * @throws "No face detected in image" —— LLM 未能识别出人脸（extractFaceEmbedding 返回 null）。
   * @throws "Actress not found" —— actressId 在 actresses 表中不存在。
   * @throws "Database not available"
   */
  // Upload actress face image and extract embedding
  // Using publicProcedure because admin panel uses separate admin-cookie auth
  // （鉴权不靠中间件，而是在 mutation 体内调 isAdminRequest —— 见下方「修复」注释）
  uploadActressFaceImage: publicProcedure
    .input(
      z.object({
        actressId: z.number().int().positive(),
        imageUrl: z.string().url(),
        actressName: z.string().min(1).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // 修复：本 procedure 原为纯 publicProcedure 且 handler 内无任何鉴权，
      // 导致匿名访客可任意覆盖人脸底库（污染 faceSearch 排序）并无限触发计费的 LLM 调用。
      // 现在改为手写管理员校验，用法与 ./ad-management.ts 的 verifyAdminFromCtx() 一致。
      // ⚠️ 必须放在函数最前面 —— 早于 getDb() / extractFaceEmbedding()，
      //    否则未授权请求仍会白白消耗数据库连接与 LLM 费用。删掉即等于把写库权限还给公网。
      if (!(await isAdminRequest(ctx))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Admin authentication required",
        });
      }

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // ===== 第 1 步：LLM 视觉分析提取"伪 embedding" =====
        // extractFaceEmbedding 内部让 LLM 对图片输出一组 0~100 的面部特征评分
        // （脸型/眼型/鼻型/唇厚/颧骨/下颌/肤色/发色发长…），再转成 Float32Array。
        // 这不是几何意义上的人脸向量，只是可比较的特征打分序列。
        // ⚠️ 顺序问题：这一步放在"校验女优是否存在"之前，
        //    因此传入一个不存在的 actressId 也会先白白烧掉一次 LLM 调用（见 observations）。
        // Extract face embedding from image
        const embedding = await extractFaceEmbedding(input.imageUrl);
        if (!embedding) {
          throw new Error("No face detected in image");
        }

        // 第 2 步：确认女优档案存在。这里同时也是为了拿 name 回填到返回值里。
        // Check if actress exists
        const actress = await db
          .select()
          .from(actresses)
          .where(eq(actresses.id, input.actressId))
          .limit(1);

        if (actress.length === 0) {
          throw new Error("Actress not found");
        }

        // ===== 第 3 步：应用层 upsert（先查后写）=====
        // 约定"一位女优只保留一条最新的人脸特征"。用先 SELECT 再决定 UPDATE/INSERT 实现，
        // 而不是 `ON DUPLICATE KEY UPDATE`，因为 actress_face_embeddings 表上
        // **没有 actressId 唯一索引**（见 drizzle/schema.ts）。
        // ⚠️ 由此带来 TOCTOU 竞态：同一女优并发上传两张图会双双走 INSERT 分支，
        //    留下两条 embedding，检索时该女优会被重复计分。
        // Check if embedding already exists for this actress
        const existingEmbedding = await db
          .select()
          .from(actressFaceEmbeddings)
          .where(eq(actressFaceEmbeddings.actressId, input.actressId))
          .limit(1);

        // 特征向量以 JSON 字符串形式落在 text 列（embedding 列无法直接存数组）。
        // 读取端（faceSearch）用对应的 parseEmbedding 还原。
        const embeddingString = stringifyEmbedding(embedding);

        if (existingEmbedding.length > 0) {
          // 已有记录 → 覆盖特征与源图 URL。
          // 按 actressId 而非主键 id 更新：万一历史数据里有多条重复记录，这会把它们一起刷新，
          // 保证底库不会残留旧特征。
          // Update existing embedding
          await db
            .update(actressFaceEmbeddings)
            .set({
              embedding: embeddingString,
              faceImageUrl: input.imageUrl,
            })
            .where(eq(actressFaceEmbeddings.actressId, input.actressId));

          return {
            success: true,
            message: "Actress face embedding updated successfully",
            actressId: input.actressId,
            actressName: actress[0].name,
          };
        } else {
          // 首次建库 → 插入新记录。
          // 未显式写 embeddingDimension，走列默认值 128（见 schema）；
          // 但 LLM 方案实际只产出十余个特征分，该字段与真实维度并不一致，仅作占位。
          // Insert new embedding
          await db.insert(actressFaceEmbeddings).values({
            actressId: input.actressId,
            embedding: embeddingString,
            faceImageUrl: input.imageUrl,
          });

          return {
            success: true,
            message: "Actress face embedding created successfully",
            actressId: input.actressId,
            actressName: actress[0].name,
          };
        }
      } catch (error) {
        console.error("[Actress Management] Error uploading face image:", error);
        throw error;
      }
    }),

  /**
   * 列出已建立人脸特征的女优（管理面板的「人脸底库」列表）。
   *
   * @权限 protected —— 需登录即可读；写入接口 `uploadActressFaceImage` 现已收紧到 admin，
   *       读宽写严，不再是此前「能读的人受限、能写的人不受限」的错配。
   * @param input.limit 返回条数，1~100，默认 50。
   * @returns 数组，每项 `{ id, actressId, actressName, faceImageUrl, createdAt }`。
   *          `id` 是 embedding 记录主键（删除时要传的就是它，不是 actressId）；
   *          女优档案已被删除时 `actressName` 兜底为字符串 `"Unknown"`。
   * @副作用 只读（2 次 SELECT）。
   * @throws "Database not available"
   *
   * 注意：**故意不 select `embedding` 列**——那是一大串 JSON 数字，
   * 前端列表用不上，传输它只会白白撑大响应体。
   */
  // Get all actresses with face embeddings
  getActressesWithEmbeddings: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        const embeddingsData = await db
          .select({
            id: actressFaceEmbeddings.id,
            actressId: actressFaceEmbeddings.actressId,
            faceImageUrl: actressFaceEmbeddings.faceImageUrl,
            createdAt: actressFaceEmbeddings.createdAt,
          })
          .from(actressFaceEmbeddings)
          .limit(input.limit);

        // ===== 装配女优姓名 =====
        // 这里把 actresses **整表**拉进内存建 Map，而不是用 inArray(actressIds) 精确查询。
        // 好处是实现简单且避免空数组导致的非法 SQL；代价是女优表变大后浪费明显。
        // ⚠️ `actressIds` 变量算出来后其实没被使用（见 observations）。
        // Get actress details
        const actressIds = embeddingsData.map((e) => e.actressId);
        const allActresses = await db.select().from(actresses);
        const actressMap = new Map(allActresses.map((a) => [a.id, a]));

        // 显式逐字段挑选返回结构，而不是 `...embedding` 展开：
        // 保证响应形状稳定，将来给表加列也不会意外泄露到前端。
        return embeddingsData.map((embedding) => ({
          id: embedding.id,
          actressId: embedding.actressId,
          actressName: actressMap.get(embedding.actressId)?.name || "Unknown",
          faceImageUrl: embedding.faceImageUrl,
          createdAt: embedding.createdAt,
        }));
      } catch (error) {
        console.error("[Actress Management] Error getting actresses:", error);
        throw error;
      }
    }),

  /**
   * 按 ID 读取女优档案（完整行）。
   *
   * @权限 protected —— 需登录。
   * @param input.actressId 女优 ID，正整数。
   * @returns actresses 表整行（含 bio、tags、faceEmbedding 等**所有列**，未做字段裁剪）。
   * @副作用 只读（1 次 SELECT）。
   * @throws "Actress not found" —— 普通 `Error`，非 `TRPCError({ code:"NOT_FOUND" })`，前端见到 500。
   * @throws "Database not available"
   *
   * 与 `actressManagementV2.getById` 功能完全重叠（后者权限、错误处理都相同），
   * 属于 V1/V2 并存造成的重复实现；新代码请用 V2。
   */
  // Get actress by ID
  getActressById: protectedProcedure
    .input(
      z.object({
        actressId: z.number().int().positive(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        const actress = await db
          .select()
          .from(actresses)
          .where(eq(actresses.id, input.actressId))
          .limit(1);

        if (actress.length === 0) {
          throw new Error("Actress not found");
        }

        return actress[0];
      } catch (error) {
        console.error("[Actress Management] Error getting actress:", error);
        throw error;
      }
    }),

  /**
   * 从人脸底库删除一条特征记录。
   *
   * @权限 admin —— 声明为 `protectedProcedure`（只保证已登录），
   *       管理员判断在 handler 内手写（V1 旧写法，**勿删那段检查**）。
   *       ⚠️ 由于管理面板走的是独立 admin-cookie 认证、`ctx.user` 为空，
   *          这个接口在管理面板中实际上是调不通的（与同文件的 upload 接口策略相反）。
   * @param input.embeddingId `actress_face_embeddings.id`（**不是** actressId），
   *        取自 `getActressesWithEmbeddings` 返回项的 `id` 字段。
   * @returns `{ success: true, message }` —— 记录不存在时同样返回 success（删除 0 行）。
   * @副作用 写库：删除 1 行 embedding。删除后该女优即从「以图搜人」的候选集中消失，
   *         但其 actresses 档案本身不受影响。
   * @throws "Only admins can delete actress face embeddings" —— 普通 `Error`，
   *         不是 `TRPCError({ code:"FORBIDDEN" })`，前端拿到的是 500 而非 403。
   * @throws "Database not available"
   */
  // Delete actress face embedding
  deleteActressFaceEmbedding: protectedProcedure
    .input(
      z.object({
        embeddingId: z.number().int().positive(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // 手写管理员校验：本 procedure 用的是 protectedProcedure（仅校验登录），
      // 角色判断必须在这里做。删掉即等于把删库权限开放给所有登录用户。
      // Check if user is admin
      if (ctx.user?.role !== "admin") {
        throw new Error("Only admins can delete actress face embeddings");
      }

      try {
        await db
          .delete(actressFaceEmbeddings)
          .where(eq(actressFaceEmbeddings.id, input.embeddingId));

        return {
          success: true,
          message: "Actress face embedding deleted successfully",
        };
      } catch (error) {
        console.error(
          "[Actress Management] Error deleting face embedding:",
          error
        );
        throw error;
      }
    }),
});
