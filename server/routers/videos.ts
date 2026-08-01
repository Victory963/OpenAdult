/**
 * ============================================================================
 * server/routers/videos.ts — 视频 CRUD 路由 **V1**（向后兼容版本）
 * ============================================================================
 *
 * 架构层级：**API 路由层**。在 `server/routers.ts` 中以 `videos` 命名空间注册，
 * 前端通过 `trpc.videos.*` 调用（主要使用方：`client/src/pages/VideosPage.tsx`、
 * `VideoDetailPage.tsx`、`SearchResultsPage.tsx`）。
 *
 * ## 与 V2（`./videos-v2.ts`）的分工
 * | 维度 | V1（本文件） | V2 |
 * |------|-------------|-----|
 * | 读取权限 | `publicProcedure`（游客可浏览） | `protectedProcedure`（需登录） |
 * | 写入权限 | `protectedProcedure` + **手写 role 检查** | `adminProcedure`（中间件统一拦截） |
 * | 分页参数 | `page` / `limit`（页号制，返回 pagination 元信息） | `offset` / `limit`（游标制，直接返回数组） |
 * | 额外能力 | 支持 `actressName`、`minRating` 筛选，返回总数 | 支持缩略图占位、`videoUrl` 更新 |
 *
 * 项目约定：**V1 仅作向后兼容保留，新功能一律加到 V2**。
 * 但注意游客可见的列表页目前仍依赖 V1 的 `publicProcedure`，因此不能直接废弃。
 *
 * ## 主要导出
 * - `videosRouter` —— 包含 7 个 procedure：
 *   - `list`          （public）  分页 + 筛选 + 排序的视频列表，附带每部片的女优信息
 *   - `getById`       （public）  单个视频详情 + 关联女优
 *   - `getCategories` （public）  去重后的分类名列表（给筛选下拉框用）
 *   - `create`        （admin）   新建视频并关联女优
 *   - `update`        （admin）   更新视频元数据，可整体替换女优关联
 *   - `delete`        （admin）   硬删除视频及其女优关联
 *   - `getActresses`  （public）  全量女优列表，供后台表单下拉选择
 *
 * ## 上下游依赖
 * - 上游：`server/routers.ts`（注册）→ Express `/api/trpc/videos.*`
 * - 下游：`../db` 的 `getDb()`（Drizzle 实例）、`../../drizzle/schema` 的
 *   `videos` / `video_actresses` / `actresses` 三张表。
 *
 * ## 关键设计决策 / 坑
 * 1. **权限双轨制**：写操作声明为 `protectedProcedure`，再在 handler 内手动判断
 *    `ctx.user?.role !== "admin"`。等价于 `adminProcedure`，属于 V2 出现前的旧写法；
 *    改动时务必保留这段检查，否则任意登录用户都能改库。
 * 2. **内存分页**：`list` 把符合条件的行**全部**拉进 Node 再 `slice()` 分页（详见该
 *    procedure 内的注释）。这是为了拿到准确的 `total` 与支持女优名筛选而做的妥协，
 *    随着 videos 表增长会成为内存与延迟瓶颈。
 * 3. **无事务**：create/update/delete 中「主表写入」与「关联表写入」是分开的多条语句，
 *    中途失败会留下不一致数据（如视频已建但女优未关联）。
 * 4. **`db` 可能为 null**：`getDb()` 在未配置 DATABASE_URL 时返回 null，
 *    本文件统一抛普通 `Error("Database not available")`（不是 TRPCError，前端会看到 500）。
 */
