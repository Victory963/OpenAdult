/**
 * ============================================================================
 * server/routers/actress-management-v2.ts — 女优档案 CRUD 路由 **V2**
 * ============================================================================
 *
 * 架构层级：**API 路由层**。在 `server/routers.ts` 中以 `actressManagementV2` 注册，
 * 前端通过 `trpc.actressManagementV2.*` 调用
 * （主要使用方：`client/src/components/ActressManagementUI.tsx`、
 *   `client/src/pages/ActressManagementPage.tsx` 管理面板）。
 *
 * ## 与 V1（`./actressManagement.ts`）的关系
 * 二者**职责完全不同**，不是简单的新旧版本替代：
 * - V1 只管 `actress_face_embeddings`（人脸检索底库的建立与删除）；
 * - V2（本文件）才是 `actresses` 女优档案表的增删改查。
 * 唯一重叠的是 `getById`（V1 叫 `getActressById`），实现基本一致。
 * 本文件**不涉及 embedding 的写入**，只在删除女优时顺带清理其 embedding。
 *
 * ## 主要导出
 * - `actressManagementV2Router` —— 6 个 procedure：
 *   - `create`       （admin）    新建女优档案
 *   - `list`         （protected）分页列出女优
 *   - `getById`      （protected）按 ID 读单个女优
 *   - `update`       （admin）    增量更新女优字段
 *   - `delete`       （admin）    硬删除女优 + 级联清理关联与 embedding
 *   - `searchByName` （protected）按名称模糊搜索（罗马字/日文/中文三名齐搜）
 *
 * ## 上下游依赖
 * - 上游：`server/routers.ts` → Express `/api/trpc/actressManagementV2.*`
 * - 下游：`../db` 的 `getDb()`；schema 中的 `actresses`、`video_actresses`、
 *         `actress_face_embeddings` 三张表。
 *
 * ## 关键设计决策 / 坑
 * 1. **权限模型**：写操作用 `adminProcedure` 中间件统一拦截（对比 V1 的 handler 内手写检查）。
 *    但读操作是 `protectedProcedure`，而管理面板走的是独立 admin-cookie 认证、
 *    OAuth 的 `ctx.user` 为空 —— 因此这套接口在管理面板中能否调通取决于登录方式，
 *    这是 V1/V2 与 admin-auth 三套认证并存造成的长期混乱点。
 * 2. **`create` 用「插入后按 name 回查」拿新 ID**，与 `videos-v2.ts` 同款竞态问题
 *    （同名女优并发创建会取错行）。
 * 3. **`searchByName` 在内存里过滤全表**，与 `server/routers.ts` 的 `actresses.search`
 *    实现思路一致：三个名字字段（后两者可空）用 SQL LIKE 拼 OR 既无索引又难维护。
 *    规模上限明确，女优表变大后须改全文索引。
 * 4. **`delete` 是硬删除**，且手工级联三张表；没有事务保护，中途失败会留下不一致数据。
 */
