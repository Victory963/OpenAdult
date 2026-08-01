/**
 * ============================================================================
 * server/routers/ad-management.ts — 广告素材与投放位管理后台（tRPC 路由层）
 * ============================================================================
 *
 * ## 架构定位
 * 属于**路由层**（server/routers/）。在 `server/routers.ts` 中以 `adManagement`
 * 命名空间注册，前端通过 `trpc.adManagement.*` 调用。
 *
 * 这是广告体系的「写入端 / 后台端」；对应的「读取端 / 播放端」是
 * `server/routers/hls-stream.ts`（消费本文件写入的 ads / ad_placements 数据）。
 *
 * ## 主要导出
 * - `adManagementRouter` — 全部为**管理员专属**（见下方权限说明）：
 *   | procedure          | 类型     | 用途 |
 *   |--------------------|----------|------|
 *   | `listAds`          | query    | 列出全部广告素材（按创建时间倒序） |
 *   | `createAd`         | mutation | 新建广告素材 |
 *   | `updateAd`         | mutation | 部分更新广告素材 |
 *   | `deleteAd`         | mutation | 删除素材（级联删其投放位） |
 *   | `listPlacements`   | query    | 列出投放位（可按 videoId 过滤） |
 *   | `createPlacement`  | mutation | 新建投放位 |
 *   | `updatePlacement`  | mutation | 部分更新投放位 |
 *   | `deletePlacement`  | mutation | 删除投放位 |
 *   | `togglePlacement`  | mutation | 启用/停用投放位 |
 *   | `getAnalytics`     | query    | 广告效果汇总（曝光/点击/完播） |
 *   | `listVideos`       | query    | 视频下拉列表（供绑定投放位用） |
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/components/AdManagementUI.tsx`（管理面板的广告 Tab）
 * - 下游依赖：`getDb()`（server/db.ts）；表 `ads` / `ad_placements` / `videos`
 * - 认证依赖：读取由 `server/routers/admin-auth.ts` 签发的 `admin_session_id` cookie
 *
 * ## ⚠️ 关键设计决策与坑
 * 1. **权限用「publicProcedure + 手工校验」而非 `adminProcedure`**：
 *    本项目的管理面板走的是独立密码认证（admin-auth），与 OAuth 的 admin 角色是两套体系。
 *    因此每个 procedure 都在函数体第一行手动调 `verifyAdminFromCtx(ctx)`。
 *    风险：这是**易漏的模式** —— 新增 procedure 时忘记加这两行就等于完全公开。
 *    更稳妥的做法是抽成一个 tRPC middleware（如 `adminSessionProcedure`）。
 * 2. **JWT 校验逻辑与 admin-auth.ts 重复**：
 *    `ADMIN_COOKIE_NAME` / `ADMIN_JWT_ISSUER` / `getAdminJwtSecret()` 三处在两个文件里
 *    各写了一份，改动时必须同步，否则会出现「登录成功但管理接口全部 403」。
 * 3. **错误文案为日语**：`"管理者権限が必要です"`（需要管理员权限），直接展示给 UI。
 */

