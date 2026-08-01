/**
 * ============================================================================
 * server/routers/videos-v2.ts — 视频 CRUD 路由 **V2**（增强版，新功能入口）
 * ============================================================================
 *
 * 架构层级：**API 路由层**。在 `server/routers.ts` 中以 `videosV2` 命名空间注册，
 * 前端通过 `trpc.videosV2.*` 调用（主要使用方：`client/src/pages/VideosPageV2.tsx`、
 * `client/src/components/VideoManagementUI.tsx` 后台管理界面）。
 *
 * ## 与 V1（`./videos.ts`）的核心差异
 * 1. **权限模型现代化**：写操作直接用 `adminProcedure` 中间件（`server/_core/trpc.ts`），
 *    不再像 V1 那样在 handler 内手写 `ctx.user?.role !== "admin"`。
 * 2. **读操作收紧为 `protectedProcedure`**：V2 的列表/详情**需要登录**，
 *    而 V1 是 public。因此面向游客的页面不能直接迁到 V2（这是 V1 无法废弃的原因）。
 * 3. **真·SQL 分页**：`list` 用 `offset`/`limit` 下推到 SQL，不像 V1 把全表拉进内存；
 *    代价是**不返回总数**（前端拿不到 totalPages，只能做「加载更多」式翻页）。
 * 4. **增量更新**：`update` 用 `updateData` 对象只写入显式传入的字段，
 *    避免 V1 那种 undefined 字段被一并写进 SET 子句的隐患。
 * 5. **封面兜底**：`create` 未提供 thumbnailUrl 时调用 `generatePlaceholderThumbnail()`
 *    生成占位图路由（`/api/video-thumbnail/:id`），保证列表页不出现破图。
 *    该 URL 需要真实自增 ID，因此是在插入拿到 ID 之后再 UPDATE 补写的。
 *
 * ## 主要导出
 * - `videosV2Router` —— 6 个 procedure：
 *   - `create`        （admin）    新建视频 + 批量关联女优
 *   - `list`          （protected）分页列表，每项附带精简女优信息
 *   - `getById`       （protected）单个视频详情 + 精简女优信息
 *   - `update`        （admin）    增量更新元数据 + 可选整体替换女优关联
 *   - `delete`        （admin）    硬删除视频及其女优关联
 *   - `getCategories` （protected）去重分类名列表
 *
 * ## 上下游依赖
 * - 上游：`server/routers.ts` → Express `/api/trpc/videosV2.*`
 * - 下游：`../db` 的 `getDb()`；`../../drizzle/schema` 的 videos / video_actresses / actresses；
 *         `../_core/videoThumbnail` 的 `generatePlaceholderThumbnail()`。
 *
 * ## 关键设计决策 / 坑
 * - **`create` 用 Drizzle 的 `$returningId()` 拿新 ID**（曾经是「插入后按 title 倒序回查」，
 *   同名视频并发创建时会取到别人的行，已修复）。
 * - **`list` 的 N+1 查询**：每条视频单独查一次女优（`Promise.all` 并发，但仍是 N 次往返）。
 *   V1 用的是「批量 IN 查询 + 内存装配」，在这一点上反而更优。
 * - **散落的 `as any`**：Drizzle 的链式查询构建器在 `.where()` / `.innerJoin()` 后类型会收窄，
 *   本文件大量用 `as any` 逃逸类型检查；这些都是**类型层面的妥协，不改变运行时语义**。
 * - **无事务**：与 V1 相同，主表与关联表的多条写语句之间没有事务保护。
 */