import { z } from "zod";
import { publicProcedure, router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { videos, videoActresses, actresses } from "../../drizzle/schema";
import { eq, desc, and, gte, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

export const videosRouter = router({
  /**
   * 视频列表：分页 + 筛选（分类 / 女优名 / 最低评分）+ 排序。
   *
   * @权限 public —— 游客可浏览，是首页与列表页的主数据源。
   * @param input.page        页号，从 1 开始，默认 1。
   * @param input.limit       每页条数，1~100，默认 12（对应前端 3×4 网格布局）。
   * @param input.sortBy      "newest"（按 createdAt 降序，默认）/ "popular"（按 views 降序）
   *                          / "rating"（按 rating 降序）。
   * @param input.category    精确匹配 `videos.category`。
   * @param input.actressName 女优名模糊匹配，同时匹配罗马字名/日文名/中文名（大小写不敏感）。
   * @param input.minRating   评分下限 0~5，做 `>=` 过滤。
   * @returns `{ videos, pagination }`
   *          - `videos`：当前页视频，每项额外挂载 `actresses` 数组（可能为空数组）；
   *          - `pagination`：`{ page, limit, total, totalPages }`，`total` 是**筛选后**的总数。
   * @副作用 只读（3~4 次 SELECT，无写库/无 S3/无 LLM）。
   * @throws "Database not available" —— `getDb()` 返回 null；其余数据库异常原样上抛（已记日志）。
   */
  // Get videos list with filtering and sorting
  list: publicProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(12),
        sortBy: z
          .enum(["newest", "popular", "rating"])
          .default("newest"),
        category: z.string().optional(),
        actressName: z.string().optional(),
        minRating: z.number().min(0).max(5).optional(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // 页号 → 偏移量。注意这个 offset 最终是用在 JS 数组 slice 上，而不是 SQL LIMIT/OFFSET
        // （原因见下方「内存分页」注释）。
        const offset = (input.page - 1) * input.limit;
        let query = db.select().from(videos);

        // ===== 动态 WHERE 拼装 =====
        // 先把各筛选条件收进数组，最后统一用 and(...) 合并再调一次 .where()。
        // 这样写而不是链式多次 .where()，是因为 Drizzle 的 .where() 会**覆盖**而非累加条件，
        // 链式调用会导致前面的筛选被静默丢弃。
        // Apply filters
        const filters: any[] = [];

        if (input.category) {
          filters.push(eq(videos.category, input.category));
        }

        // rating 列是 decimal(3,2)，Drizzle 以字符串形式表示，故这里要 toString()。
        // 比较仍由 MySQL 按数值语义执行，不是字典序。
        if (input.minRating) {
          filters.push(gte(videos.rating, input.minRating.toString()));
        }

        if (filters.length > 0) {
          query = query.where(and(...filters)) as any;
        }

        // ===== 排序 =====
        // 三种排序都在 SQL 层完成（相比在 JS 里排序能吃到索引）。
        // `as any` 是为了绕开 Drizzle 查询构建器在链式调用后收窄的类型（.where() 之后
        // 返回的类型与初始 select 不同），属于类型逃逸而非逻辑需要。
        // Apply sorting
        let sortedQuery = query;
        switch (input.sortBy) {
          case "popular":
            sortedQuery = query.orderBy(desc(videos.views)) as any;
            break;
          case "rating":
            sortedQuery = query.orderBy(desc(videos.rating)) as any;
            break;
          case "newest":
          default:
            sortedQuery = query.orderBy(desc(videos.createdAt)) as any;
            break;
        }

        // ===== 女优名筛选：两跳查询（女优名 → 女优 ID → 视频 ID）=====
        // 之所以不写成一条 JOIN，是因为要同时对三个名字字段（罗马字/日文/中文，后两者可空）
        // 做大小写不敏感的模糊匹配，SQL 侧拼 OR + LIKE 既无索引可用又难以维护；
        // 而 actresses 表体量小（数千行内），整表拉到内存过滤更简单。
        // ⚠️ 规模上限明确：女优表变大后必须改为全文索引/搜索引擎。
        //
        // `actressFilterVideoIds` 为 null 表示"未启用该筛选"，与"筛选后为空"是不同语义，
        // 所以下面用 null 判断而不是 length 判断。
        // If actressName filter is provided, find matching video IDs first
        let actressFilterVideoIds: number[] | null = null;
        if (input.actressName) {
          const searchName = input.actressName.toLowerCase();
          // Find matching actresses
          const allActresses = await db.select().from(actresses);
          const matchedActressIds = allActresses
            .filter((a) =>
              a.name.toLowerCase().includes(searchName) ||
              (a.japaneseName && a.japaneseName.toLowerCase().includes(searchName)) ||
              (a.chineseName && a.chineseName.toLowerCase().includes(searchName))
            )
            .map((a) => a.id);

          // 提前短路：没有女优命中就不可能有视频命中，直接返回空页，
          // 同时也避免把空数组传给 inArray()（Drizzle 会生成非法 SQL）。
          if (matchedActressIds.length === 0) {
            return {
              videos: [],
              pagination: { page: input.page, limit: input.limit, total: 0, totalPages: 0 },
            };
          }

          // Find video IDs linked to matched actresses
          const vaRecords = await db
            .select()
            .from(videoActresses)
            .where(inArray(videoActresses.actressId, matchedActressIds));
          actressFilterVideoIds = vaRecords.map((va) => va.videoId);

          if (actressFilterVideoIds.length === 0) {
            return {
              videos: [],
              pagination: { page: input.page, limit: input.limit, total: 0, totalPages: 0 },
            };
          }
        }

        // ===== 内存分页（性能热点，改动前请读完这段）=====
        // 这里执行的 SQL **没有 LIMIT**：符合 category/minRating 条件的行会被全量拉进 Node，
        // 再在 JS 里做女优筛选和 slice 分页。这么做的两个原因：
        //   1. 需要返回准确的 `total` / `totalPages`，而女优筛选发生在 JS 侧，
        //      SQL 的 COUNT(*) 算不出筛选后的真实总数；
        //   2. 女优 ID 集合可能很大，塞进 SQL 的 IN(...) 有长度与计划稳定性问题。
        // 代价：内存占用与响应延迟随 videos 表线性增长。
        // 正解是把女优筛选下推成 JOIN + SQL 层 LIMIT/OFFSET + COUNT(*)，V2 亦未解决此问题。
        // Get all videos (with actress filter applied)
        let allVideos = await sortedQuery;
        if (actressFilterVideoIds) {
          // 转 Set 是为了把逐条 includes() 的 O(n·m) 降到 O(n)
          const filterSet = new Set(actressFilterVideoIds);
          allVideos = allVideos.filter((v: any) => filterSet.has(v.id));
        }
        const total = allVideos.length;

        // Apply pagination
        const videosData = allVideos.slice(offset, offset + input.limit);

        // ===== 为当前页视频批量装配女优信息（避免 N+1 查询）=====
        // 只对**分页后的 12 条**做关联查询，而不是对全部结果做，
        // 因此这两次额外查询的开销是常量级的。
        // Get actress information for paginated videos
        const videoIds = videosData.map((v: any) => v.id);
        let videoActressesData: any[] = [];
        let actressesData: any[] = [];

        if (videoIds.length > 0) {
          videoActressesData = await db
            .select()
            .from(videoActresses)
            .where(inArray(videoActresses.videoId, videoIds));

          const actressIds = Array.from(new Set(videoActressesData.map((va: any) => va.actressId)));
          if (actressIds.length > 0) {
            actressesData = await db
              .select()
              .from(actresses)
              .where(inArray(actresses.id, actressIds));
          }
        }

        // ===== 两级 Map 装配 =====
        // actressMap：actressId → 女优行，用于 O(1) 反查；
        // videoActressMap：videoId → 女优行数组，即最终要挂到每个 video 上的结构。
        // 中间关系表可能存在指向已删除女优的孤儿记录（V1 的 delete 不清理反向关联），
        // 因此下面用 `if (actress)` 跳过查不到的项，而不是直接 push 出 undefined。
        // Build actress map
        const actressMap = new Map(actressesData.map((a: any) => [a.id, a]));
        const videoActressMap = new Map<number, any[]>();
        videoActressesData.forEach((va: any) => {
          if (!videoActressMap.has(va.videoId)) {
            videoActressMap.set(va.videoId, []);
          }
          const actress = actressMap.get(va.actressId);
          if (actress) {
            videoActressMap.get(va.videoId)!.push(actress);
          }
        });

        return {
          videos: videosData.map((video: any) => ({
            ...video,
            actresses: videoActressMap.get(video.id) || [],
          })),
          pagination: {
            page: input.page,
            limit: input.limit,
            total,
            totalPages: Math.ceil(total / input.limit),
          },
        };
      } catch (error) {
        console.error("[Videos Router] Error getting videos:", error);
        throw error;
      }
    }),

  /**
   * 按 ID 获取单个视频详情（视频详情页的主查询）。
   *
   * @权限 public
   * @param input.videoId 视频 ID，正整数。
   * @returns 视频行展开后额外挂 `actresses` 数组（无关联时为空数组）。
   * @副作用 只读（2~3 次 SELECT）。
   * @throws "Video not found" —— 抛的是普通 `Error` 而非 `TRPCError({ code: "NOT_FOUND" })`，
   *         前端收到的是 500 而不是 404，判断"视频不存在"只能靠比对错误文案。
   * @throws "Database not available"
   */
  // Get single video by ID
  getById: publicProcedure
    .input(
      z.object({
        videoId: z.number().int().positive(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        const videoData = await db
          .select()
          .from(videos)
          .where(eq(videos.id, input.videoId))
          .limit(1);

        if (videoData.length === 0) {
          throw new Error("Video not found");
        }

        // Get actresses for this video
        const videoActressesData = await db
          .select()
          .from(videoActresses)
          .where(eq(videoActresses.videoId, input.videoId));

        const actressIds = videoActressesData.map((va) => va.actressId);
        let actressesData: any[] = [];

        // 空数组守卫：Drizzle 的 inArray() 传空数组会生成 `IN ()` 这种非法 SQL，
        // 必须显式跳过这次查询。
        if (actressIds.length > 0) {
          actressesData = await db
            .select()
            .from(actresses)
            .where(inArray(actresses.id, actressIds));
        }

        return {
          ...videoData[0],
          actresses: actressesData,
        };
      } catch (error) {
        console.error("[Videos Router] Error getting video:", error);
        throw error;
      }
    }),

  /**
   * 获取全站已使用的分类名列表（供列表页筛选下拉框使用）。
   *
   * @权限 public
   * @returns 去重且过滤掉空值后的分类名字符串数组，**未排序**（顺序取决于表扫描顺序）。
   * @副作用 只读（1 次全表扫描）。
   * @throws "Database not available"
   *
   * 实现说明：用 `SELECT category FROM videos` 全量取出后在 JS 里 Set 去重，
   * 而不是 `SELECT DISTINCT category`。前者在表大时会白白传输大量重复行，
   * 是可直接优化的点（改 DISTINCT 即可，语义完全等价）。
   */
  // Get categories
  getCategories: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const allVideos = await db.select({ category: videos.category }).from(videos);
      // filter(Boolean) 同时滤掉 null 与空字符串；末尾 `as string[]` 是因为
      // TS 无法从 filter(Boolean) 推断出非空类型收窄。
      const categories = Array.from(
        new Set(allVideos.map((v) => v.category).filter(Boolean))
      ) as string[];
      return categories;
    } catch (error) {
      console.error("[Videos Router] Error getting categories:", error);
      throw error;
    }
  }),

  /**
   * 新建视频，并可同时关联女优。
   *
   * @权限 admin —— 声明为 `protectedProcedure`（只保证已登录），管理员校验在 handler 内手写。
   *       这是 `adminProcedure` 出现之前的旧写法，**不要删除那段 role 判断**。
   * @param input.title        标题，必填，非空。
   * @param input.description  简介，可选。
   * @param input.videoUrl     视频地址，必须是合法 URL（通常是 S3/CDN 上的 m3u8 或 mp4）。
   * @param input.thumbnailUrl 封面图 URL，可选（V1 不自动生成占位图，V2 会）。
   * @param input.category     分类名，可选。
   * @param input.duration     时长（秒），正整数，可选。
   * @param input.tags         标签数组，可选，落库为 JSON 列。
   * @param input.actressIds   要关联的女优 ID 数组，可选。
   * @returns `{ success: true, videoId, message }`
   * @副作用 写库：videos 插入 1 行 + video_actresses 插入 N 行（**无事务**，
   *         关联写入失败会留下一条没有女优的孤立视频）。
   * @throws TRPCError FORBIDDEN —— 非管理员。
   * @throws TRPCError INTERNAL_SERVER_ERROR —— 任何数据库异常（原始错误只进日志，不外泄）。
   * @throws "Database not available"
   */
  // Create video (admin only)
  create: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        videoUrl: z.string().url(),
        thumbnailUrl: z.string().url().optional(),
        category: z.string().optional(),
        duration: z.number().int().positive().optional(),
        tags: z.array(z.string()).optional(),
        actressIds: z.array(z.number().int().positive()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // 手写管理员校验：本 procedure 用的是 protectedProcedure（仅校验登录），
      // 因此角色判断必须在这里做，删掉即等于把写权限开放给所有登录用户。
      // Check if user is admin
      if (ctx.user?.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can create videos",
        });
      }

      try {
        // views/rating 显式写死初值而不依赖列默认值，保证新片在按热度/评分排序时
        // 一定参与比较（NULL 在 MySQL 的 ORDER BY DESC 中会排到最后，行为不直观）。
        // Create video
        const result = await db.insert(videos).values({
          title: input.title,
          description: input.description,
          videoUrl: input.videoUrl,
          thumbnailUrl: input.thumbnailUrl,
          category: input.category,
          duration: input.duration,
          tags: input.tags || [],
          views: 0,
          rating: "0",
        });

        // 直接读取 MySQL 驱动返回的自增主键。`as any` 是因为 Drizzle 的 MySQL insert
        // 返回类型未暴露 insertId 字段。相比 V2 的「插入后按 title 倒序回查」，
        // 这种取法更准确（V2 那种回查在同名视频并发创建时会拿错行）。
        const videoId = (result as any).insertId;

        // 逐条插入关联关系。条数通常个位数，串行开销可忽略；
        // 但注意这里没有校验 actressId 是否真实存在，脏 ID 会静默写入产生孤儿关联。
        // Link actresses if provided
        if (input.actressIds && input.actressIds.length > 0) {
          for (const actressId of input.actressIds) {
            await db.insert(videoActresses).values({
              videoId,
              actressId,
            });
          }
        }

        return {
          success: true,
          videoId,
          message: "Video created successfully",
        };
      } catch (error) {
        console.error("[Videos Router] Error creating video:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create video",
        });
      }
    }),

  /**
   * 更新视频元数据，并可整体替换女优关联。
   *
   * @权限 admin（同 `create`，在 handler 内手写 role 检查）
   * @param input.videoId    要更新的视频 ID。
   * @param input.title/description/category/tags 均为可选的元数据字段。
   *        这里把 `input.xxx` 原样塞进 `.set()`，未传的字段值为 `undefined`；
   *        Drizzle 的 `mapUpdateSet()` 会自动剔除 undefined 项，所以「只更新传入字段」
   *        的语义是成立的（与 V2 手工构建 `updateData` 等价）。
   *        ⚠️ 但当四个元数据字段**全部**不传（只想改女优关联）时，SET 子句会变空，
   *        Drizzle 直接抛 `Error("No values to set")` —— 详见 observations。
   * @param input.actressIds 传入时会**先删后插**整体替换该视频的女优关联；
   *                         不传（undefined）则保持原有关联不变；传空数组 `[]` 表示清空关联。
   * @returns `{ success: true, message }` —— 不返回更新后的行，前端需自行 invalidate 查询缓存。
   * @副作用 写库：videos UPDATE + video_actresses DELETE/INSERT（**无事务**，
   *         删除成功但插入失败会导致女优关联全部丢失）。
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR、"Database not available"
   *         —— 注意视频不存在时**不会报错**，UPDATE 影响 0 行也返回 success。
   */
  // Update video (admin only)
  update: protectedProcedure
    .input(
      z.object({
        videoId: z.number().int().positive(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        actressIds: z.array(z.number().int().positive()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Check if user is admin
      if (ctx.user?.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can update videos",
        });
      }

      try {
        // Update video
        await db
          .update(videos)
          .set({
            title: input.title,
            description: input.description,
            category: input.category,
            tags: input.tags,
          })
          .where(eq(videos.id, input.videoId));

        // ===== 女优关联「全量替换」策略 =====
        // 先删光该视频的全部关联，再按入参重建。之所以不做差集增量更新：
        //   1. 关联表除 (videoId, actressId) 外没有业务字段，重建无信息损失；
        //   2. 差集计算需要额外一次读取 + 三路比对，收益不抵复杂度。
        // 代价：中间没有事务，DELETE 成功而 INSERT 失败会让关联"人间蒸发"。
        // 这里用 `if (input.actressIds)` 而非 `!== undefined`，语义上等价
        // （空数组是 truthy，仍会进入分支执行清空）。
        // Update actresses if provided
        if (input.actressIds) {
          // Delete existing actress links
          await db
            .delete(videoActresses)
            .where(eq(videoActresses.videoId, input.videoId));

          // Add new actress links
          for (const actressId of input.actressIds) {
            await db.insert(videoActresses).values({
              videoId: input.videoId,
              actressId,
            });
          }
        }

        return {
          success: true,
          message: "Video updated successfully",
        };
      } catch (error) {
        console.error("[Videos Router] Error updating video:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update video",
        });
      }
    }),

  /**
   * 删除视频（**硬删除**，不可恢复）。
   *
   * @权限 admin（同上，handler 内手写 role 检查）
   * @param input.videoId 视频 ID。
   * @returns `{ success: true, message }` —— 视频不存在时同样返回 success（删除 0 行）。
   * @副作用 写库：先删 video_actresses 关联，再删 videos 主表（**无事务**）。
   *         ⚠️ 不会清理该视频在 favorites / resume_playback / recommendations 中的引用，
   *         也不会删除 S3 上的视频文件与封面（存储需另行回收）。
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR、"Database not available"
   */
  // Delete video (admin only)
  delete: protectedProcedure
    .input(
      z.object({
        videoId: z.number().int().positive(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Check if user is admin
      if (ctx.user?.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can delete videos",
        });
      }

      try {
        // 删除顺序固定：先子表（关联）后主表。反过来会在中途失败时留下
        // 指向已不存在视频的孤儿关联记录，而这些记录会污染 list 的女优筛选结果。
        // Delete actress links
        await db
          .delete(videoActresses)
          .where(eq(videoActresses.videoId, input.videoId));

        // Delete video
        await db.delete(videos).where(eq(videos.id, input.videoId));

        return {
          success: true,
          message: "Video deleted successfully",
        };
      } catch (error) {
        console.error("[Videos Router] Error deleting video:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete video",
        });
      }
    }),

  /**
   * 全量女优列表，供后台「新建/编辑视频」表单的女优多选框使用。
   *
   * @权限 public —— ⚠️ 虽然用途是管理端下拉框，但这里是 publicProcedure，
   *       任何人都能拉到完整女优表（含 bio、faceEmbedding 等所有列，未做字段裁剪）。
   *       之所以是 public，是因为管理面板走的是独立的 admin-cookie 认证
   *       （见 `./admin-auth.ts`），OAuth 侧的 `ctx.user` 在管理面板里是空的。
   * @returns 女优行数组（全表，无分页、无排序）。
   * @副作用 只读（1 次全表扫描）。
   * @throws "Database not available"
   */
  // Get all actresses (for linking in video creation)
  getActresses: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const actressesData = await db.select().from(actresses);
      return actressesData;
    } catch (error) {
      console.error("[Videos Router] Error getting actresses:", error);
      throw error;
    }
  }),
});