import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { ads, adPlacements, adImpressions, videos } from "../../drizzle/schema";
import { eq, desc, sql, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { jwtVerify } from "jose";
import { ENV } from "../_core/env";
import { parse as parseCookieHeader } from "cookie";

/** 管理员会话 cookie 名，必须与 admin-auth.ts 中的常量保持一致 */
const ADMIN_COOKIE_NAME = "admin_session_id";
/** JWT issuer 声明，校验时会比对；同样需与 admin-auth.ts 一致 */
const ADMIN_JWT_ISSUER = "openadult-admin";

/**
 * 派生管理员 JWT 的 HMAC 密钥。
 *
 * 在 `ENV.cookieSecret` 后拼接 `"_admin"` 后缀做域分离（domain separation）：
 * 这样管理员 token 与普通用户会话 token 使用不同密钥，
 * 即使拿到一种 token 也无法伪造另一种。
 */
function getAdminJwtSecret() {
  return new TextEncoder().encode(ENV.cookieSecret + "_admin");
}

/**
 * 从 tRPC context 中解析并校验管理员会话。
 *
 * 流程：读 Cookie 头 → 取 `admin_session_id` → 用 HS256 密钥 + issuer 校验 JWT。
 * jose 的 `jwtVerify` 会同时校验签名、issuer 与过期时间（exp）。
 *
 * @param ctx tRPC context（此处用 any 是因为只需要 `ctx.req.headers.cookie`）
 * @returns 校验通过返回 true；缺 token、签名错、过期、issuer 不匹配一律返回 false
 * @remarks 只回答「是不是管理员」，不返回 username；需要用户名时见 admin-auth.ts 的 `verifyAdminToken`
 */
async function verifyAdminFromCtx(ctx: any): Promise<boolean> {
  const cookies = parseCookieHeader(ctx.req.headers.cookie || "");
  const token = cookies[ADMIN_COOKIE_NAME];
  if (!token) return false;
  try {
    const secret = getAdminJwtSecret();
    await jwtVerify(token, secret, { issuer: ADMIN_JWT_ISSUER });
    return true;
  } catch {
    return false;
  }
}

/**
 * @deprecated 空实现的死代码：函数体没有任何语句，调用它不产生任何效果，
 * 且当前文件中也无任何地方调用。实际的鉴权拦截由各 procedure 内联的
 * `if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN" })` 完成。
 * 保留在此仅为历史痕迹，勿依赖。
 */
function requireAdmin(ctx: any) {
  // Will be called after verifyAdminFromCtx
}

export const adManagementRouter = router({
  /**
   * List all ads
   *
   * 【admin / query】列出全部广告素材（返回 ads 表整行，含 impressions/clicks 等运营字段）。
   *
   * @returns `Ad[]`，按 createdAt 倒序（最新建的排最前）
   * @sideEffect 读库 1 次，不写库
   * @throws TRPCError FORBIDDEN — 无有效管理员会话
   * @throws TRPCError INTERNAL_SERVER_ERROR — DB 不可用
   * @remarks 无分页，素材量大后需补 limit/offset
   */
  listAds: publicProcedure.query(async ({ ctx }) => {
    const isAdmin = await verifyAdminFromCtx(ctx);
    if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "管理者権限が必要です" });

    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const result = await db
      .select()
      .from(ads)
      .orderBy(desc(ads.createdAt));

    return result;
  }),

  /**
   * Create a new ad
   *
   * 【admin / mutation】新建一条广告素材，创建后默认 `isActive = true`（立即可投）。
   *
   * @param input.name         素材名（后台展示用）
   * @param input.type         素材类型 pre-roll / mid-roll / post-roll。
   *                           注意：真正决定「插在哪」的是 ad_placements.position，
   *                           这里的 type 只是素材自身的分类标签，两者可能不一致
   * @param input.videoUrl     广告 MP4 的 S3 URL（必填）
   * @param input.thumbnailUrl 可选封面图
   * @param input.clickUrl     可选点击落地页
   * @param input.duration     广告时长（秒，>=1）。**必须与实际素材时长一致**——
   *                           它会被写进 m3u8 的 `#EXTINF`，填错会导致播放器音画错位
   * @param input.priority     优先级，默认 0（数值越大理论上越优先，但当前投放解算并未使用该字段）
   *
   * @returns `{ success: true, id }`，id 取自 MySQL 的 insertId；取不到时兜底为 0
   * @sideEffect 向 `ads` 表插入 1 行
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR
   */
  createAd: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        type: z.enum(["pre-roll", "mid-roll", "post-roll"]),
        videoUrl: z.string().min(1),
        thumbnailUrl: z.string().optional(),
        clickUrl: z.string().optional(),
        duration: z.number().min(1),
        priority: z.number().default(0),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const isAdmin = await verifyAdminFromCtx(ctx);
      if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "管理者権限が必要です" });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const result = await db.insert(ads).values({
        name: input.name,
        type: input.type,
        videoUrl: input.videoUrl,
        thumbnailUrl: input.thumbnailUrl || null,
        clickUrl: input.clickUrl || null,
        duration: input.duration,
        priority: input.priority,
        isActive: true,
      });

      // mysql2 的 INSERT 返回形如 [ResultSetHeader, undefined]，故取 [0].insertId。
      // 用 as any 是因为 Drizzle 对 MySQL insert 的返回类型描述较弱。
      return { success: true, id: Number((result as any)[0]?.insertId || 0) };
    }),

  /**
   * Update an ad
   *
   * 【admin / mutation】部分更新广告素材（PATCH 语义，只改传入的字段）。
   *
   * @param input.id 目标广告 id（必填）
   * @param input.*  其余字段全部可选，未传的字段保持原值；
   *                 传 `isActive: false` 即为「下线」——已下线素材不会再被投放解算选中
   * @returns `{ success: true }`（即使 id 不存在也返回 success，不校验影响行数）
   * @sideEffect 更新 `ads` 表 0~1 行
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR
   */
  updateAd: publicProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        type: z.enum(["pre-roll", "mid-roll", "post-roll"]).optional(),
        videoUrl: z.string().min(1).optional(),
        thumbnailUrl: z.string().optional(),
        clickUrl: z.string().optional(),
        duration: z.number().min(1).optional(),
        priority: z.number().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const isAdmin = await verifyAdminFromCtx(ctx);
      if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "管理者権限が必要です" });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // 逐字段白名单拷贝：只有显式传了（!== undefined）的字段才进入 SET 子句。
      // 之所以不直接 `db.update(ads).set(updateData)`，是因为 zod 的 optional 字段
      // 在对象里会以 key 缺失或 undefined 形式存在，直接 set 可能把列写成 NULL；
      // 同时白名单也阻断了「客户端塞入 impressions/clicks 等统计字段」的越权改写。
      const { id, ...updateData } = input;
      const cleanData: Record<string, any> = {};
      if (updateData.name !== undefined) cleanData.name = updateData.name;
      if (updateData.type !== undefined) cleanData.type = updateData.type;
      if (updateData.videoUrl !== undefined) cleanData.videoUrl = updateData.videoUrl;
      if (updateData.thumbnailUrl !== undefined) cleanData.thumbnailUrl = updateData.thumbnailUrl;
      if (updateData.clickUrl !== undefined) cleanData.clickUrl = updateData.clickUrl;
      if (updateData.duration !== undefined) cleanData.duration = updateData.duration;
      if (updateData.priority !== undefined) cleanData.priority = updateData.priority;
      if (updateData.isActive !== undefined) cleanData.isActive = updateData.isActive;

      await db.update(ads).set(cleanData).where(eq(ads.id, id));
      return { success: true };
    }),

  /**
   * Delete an ad
   *
   * 【admin / mutation】硬删除广告素材。
   *
   * @param input.id 广告 id
   * @returns `{ success: true }`
   * @sideEffect 先删 `ad_placements` 中所有引用该广告的投放位，再删 `ads` 本行
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR
   * @remarks 两条 DELETE **未包在事务里**：若第二条失败，会留下「投放位已删但素材还在」的中间态。
   *          另外 `ad_impressions` 中的历史埋点不会被清理（有意保留，用于历史报表）。
   */
  deleteAd: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const isAdmin = await verifyAdminFromCtx(ctx);
      if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "管理者権限が必要です" });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Delete associated placements first
      // 必须先删投放位再删素材：ad_placements.adId 指向 ads.id，
      // 顺序反了会留下悬垂引用，导致 hls-stream 的 INNER JOIN 查不到素材（或报错）。
      await db.delete(adPlacements).where(eq(adPlacements.adId, input.id));
      await db.delete(ads).where(eq(ads.id, input.id));
      return { success: true };
    }),

  /**
   * List placements (optionally filtered by videoId)
   *
   * 【admin / query】列出投放位，并 JOIN 出广告名/类型便于后台直接展示。
   *
   * @param input.videoId 可选。传入则只看该视频的投放位；
   *                      **不传则返回全部**（含 videoId 为 null 的全局投放位）
   * @returns `{ placement, adName, adType }[]`，按投放位创建时间倒序
   * @sideEffect 读库 1 次
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR
   * @remarks 用 INNER JOIN：若某投放位引用的广告已被删除（悬垂引用），该行会被静默过滤掉
   */
  listPlacements: publicProcedure
    .input(z.object({ videoId: z.number().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = await verifyAdminFromCtx(ctx);
      if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "管理者権限が必要です" });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      let query = db
        .select({
          placement: adPlacements,
          adName: ads.name,
          adType: ads.type,
        })
        .from(adPlacements)
        .innerJoin(ads, eq(adPlacements.adId, ads.id))
        .orderBy(desc(adPlacements.createdAt));

      // ⚠️ 这里在 `.orderBy()` 之后再链 `.where()`，属于 Drizzle 查询构造器的非常规用法
      // （类型上不合法，所以强制 `as any` 绕过）。Drizzle 的构造器只是往内部 config 里塞条件、
      // 到 await 时才拼 SQL，因此运行时通常仍能生成正确的 WHERE，但这依赖实现细节，
      // 升级 drizzle-orm 版本时可能失效。更稳的写法是先算好条件再一次性 .where()。
      if (input?.videoId) {
        query = query.where(eq(adPlacements.videoId, input.videoId)) as any;
      }

      // Drizzle 查询构造器是 thenable，await 时才真正发 SQL
      return await query;
    }),

  /**
   * Create a placement
   *
   * 【admin / mutation】新建投放位 —— 即「把某支广告绑到某个（或全部）视频的某个坑位上」。
   * 这是广告能否真正出现在播放器里的**决定性配置**，`ads` 表本身只是素材库。
   *
   * @param input.videoId         目标视频 id；传 `null` 表示**全局投放**（对所有视频生效）
   * @param input.adId            要投放的广告素材 id
   * @param input.position        坑位：pre-roll（片头）/ mid-roll（中插）/ post-roll（片尾）
   * @param input.insertAtSeconds 仅 mid-roll 用：在第 N 秒插一次
   * @param input.midRollInterval 仅 mid-roll 用：每隔 N 秒重复插（如 300 = 每 5 分钟）。
   *                              与 insertAtSeconds **互斥**，两者都填时投放解算优先取 midRollInterval
   *                              （见 hls-stream.ts 的 `getAdsForVideo`）
   *
   * @returns `{ success: true }`（未回传新建 id）
   * @sideEffect 向 `ad_placements` 插入 1 行，`isActive` 固定为 true（建完即生效）
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR
   * @remarks 未校验 adId / videoId 是否真实存在，也未校验 position 与 mid-roll 参数的组合合法性；
   *          脏配置只会表现为「广告不出现」，排查时需回头看这张表。
   */
  createPlacement: publicProcedure
    .input(
      z.object({
        videoId: z.number().nullable(), // null = global (all videos)
        adId: z.number(),
        position: z.enum(["pre-roll", "mid-roll", "post-roll"]),
        insertAtSeconds: z.number().nullable().optional(),
        midRollInterval: z.number().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const isAdmin = await verifyAdminFromCtx(ctx);
      if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "管理者権限が必要です" });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      await db.insert(adPlacements).values({
        videoId: input.videoId,
        adId: input.adId,
        position: input.position,
        insertAtSeconds: input.insertAtSeconds || null,
        midRollInterval: input.midRollInterval || null,
        isActive: true,
      });

      return { success: true };
    }),

  /**
   * Delete a placement
   *
   * 【admin / mutation】硬删除单个投放位（不影响 `ads` 里的广告素材本身）。
   * 若只是想临时停投，用 `togglePlacement` 更合适。
   *
   * @param input.id 投放位 id
   * @returns `{ success: true }`
   * @sideEffect 从 `ad_placements` 删除 0~1 行
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR
   */
  deletePlacement: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const isAdmin = await verifyAdminFromCtx(ctx);
      if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "管理者権限が必要です" });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      await db.delete(adPlacements).where(eq(adPlacements.id, input.id));
      return { success: true };
    }),

  /**
   * Update a placement
   *
   * 【admin / mutation】部分更新投放位（PATCH 语义）。
   *
   * @param input.id              投放位 id（必填）
   * @param input.position        可选，改坑位
   * @param input.insertAtSeconds 可选，可显式传 `null` 清空该字段
   * @param input.midRollInterval 可选，可显式传 `null` 清空该字段
   * @param input.videoId         可选，传 `null` 即改为全局投放
   * @returns `{ success: true }`
   * @sideEffect 更新 `ad_placements` 0~1 行
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR
   * @remarks 不能通过本接口改 `adId`（换素材需删了重建）和 `isActive`（用 togglePlacement）
   */
  updatePlacement: publicProcedure
    .input(
      z.object({
        id: z.number(),
        position: z.enum(["pre-roll", "mid-roll", "post-roll"]).optional(),
        insertAtSeconds: z.number().nullable().optional(),
        midRollInterval: z.number().nullable().optional(),
        videoId: z.number().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const isAdmin = await verifyAdminFromCtx(ctx);
      if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "\u7ba1\u7406\u8005\u6a29\u9650\u304c\u5fc5\u8981\u3067\u3059" });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // 同 updateAd 的白名单拷贝。这里用 `!== undefined` 而非 truthy 判断很关键：
      // 这几个字段允许被显式置为 `null`（清空插播时间 / 改为全局投放），
      // 若写成 `if (input.videoId)` 就永远无法把它改回 null。
      const updateData: Record<string, any> = {};
      if (input.position !== undefined) updateData.position = input.position;
      if (input.insertAtSeconds !== undefined) updateData.insertAtSeconds = input.insertAtSeconds;
      if (input.midRollInterval !== undefined) updateData.midRollInterval = input.midRollInterval;
      if (input.videoId !== undefined) updateData.videoId = input.videoId;

      // 空对象会让 Drizzle 生成非法的 `SET` 空子句，因此没有任何字段变更时直接跳过 UPDATE
      if (Object.keys(updateData).length > 0) {
        await db
          .update(adPlacements)
          .set(updateData)
          .where(eq(adPlacements.id, input.id));
      }
      return { success: true };
    }),

  /**
   * Toggle placement active status
   *
   * 【admin / mutation】上/下线某个投放位（软开关，配置保留）。
   * 下线后 `hls-stream.ts` 的投放解算因带 `eq(adPlacements.isActive, true)` 条件而不再命中它。
   *
   * @param input.id       投放位 id
   * @param input.isActive 目标状态（**由调用方显式指定**，不是取反 —— 避免并发点击导致状态抖动）
   * @returns `{ success: true }`
   * @sideEffect 更新 `ad_placements.isActive` 0~1 行
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR
   */
  togglePlacement: publicProcedure
    .input(z.object({ id: z.number(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const isAdmin = await verifyAdminFromCtx(ctx);
      if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "管理者権限が必要です" });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      await db
        .update(adPlacements)
        .set({ isActive: input.isActive })
        .where(eq(adPlacements.id, input.id));
      return { success: true };
    }),

  /**
   * Get ad analytics summary
   *
   * 【admin / query】广告效果汇总表。
   *
   * 直接读 `ads` 表上由 `hlsStream.trackAdEvent` 维护的**预聚合计数器**
   * （impressions / clicks / completions），而不是对 `ad_impressions` 明细表做 COUNT——
   * 明细表随播放量线性增长，实时聚合会越来越慢。
   * 代价：数据只精确到「累计值」，无法按时间区间切片（要做时段分析得回头查明细表）。
   *
   * @returns `{ id, name, type, impressions, clicks, completions, isActive }[]`，按曝光量倒序
   * @sideEffect 读库 1 次
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR
   * @remarks CTR / 完播率由前端 `AdManagementUI.tsx` 自行计算，服务端不返回派生指标
   */
  getAnalytics: publicProcedure.query(async ({ ctx }) => {
    const isAdmin = await verifyAdminFromCtx(ctx);
    if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "管理者権限が必要です" });

    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const adsList = await db
      .select({
        id: ads.id,
        name: ads.name,
        type: ads.type,
        impressions: ads.impressions,
        clicks: ads.clicks,
        completions: ads.completions,
        isActive: ads.isActive,
      })
      .from(ads)
      .orderBy(desc(ads.impressions));

    return adsList;
  }),

  /**
   * List videos for placement selection
   *
   * 【admin / query】给「新建投放位」表单的视频下拉框提供数据源。
   *
   * 只投影 3 个字段（id / title / duration）以压缩响应体积；
   * 其中 `duration` 是必要的 —— 前端配 mid-roll 插播时间点时要据此校验不超过片长。
   *
   * @returns `{ id, title, duration }[]`，按创建时间倒序
   * @sideEffect 读库 1 次
   * @throws TRPCError FORBIDDEN / INTERNAL_SERVER_ERROR
   * @remarks 无分页也无搜索：视频量上千后这个下拉框会明显卡顿，届时需改为按需搜索
   */
  listVideos: publicProcedure.query(async ({ ctx }) => {
    const isAdmin = await verifyAdminFromCtx(ctx);
    if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "管理者権限が必要です" });

    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const result = await db
      .select({ id: videos.id, title: videos.title, duration: videos.duration })
      .from(videos)
      .orderBy(desc(videos.createdAt));

    return result;
  }),
});