import { protectedProcedure, router, adminProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { actresses, videoActresses, actressFaceEmbeddings } from "../../drizzle/schema";
import { eq, inArray, desc as descOrder, sql } from "drizzle-orm";
import { z } from "zod";

export const actressManagementV2Router = router({
  /**
   * 新建女优档案。
   *
   * @权限 admin —— 由 `adminProcedure` 中间件在进入 handler 前拦截。
   * @param input.name            主名（通常是罗马字/英文名），1~255 字符，必填。
   * @param input.japaneseName    日文名，可选。
   * @param input.chineseName     中文名，可选。
   *        —— 三个名字字段都会被 `searchByName` 和前端搜索框一并匹配。
   * @param input.bio             简介，可选。
   * @param input.profileImageUrl 头像 URL，可选，必须是合法 URL。
   * @param input.birthDate       生日，`Date` 对象（依赖 superjson 序列化器跨端传输）。
   * @param input.tags            标签数组，可选，缺省写入空数组 `[]` 而非 NULL，
   *                              保证前端可以直接 `.map()` 而不必判空。
   * @returns `{ success: true, message, actressId }`
   *          —— `actressId` 可能为 `undefined`（回查落空时，见下方注释）。
   * @副作用 写库：actresses 插入 1 行。不建立人脸 embedding（那是 V1 路由的职责）。
   * @throws "Database not available"；其余数据库异常原样上抛（已记日志）。
   */
  // Create new actress
  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        japaneseName: z.string().max(255).optional(),
        chineseName: z.string().max(255).optional(),
        bio: z.string().optional(),
        profileImageUrl: z.string().url().optional(),
        birthDate: z.date().optional(),
        tags: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        await db.insert(actresses).values({
          name: input.name,
          japaneseName: input.japaneseName,
          chineseName: input.chineseName,
          bio: input.bio,
          profileImageUrl: input.profileImageUrl,
          birthDate: input.birthDate,
          tags: input.tags || [],
        });

        // ===== 回查刚插入的行以获取自增 ID =====
        // 按 name 精确匹配 + createdAt 降序取第一条。
        // 之所以这么绕，是因为 Drizzle 的 MySQL insert 返回类型未暴露 insertId
        // （V1 的 videos 路由用 `(result as any).insertId` 硬取，其实更准确）。
        // ⚠️ 已知竞态：同名女优并发创建时可能取到别人刚插入的那一行；
        //    createdAt 只精确到秒会加剧这一点。
        // `descOrder` 是 drizzle 的 `desc` 重命名导入，避免与其他标识符冲突。
        // Get the created actress
        const created = await db
          .select()
          .from(actresses)
          .where(eq(actresses.name, input.name))
          .orderBy(descOrder(actresses.createdAt))
          .limit(1);

        // 用可选链取 id：回查落空时返回 undefined 而不抛错 ——
        // 插入本身已经成功，为一次辅助查询失败而报错会误导调用方。
        // 但前端若依赖 actressId 做后续跳转，需要自行处理 undefined。
        return {
          success: true,
          message: "Actress created successfully",
          actressId: created[0]?.id,
        };
      } catch (error) {
        console.error("[Actress Management V2] Error creating actress:", error);
        throw error;
      }
    }),

  /**
   * 分页列出女优档案。
   *
   * @权限 protected —— 需登录。
   * @param input.limit  每页条数，1~100，默认 50。
   * @param input.offset 偏移量，默认 0（游标式翻页：offset += limit）。
   * @returns actresses 表整行数组（**未裁剪字段**，含 bio、faceEmbedding 等所有列）。
   *          不返回总数，前端只能做"加载更多"式翻页。
   * @副作用 只读（1 次 SELECT，分页已下推到 SQL）。
   * @throws "Database not available"
   *
   * 注意：**没有 ORDER BY**，返回顺序完全由 MySQL 的扫描计划决定。
   * 这意味着翻页结果可能不稳定（同一条记录重复出现或被跳过），
   * 修复方式是加一个确定性排序键（如 `.orderBy(desc(actresses.createdAt))`）。
   */
  // Get all actresses
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        const actressesList = await db
          .select()
          .from(actresses)
          .limit(input.limit)
          .offset(input.offset);

        return actressesList;
      } catch (error) {
        console.error("[Actress Management V2] Error listing actresses:", error);
        throw error;
      }
    }),

  /**
   * 按 ID 读取单个女优档案。
   *
   * @权限 protected —— 需登录。
   * @param input.id 女优 ID，正整数。
   * @returns actresses 表整行（未裁剪字段）。
   * @副作用 只读（1 次 SELECT）。
   * @throws "Actress not found" —— 普通 `Error` 而非 `TRPCError({ code:"NOT_FOUND" })`，
   *         前端收到 500 而非 404，判断"不存在"只能比对错误文案。
   * @throws "Database not available"
   *
   * 与 V1 的 `actressManagement.getActressById` 完全等价，属重复实现；新代码用本接口。
   * 面向游客的只读查询请用 `server/routers.ts` 中的 `actresses.getProfile`（public）。
   */
  // Get actress by ID
  getById: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        const actress = await db
          .select()
          .from(actresses)
          .where(eq(actresses.id, input.id))
          .limit(1);

        if (actress.length === 0) {
          throw new Error("Actress not found");
        }

        return actress[0];
      } catch (error) {
        console.error("[Actress Management V2] Error getting actress:", error);
        throw error;
      }
    }),

  /**
   * 增量更新女优档案。
   *
   * @权限 admin（`adminProcedure` 中间件拦截）
   * @param input.id 必填，目标女优 ID；更新前先校验其存在性。
   * @param input.name/japaneseName/chineseName/bio/profileImageUrl/birthDate/tags
   *        全部可选，**只有显式传入的字段才会进入 SET 子句**（见下方 updateData 注释）。
   * @returns `{ success: true, message, actressId }` —— 不返回更新后的行，
   *          前端需自行 invalidate 相关查询缓存。
   * @副作用 写库：actresses UPDATE 1 行。
   *         不会同步更新该女优的人脸 embedding（换了头像也不会重建底库特征）。
   * @throws "Actress not found" / "Database not available"
   */
  // Update actress
  update: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        japaneseName: z.string().max(255).optional(),
        chineseName: z.string().max(255).optional(),
        bio: z.string().optional(),
        profileImageUrl: z.string().url().optional(),
        birthDate: z.date().optional(),
        tags: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // Check if actress exists
        const actress = await db
          .select()
          .from(actresses)
          .where(eq(actresses.id, input.id))
          .limit(1);

        if (actress.length === 0) {
          throw new Error("Actress not found");
        }

        // ===== 增量构建 SET 子句 =====
        // 逐字段用 `!== undefined` 判断后才写入，语义是
        // 「未传的字段保持原值，传了空值则确实清空」。
        // 必须用 `!== undefined` 而非 truthy 判断，否则 `bio: ""`、`tags: []`
        // 这类合法的"清空"操作会被静默吞掉。
        // ⚠️ 缺一个空对象守卫：只传 `id` 而不传任何字段时 updateData 为 {}，
        //    Drizzle 的 mapUpdateSet 会抛 `Error("No values to set")`，
        //    最终表现为一个语义不明的 500 —— 见 observations。
        // Build update object
        const updateData: any = {};
        if (input.name !== undefined) updateData.name = input.name;
        if (input.japaneseName !== undefined) updateData.japaneseName = input.japaneseName;
        if (input.chineseName !== undefined) updateData.chineseName = input.chineseName;
        if (input.bio !== undefined) updateData.bio = input.bio;
        if (input.profileImageUrl !== undefined) updateData.profileImageUrl = input.profileImageUrl;
        if (input.birthDate !== undefined) updateData.birthDate = input.birthDate;
        if (input.tags !== undefined) updateData.tags = input.tags;

        await db
          .update(actresses)
          .set(updateData)
          .where(eq(actresses.id, input.id));

        return {
          success: true,
          message: "Actress updated successfully",
          actressId: input.id,
        };
      } catch (error) {
        console.error("[Actress Management V2] Error updating actress:", error);
        throw error;
      }
    }),

  /**
   * 删除女优（**硬删除**，不可恢复），并手工级联清理其关联数据。
   *
   * @权限 admin（`adminProcedure` 中间件拦截）
   * @param input.id 女优 ID。
   * @returns `{ success: true, message, actressId }`
   * @副作用 写库，按固定顺序删三张表（**无事务**）：
   *         1. `video_actresses` —— 该女优与所有视频的关联；
   *         2. `actress_face_embeddings` —— 人脸底库特征（失败被吞，见下方注释）；
   *         3. `actresses` —— 档案主行。
   *         ⚠️ 不清理 `user_preferences.preferredActresses` 与 `face_search_history`
   *            中对该 ID 的引用，也不删除 S3 上的头像文件。
   * @throws "Actress not found" —— 删除前显式校验存在性。
   * @throws "Database not available"
   */
  // Delete actress (hard delete)
  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // Check if actress exists
        const actress = await db
          .select()
          .from(actresses)
          .where(eq(actresses.id, input.id))
          .limit(1);

        if (actress.length === 0) {
          throw new Error("Actress not found");
        }

        // 手工级联，顺序固定：先清子表引用，最后删主行。
        // 数据库层没有外键约束（Drizzle schema 里 video_actresses 只是普通 int 列），
        // 所以清理责任全在应用层；漏删就会产生孤儿关联，进而污染
        // videos 路由的女优筛选与 JOIN 结果。
        // Delete related video_actresses entries
        await db
          .delete(videoActresses)
          .where(eq(videoActresses.actressId, input.id));

        // embedding 表的删除单独包 try/catch 并**吞掉异常**：
        // actress_face_embeddings 是后加的表（迁移 0002+），
        // 旧环境/未跑完迁移的数据库上可能根本不存在，
        // 不应因此阻断女优本身的删除。
        // ⚠️ 副作用是所有异常（包括真正的连接错误、权限错误）都被静默忽略，
        //    可能留下指向已删除女优的孤儿 embedding，让"以图搜人"匹配到幽灵结果。
        // Delete related face embeddings
        try {
          await db
            .delete(actressFaceEmbeddings)
            .where(eq(actressFaceEmbeddings.actressId, input.id));
        } catch (e) {
          // Ignore if table doesn't exist
        }

        // Delete actress
        await db
          .delete(actresses)
          .where(eq(actresses.id, input.id));

        return {
          success: true,
          message: "Actress deleted successfully",
          actressId: input.id,
        };
      } catch (error) {
        console.error("[Actress Management V2] Error deleting actress:", error);
        throw error;
      }
    }),

  /**
   * 按名称模糊搜索女优（管理面板的搜索框）。
   *
   * @权限 protected —— 需登录。面向游客的同类搜索在
   *       `server/routers.ts` 的 `actresses.search`（public，且带作品数统计与排序）。
   * @param input.query 搜索词，至少 1 字符；同时匹配主名 / 日文名 / 中文名，大小写不敏感。
   * @returns 命中的 actresses 整行数组，**未排序、无分页、无条数上限**。
   * @副作用 只读（1 次全表扫描）。
   * @throws "Database not available"
   *
   * ## 实现说明
   * 全表拉进内存用 JS 过滤，而不是 SQL LIKE。原因与 `actresses.search` 一致：
   * 三个名字字段（后两者可空）拼 OR + LIKE 在 MySQL 上没有可用索引，且难以维护；
   * 女优表体量小（数千行内）时内存过滤更简单可靠。
   * ⚠️ 这是明确的规模上限，表变大后必须改为全文索引/搜索引擎。
   */
  // Search actresses by name
  searchByName: protectedProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // `searchQuery` 是为 SQL LIKE 准备的通配符模式，但下面改用了 JS 过滤，
        // 这个变量已成为死代码（见 observations）。
        const searchQuery = `%${input.query}%`;
        // 内存过滤：统一转小写做大小写不敏感匹配（罗马字名场景需要，日文/中文不受影响）。
        // japaneseName / chineseName 可为 NULL，故用可选链 `?.` 短路，
        // 结果为 undefined 时在 `||` 链中等价于 false。
        // Manual filtering in JS
        const allActresses = await db.select().from(actresses);
        const filtered = allActresses.filter(
          (a) =>
            a.name.toLowerCase().includes(input.query.toLowerCase()) ||
            a.japaneseName?.toLowerCase().includes(input.query.toLowerCase()) ||
            a.chineseName?.toLowerCase().includes(input.query.toLowerCase())
        );

        return filtered;
      } catch (error) {
        console.error("[Actress Management V2] Error searching actresses:", error);
        throw error;
      }
    }),
});