import { protectedProcedure, router, adminProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { videos, videoActresses, actresses } from "../../drizzle/schema";
import { eq, desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { generatePlaceholderThumbnail } from "../_core/videoThumbnail";

export const videosV2Router = router({
  /**
   * 新建视频，并可同时批量关联女优。
   *
   * @权限 admin —— 由 `adminProcedure` 中间件在进入 handler 前拦截，
   *       非管理员会收到 `TRPCError({ code: "FORBIDDEN" })`。
   * @param input.title        标题，1~255 字符（与 `videos.title` 的 varchar(255) 对齐）。
   * @param input.description  简介，可选。
   * @param input.videoUrl     视频地址，必填且必须是合法 URL。
   * @param input.thumbnailUrl 封面 URL，可选；缺省时自动生成占位图（见下方注释）。
   * @param input.category     分类名，可选。
   * @param input.duration     时长（秒），正整数，可选，缺省落库为 0。
   * @param input.actressIds   女优 ID 数组，可选；一次性批量 INSERT。
   * @returns `{ success: true, message, videoId }` —— videoId 取自 `$returningId()`，
   *          即驱动返回的真实自增主键。
   * @副作用 写库：videos 插入 1 行（未传封面时再 UPDATE 1 次写占位图）
   *         + video_actresses 批量插入 N 行（**无事务**）。
   * @throws "Database not available"；其余数据库异常原样上抛（已记日志）。
   */
  // Create video
  create: adminProcedure
    .input(
      z.object({
        title: z.string().min(1).max(255),
        description: z.string().optional(),
        videoUrl: z.string().url(),
        thumbnailUrl: z.string().url().optional(),
        category: z.string().optional(),
        duration: z.number().int().positive().optional(),
        actressIds: z.array(z.number().int().positive()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // duration 缺省写 0 而非留 NULL，保证前端时长格式化不必处理 null 分支。
        // 修复：不再在这里写占位封面。占位图 URL 形如 `/api/video-thumbnail/{id}`，
        // 需要真实的自增 ID，而此刻行还没插入 —— 原代码硬传 0，导致所有自动生成封面的
        // 视频 thumbnailUrl 全都指向 `/api/video-thumbnail/0`，彼此无法区分。
        // 正确做法是插入拿到 ID 后再补写（见下方）。
        // Create video
        const inserted = await db
          .insert(videos)
          .values({
            title: input.title,
            description: input.description,
            videoUrl: input.videoUrl,
            thumbnailUrl: input.thumbnailUrl,
            category: input.category,
            duration: input.duration || 0,
          })
          .$returningId();

        // ===== 取刚插入行的自增 ID =====
        // 修复：原实现是「按 title 精确匹配 + createdAt DESC LIMIT 1」回查，
        // 同标题视频并发创建时会取到别人刚插入的那一行（createdAt 只精确到秒会放大窗口），
        // 进而把女优关联挂到错误的视频上。
        // 改用 Drizzle 的 `$returningId()`：它直接基于驱动返回的 insertId + 自增主键
        // 还原出 `[{ id: number }]`，无竞态。
        // （注意不能照抄 V1 曾经的 `(result as any).insertId`——drizzle-orm/mysql2 的
        //   INSERT 结果是数组 `[ResultSetHeader, FieldPacket[]]`，那样取恒为 undefined。）
        // Get created video id
        const videoId = inserted[0].id;

        // 封面兜底：未传 thumbnailUrl 时用真实 videoId 生成占位图路由，避免列表页破图。
        // 这是插入后的第二条语句（同样没有事务保护）：万一失败，视频仍在，只是没有封面。
        if (!input.thumbnailUrl) {
          await db
            .update(videos)
            .set({ thumbnailUrl: generatePlaceholderThumbnail(videoId, input.title) })
            .where(eq(videos.id, videoId));
        }

        // 批量 INSERT（单条 SQL 多组 VALUES），比 V1 的循环逐条插入少 N-1 次往返。
        // 外层的 length > 0 判断是必需的：Drizzle 对空 values 数组会生成非法 SQL。
        // Link actresses if provided
        if (input.actressIds && input.actressIds.length > 0) {
          await db.insert(videoActresses).values(
            input.actressIds.map((actressId) => ({
              videoId,
              actressId,
            }))
          );
        }

        return {
          success: true,
          message: "Video created successfully",
          videoId,
        };
      } catch (error) {
        console.error("[Videos V2] Error creating video:", error);
        throw error;
      }
    }),

  /**
   * 视频分页列表（SQL 层分页），每项附带**精简**女优信息。
   *
   * @权限 protected —— 需登录。这是 V2 与 V1 的关键差异，游客页面不能用本接口。
   * @param input.limit    每页条数，1~100，默认 20。
   * @param input.offset   偏移量，默认 0（游标式翻页：offset += limit）。
   * @param input.category 精确匹配分类，可选。
   * @param input.sortBy   "newest"（createdAt 降序，默认）/ "popular"（views 降序）
   *                       / "rating"（rating 降序）。
   * @returns 视频数组，每项 `{ ...video, actresses: [{ id, name, profileImageUrl }] }`。
   *          **不返回总数**，前端无法渲染精确页码，只能做"加载更多"。
   * @副作用 只读，但查询次数为 `1 + N`（N = 本页视频数，见下方 N+1 注释）。
   * @throws "Database not available"；其余数据库异常原样上抛。
   */
  // List videos with pagination
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        category: z.string().optional(),
        sortBy: z.enum(["newest", "popular", "rating"]).default("newest"),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // 查询构建器整体声明为 any：Drizzle 每次链式调用都会返回收窄后的新类型，
        // 条件式地追加 .where()/.orderBy() 无法通过类型检查。这里是纯类型逃逸，
        // 运行时行为与正常链式调用完全一致。
        // Build query with all filters and sorting
        let query: any = db.select().from(videos);

        // 只有一个筛选条件，所以可以直接 .where()；
        // 若将来要加第二个条件，必须像 V1 那样用 and(...) 合并 ——
        // Drizzle 的 .where() 是覆盖语义，连着调两次会丢掉前一个条件。
        if (input.category) {
          query = query.where(eq(videos.category, input.category));
        }

        // Apply sorting
        if (input.sortBy === "popular") {
          query = query.orderBy(desc(videos.views));
        } else if (input.sortBy === "rating") {
          query = query.orderBy(desc(videos.rating));
        } else {
          query = query.orderBy(desc(videos.createdAt));
        }

        // 分页下推到 SQL（V1 是内存 slice）。代价是拿不到筛选后的总行数。
        const videosList = await query.limit(input.limit).offset(input.offset);

        // ===== 装配女优信息：这是一个 N+1 查询 =====
        // 对本页每条视频各发一次 JOIN 查询。Promise.all 让 N 次查询并发执行，
        // 因此**墙钟延迟**接近单次查询，但**数据库负载**仍是 N 倍，
        // 且 limit 上限 100 时会瞬间占用最多 100 条连接，有打满连接池的风险。
        // 更优解是像 V1 那样：一次 `inArray(videoId, [...])` 批量取回后在内存里分组。
        //
        // 这里只 select 三个字段（id/name/profileImageUrl），刻意不返回 bio、
        // faceEmbedding 等大字段 —— 列表页用不到，且能避免泄露内部数据。
        // Get actresses for each video
        const videosWithActresses = await Promise.all(
          videosList.map(async (video: any) => {
            const videoActressesList = await db
              .select({
                id: actresses.id,
                name: actresses.name,
                profileImageUrl: actresses.profileImageUrl,
              })
              .from(videoActresses)
              // innerJoin 而非 leftJoin：指向已删除女优的孤儿关联记录会被自动过滤掉
              .innerJoin(actresses, eq(videoActresses.actressId, actresses.id))
              .where(eq(videoActresses.videoId, video.id)) as any;

            return {
              ...video,
              actresses: videoActressesList,
            };
          })
        );

        return videosWithActresses;
      } catch (error) {
        console.error("[Videos V2] Error listing videos:", error);
        throw error;
      }
    }),

  /**
   * 按 ID 获取单个视频详情 + 精简女优信息。
   *
   * @权限 protected —— 需登录（V1 的同名接口是 public）。
   * @param input.id 视频 ID，正整数。
   * @returns `{ ...video, actresses: [{ id, name, profileImageUrl }] }`
   * @副作用 只读（2 次 SELECT）。
   * @throws "Video not found" —— 普通 `Error`，非 `TRPCError({ code: "NOT_FOUND" })`，
   *         前端收到 500 而非 404。
   * @throws "Database not available"
   */
  // Get video by ID
  getById: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        const video = await db
          .select()
          .from(videos)
          .where(eq(videos.id, input.id))
          .limit(1);

        if (video.length === 0) {
          throw new Error("Video not found");
        }

        // 与 list 中相同的 JOIN，同样只取三个展示字段。
        // 外层多包一层括号 + `as any` 仅为断言整个 await 表达式的类型，无运行时含义。
        // Get actresses
        const videoActressesList = await (db
          .select({
            id: actresses.id,
            name: actresses.name,
            profileImageUrl: actresses.profileImageUrl,
          })
          .from(videoActresses)
          .innerJoin(actresses, eq(videoActresses.actressId, actresses.id))
          .where(eq(videoActresses.videoId, input.id)) as any);

        return {
          ...video[0],
          actresses: videoActressesList,
        };
      } catch (error) {
        console.error("[Videos V2] Error getting video:", error);
        throw error;
      }
    }),

  /**
   * 增量更新视频元数据，并可整体替换女优关联。
   *
   * @权限 admin（`adminProcedure` 中间件拦截）
   * @param input.id         必填，要更新的视频 ID；更新前会先校验其存在性。
   * @param input.title/description/videoUrl/thumbnailUrl/category/duration
   *                         全部可选，**只有显式传入的字段才会进入 SET 子句**
   *                         （这是 V2 相对 V1 的重要修正，见下方 updateData 注释）。
   * @param input.actressIds 传入时「先删后插」整体替换关联；传空数组表示清空；
   *                         不传（undefined）则完全不动关联表。
   * @returns `{ success: true, message, videoId }`
   * @副作用 写库：videos UPDATE + video_actresses DELETE/INSERT（**无事务**）。
   * @throws "Video not found" / "Database not available"
   *
   * ⚠️ 注意 tags 字段在 V2 的 update 里**没有暴露**（V1 有），
   *    因此想改标签只能走 V1 的 `videos.update`。
   */
  // Update video
  update: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        title: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        videoUrl: z.string().url().optional(),
        thumbnailUrl: z.string().url().optional(),
        category: z.string().optional(),
        duration: z.number().int().positive().optional(),
        actressIds: z.array(z.number().int().positive()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // Check if video exists
        const video = await db
          .select()
          .from(videos)
          .where(eq(videos.id, input.id))
          .limit(1);

        if (video.length === 0) {
          throw new Error("Video not found");
        }

        // ===== 增量构建 SET 子句 =====
        // 逐字段用 `!== undefined` 判断后才写入 updateData，效果是
        // 「未传的字段保持原值，传了空字符串则确实清空」。
        // 必须用 `!== undefined` 而不是 truthy 判断，否则 `duration: 0`、
        // `description: ""` 这类合法的"清零/清空"操作会被吞掉。
        // （对比 V1：V1 把 `input.xxx` 原样塞进 .set()，靠 Drizzle 的 mapUpdateSet
        //  自动剔除 undefined，最终效果相同，只是意图不如这里显式。）
        // Build update object
        const updateData: any = {};
        if (input.title !== undefined) updateData.title = input.title;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.videoUrl !== undefined) updateData.videoUrl = input.videoUrl;
        if (input.thumbnailUrl !== undefined) updateData.thumbnailUrl = input.thumbnailUrl;
        if (input.category !== undefined) updateData.category = input.category;
        if (input.duration !== undefined) updateData.duration = input.duration;

        // 修复：补上空对象守卫。所有元数据字段都不传（只想改女优关联）时 updateData 为 {}，
        // Drizzle 的 mapUpdateSet 剔除 undefined 后 entries 为空会抛
        // `Error("No values to set")`，导致下面的女优关联更新根本执行不到。
        if (Object.keys(updateData).length > 0) {
          await db
            .update(videos)
            .set(updateData)
            .where(eq(videos.id, input.id));
        }

        // ===== 女优关联「全量替换」=====
        // 用 `!== undefined` 精确区分三种意图（V1 用的是 truthy 判断，语义较模糊）：
        //   - 不传    → 完全不碰关联表
        //   - 传 []   → 清空该视频的全部女优关联
        //   - 传 [..] → 先删光再重建
        // 关联表除 (videoId, actressId) 外无业务字段，重建无信息损失，
        // 因此不做差集增量。代价同样是无事务：DELETE 成功而 INSERT 失败会丢关联。
        // Update actresses if provided
        if (input.actressIds !== undefined) {
          // Delete existing relationships
          await (db
            .delete(videoActresses)
            .where(eq(videoActresses.videoId, input.id)) as any);

          // 空数组守卫：Drizzle 对空 values 数组会生成非法 SQL，
          // 这也正是"传 [] 即清空"语义得以成立的地方（只删不插）。
          // Insert new relationships
          if (input.actressIds.length > 0) {
            await (db.insert(videoActresses).values(
              input.actressIds.map((actressId) => ({
                videoId: input.id,
                actressId,
              }))
            ) as any);
          }
        }

        return {
          success: true,
          message: "Video updated successfully",
          videoId: input.id,
        };
      } catch (error) {
        console.error("[Videos V2] Error updating video:", error);
        throw error;
      }
    }),

  /**
   * 删除视频（**硬删除**，不可恢复）。
   *
   * @权限 admin（`adminProcedure` 中间件拦截）
   * @param input.id 视频 ID。
   * @returns `{ success: true, message, videoId }`
   * @副作用 写库：先删 video_actresses 关联，再删 videos 主表（**无事务**）。
   *         ⚠️ 与 V1 相同，不清理 favorites / resume_playback / recommendations 中的引用，
   *         也不回收 S3 上的视频文件与封面。
   * @throws "Video not found" —— V2 相对 V1 的改进：删除前先校验存在性，
   *         删不存在的视频会明确报错而不是静默成功。
   * @throws "Database not available"
   */
  // Delete video (hard delete)
  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // Check if video exists
        const video = await db
          .select()
          .from(videos)
          .where(eq(videos.id, input.id))
          .limit(1);

        if (video.length === 0) {
          throw new Error("Video not found");
        }

        // 删除顺序固定：先子表（关联）后主表。
        // 反过来若中途失败，会留下指向已删除视频的孤儿关联记录。
        // Delete video_actresses entries
        await (db
          .delete(videoActresses)
          .where(eq(videoActresses.videoId, input.id)) as any);

        // Delete video
        await (db
          .delete(videos)
          .where(eq(videos.id, input.id)) as any);

        return {
          success: true,
          message: "Video deleted successfully",
          videoId: input.id,
        };
      } catch (error) {
        console.error("[Videos V2] Error deleting video:", error);
        throw error;
      }
    }),

  /**
   * 获取全站已使用的分类名列表（供 V2 列表页/管理界面的分类筛选使用）。
   *
   * @权限 protected —— 需登录（V1 同名接口是 public）。
   * @returns 去重且过滤空值后的分类名数组，**未排序**。
   * @副作用 只读（1 次全表扫描）。
   * @throws "Database not available"
   *
   * 实现与 V1 完全一致：全量取 category 列后在 JS 里 Set 去重，
   * 而非 `SELECT DISTINCT`。表大时可直接改用 DISTINCT，语义等价。
   */
  // Get categories
  getCategories: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const allVideos = await db.select({ category: videos.category }).from(videos);
      // filter(Boolean) 同时滤掉 null 与空字符串；`as string[]` 补上 TS 推断不出的非空收窄。
      const categories = Array.from(
        new Set(allVideos.map((v) => v.category).filter(Boolean))
      ) as string[];
      return categories;
    } catch (error) {
      console.error("[Videos V2] Error getting categories:", error);
      throw error;
    }
  }),
});
