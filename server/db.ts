/**
 * server/db.ts — 数据访问层 (Data Access Layer)
 *
 * 【架构定位】
 * 本文件是整个后端唯一的「数据库查询助手」集中点，位于 tRPC router 层与 Drizzle ORM 之间。
 * 按照项目约定 (见 CLAUDE.md「数据库操作集中在 db.ts」)，路由文件不应直接拼装 SQL，
 * 而应调用这里导出的函数。实际上仓库中大量 router 直接 `import { getDb }` 后自行写查询，
 * 因此本文件承担两个角色：
 *   1) 提供共享的数据库连接单例 (`getDb`)；
 *   2) 提供用户/视频/女优/聊天/收藏/续播/推荐等领域的高层查询函数。
 *
 * 【主要导出物】
 *   - getDb()                      : 惰性初始化的 Drizzle 连接单例，DB 不可用时返回 null
 *   - upsertUser / getUserByOpenId : OAuth 登录时的用户落库与读取
 *   - getVideoById / searchVideos  : 视频读取
 *   - getActressById / getActressesByVideo : 女优读取 (含 video_actresses 关联表 join)
 *   - saveChatMessage / getChatHistory     : AI 聊天历史读写
 *   - saveSearchHistory / getSearchHistory : 搜索历史读写
 *   - addFavorite / removeFavorite / getUserFavorites : 收藏
 *   - updateResumePlayback / getResumePlayback        : 续播位置
 *   - getUserPreferences / updateUserPreferences      : 用户偏好
 *   - getRecommendations / saveRecommendation / clearUserRecommendations : AI 推荐
 *   - getUserWatchHistory / trackWatchBehavior        : 观看行为
 *   - calculateRecommendationScore                    : 纯函数，推荐分加权计算
 *   - analyzeUserPreferences / getRelevantVideosForChat / getRelevantActressesForChat
 *                                  : 为 Chat AI 组装「用户画像 + 候选内容」上下文
 *
 * 【上下游依赖】
 *   上游 (调用方)：server/routers.ts (聊天/推荐/收藏/续播等 procedure)、
 *                  server/_core/sdk.ts 与 server/_core/oauth.ts (登录时 upsertUser)、
 *                  server/search.ts、server/routers/*.ts、server/_core/hlsRoutes.ts 等。
 *   下游 (被依赖)：drizzle-orm/mysql2 (MySQL/TiDB)、../drizzle/schema (表定义)、
 *                  ./_core/env (读取 ownerOpenId 用于自动授予 admin 角色)。
 *
 * 【关键设计决策 / 坑】
 *   1. **数据库可选**：几乎每个函数都以 `if (!db) return <空值>` 开头。这是刻意为之——
 *      本项目允许在没有 DATABASE_URL 的环境下启动 (例如纯前端预览/CI)，此时所有查询降级为
 *      空结果而不是抛错。副作用是：调用方无法区分「查不到」与「数据库没连上」。
 *   2. **表可能尚未迁移**：部分函数额外包了 try/catch 并打印 "table may not exist"，
 *      因为 drizzle 迁移 SQL 需要手动应用到生产库，新表在旧库上会直接报 SQL 错误。
 *   3. 本文件不做权限校验，权限由 tRPC 层的 publicProcedure/protectedProcedure/adminProcedure 负责。
 */

import { eq, desc, and, like, or, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, videos, actresses, chatMessages, searchHistory, favorites, resumePlayback, userPreferences, recommendations, videoActresses } from "../drizzle/schema";
import { ENV } from './_core/env';

/**
 * 进程级的 Drizzle 连接单例。
 * 为 null 表示「尚未初始化」或「上次初始化失败 / 未配置 DATABASE_URL」。
 */
let _db: ReturnType<typeof drizzle> | null = null;

/**
 * 获取共享的 Drizzle 数据库连接 (惰性单例)。
 *
 * 行为：
 *   - 首次调用且存在 `process.env.DATABASE_URL` 时创建连接并缓存；
 *   - 创建失败只打 warn 并保持 `_db = null`，**不抛错**，下次调用会再次尝试 (相当于隐式重试)；
 *   - 未配置 DATABASE_URL 时恒返回 null，调用方需自行降级。
 *
 * 注意：
 *   - 函数标记为 async 但内部无 await，纯粹是为了让所有调用点统一写 `await getDb()`，
 *     将来若改为异步建连 (连接池预热等) 不需要修改调用方。
 *   - 这里直接读 `process.env.DATABASE_URL` 而非 `ENV.databaseUrl`，因此测试可以在
 *     模块加载后再注入环境变量。
 *
 * @returns Drizzle 实例；数据库不可用时为 null
 */
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/**
 * 按 openId 插入或更新用户记录 (OAuth 登录回调时调用)。
 *
 * 语义为 MySQL 的 `INSERT ... ON DUPLICATE KEY UPDATE`，唯一键是 `users.openId`。
 * 这里刻意区分了两个对象：
 *   - `values`    : 首次插入时写入的完整行；
 *   - `updateSet` : 命中重复键时**只**更新的字段集合。
 * 只有调用方显式传入 (!== undefined) 的字段才会进入 updateSet，
 * 目的是避免一次「只带 openId 的登录」把已有的 name/email 覆盖成 null。
 *
 * @param user 待写入的用户数据；`openId` 必填，其余字段可选。
 *             传 `null` 表示「显式清空该字段」，传 `undefined` 表示「保持不变」。
 * @returns 无返回值
 * @throws 当 `openId` 缺失时抛错；数据库写入失败时打日志后向上抛出 (登录流程需感知失败)
 *
 * 副作用：写 `users` 表。
 * 权限：内部函数，由 OAuth/SDK 层调用，不直接暴露给客户端。
 */
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    // 数据库不可用时静默跳过：登录流程本身 (JWT Cookie) 仍可继续，只是不落库。
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    // 把「可为空的文本字段」同时写进 values 和 updateSet：
    // undefined => 完全不碰这个列；null => 显式写 NULL。
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    // language 是 NOT NULL 且有默认值 'ja' 的枚举列，所以 null 也要一并跳过，
    // 不能像上面的文本字段那样允许写 NULL。
    if (user.language !== undefined && user.language !== null) {
      values.language = user.language;
      updateSet.language = user.language;
    }

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      // 站点所有者 (OWNER_OPEN_ID 环境变量) 每次登录都自动提升为 admin，
      // 这是管理面板的「后门」入口：无需手工改库即可拿到管理权限。
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    // 插入路径兜底：lastSignedIn 是 NOT NULL 列，调用方没传时用当前时间。
    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    // MySQL 不允许 `ON DUPLICATE KEY UPDATE` 后面跟空的 SET 子句，
    // 因此当调用方只传了 openId 时，至少刷新一次登录时间，保证语句合法。
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

/**
 * 按 OAuth openId 查询用户。
 *
 * @param openId Manus OAuth 返回的用户唯一标识 (users.openId 唯一索引)
 * @returns 用户行；不存在或数据库不可用时返回 undefined
 *
 * 副作用：无 (只读)。
 * 权限：内部函数，被 tRPC context 用于把 Cookie 中的 openId 解析成用户实体。
 */
export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ===== 视频查询 (Video queries) =====

/**
 * 按主键读取单个视频元数据。
 *
 * @param videoId videos.id
 * @returns 视频行；不存在或数据库不可用时为 undefined
 *
 * 副作用：无 (只读)。
 * 权限：被 publicProcedure (视频详情页) 使用，无需登录。
 */
export async function getVideoById(videoId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * 视频文本搜索（**当前为未完成的占位实现**）。
 *
 * 注意：`query` 参数目前被完全忽略，函数实际返回的是「前 limit 条视频」而非搜索结果。
 * 已有注释标注计划改为全文检索 (MySQL FULLTEXT / 外部搜索引擎)。
 * 真正对外的搜索逻辑目前在 server/search.ts 与 server/routers/videos-v2.ts 中用 LIKE 实现。
 *
 * @param query 搜索关键词（当前未生效）
 * @param limit 返回条数上限，默认 20
 * @returns 视频数组；数据库不可用时为空数组
 *
 * 副作用：无 (只读)。
 */
export async function searchVideos(query: string, limit: number = 20) {
  const db = await getDb();
  if (!db) return [];

  // Simple text search - can be enhanced with full-text search
  return await db.select().from(videos).limit(limit);
}

// ===== 女优查询 (Actress queries) =====

/**
 * 按主键读取单个女优资料。
 *
 * @param actressId actresses.id
 * @returns 女优行；不存在或数据库不可用时为 undefined
 *
 * 副作用：无 (只读)。
 */
export async function getActressById(actressId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(actresses).where(eq(actresses.id, actressId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * 查询某个视频关联的全部女优。
 *
 * 通过多对多中间表 `video_actresses` 做 INNER JOIN，
 * 只 select 出 actress 列后再 map 平铺，避免把中间表字段泄漏给前端。
 * 未加 limit：单个视频关联的女优数量在业务上是可控的小集合。
 *
 * @param videoId videos.id
 * @returns 女优数组；无关联或数据库不可用时为空数组
 *
 * 副作用：无 (只读)。
 */
export async function getActressesByVideo(videoId: number) {
  const db = await getDb();
  if (!db) return [];

  const result = await db
    .select({ actress: actresses })
    .from(videoActresses)
    .innerJoin(actresses, eq(videoActresses.actressId, actresses.id))
    .where(eq(videoActresses.videoId, videoId));

  return result.map(r => r.actress);
}

// ===== AI 聊天历史 (Chat message queries) =====

/**
 * 追加一条聊天消息 (用户提问或 AI 回复) 到 `chat_messages`。
 *
 * @param userId  users.id
 * @param role    "user" = 用户输入；"assistant" = LLM 回复
 * @param content 消息正文 (TEXT 列，超长内容会被 MySQL 截断/报错)
 * @returns Drizzle 的 insert 结果 (含 insertId)；数据库不可用时为 null
 *
 * 副作用：写 `chat_messages` 表。
 * 权限：由 protectedProcedure (聊天接口) 调用，需登录。
 */
export async function saveChatMessage(userId: number, role: "user" | "assistant", content: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await db.insert(chatMessages).values({
    userId,
    role,
    content,
  });

  return result;
}

/**
 * 读取某用户最近的聊天记录。
 *
 * 注意排序为 **createdAt 倒序**，即返回的第一条是最新消息。
 * 送入 LLM 作为多轮上下文前，调用方需要自行 reverse 成时间正序。
 *
 * @param userId users.id
 * @param limit  返回条数上限，默认 50 (约等于 25 轮对话，用于控制 LLM 上下文长度)
 * @returns 消息数组 (新 → 旧)；数据库不可用时为空数组
 *
 * 副作用：无 (只读)。
 * 权限：protectedProcedure。
 */
export async function getChatHistory(userId: number, limit: number = 50) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.userId, userId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);
}

// ===== 搜索历史 (Search history queries) =====

/**
 * 记录一次搜索行为。这些数据后续被 `analyzeUserPreferences` 用来构建用户画像。
 *
 * @param userId       users.id
 * @param query        搜索词；人脸/图片搜索时通常存的是描述或文件标识
 * @param searchType   "text" 文本搜索 | "face" 人脸相似度检索 | "image" 以图搜图
 * @param resultsCount 本次搜索命中条数，默认 0；用于评估搜索质量
 * @returns insert 结果；数据库不可用时为 null
 *
 * 副作用：写 `search_history` 表。
 * 权限：protectedProcedure (匿名搜索不落库)。
 */
export async function saveSearchHistory(userId: number, query: string, searchType: "text" | "face" | "image", resultsCount: number = 0) {
  const db = await getDb();
  if (!db) return null;

  return await db.insert(searchHistory).values({
    userId,
    query,
    searchType,
    resultsCount,
  });
}

/**
 * 读取某用户最近的搜索历史 (新 → 旧)。
 *
 * @param userId users.id
 * @param limit  返回条数上限，默认 20
 * @returns 搜索历史数组；数据库不可用时为空数组
 *
 * 副作用：无 (只读)。
 * 权限：protectedProcedure。
 */
export async function getSearchHistory(userId: number, limit: number = 20) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(searchHistory)
    .where(eq(searchHistory.userId, userId))
    .orderBy(desc(searchHistory.createdAt))
    .limit(limit);
}

// ===== 收藏 (Favorites queries) =====

/**
 * 添加一条收藏记录。
 *
 * 注意：`favorites` 表没有 (userId, videoId) 唯一约束，重复调用会插入重复行。
 * 调用方 (routers.ts) 需自行保证幂等，或依赖前端的收藏态判断。
 *
 * @param userId  users.id
 * @param videoId videos.id
 * @returns insert 结果；数据库不可用时为 null
 *
 * 副作用：写 `favorites` 表。
 * 权限：protectedProcedure。
 */
export async function addFavorite(userId: number, videoId: number) {
  const db = await getDb();
  if (!db) return null;

  return await db.insert(favorites).values({
    userId,
    videoId,
  });
}

/**
 * 取消收藏：删除该用户对该视频的所有收藏行 (顺带清理上面提到的重复行)。
 *
 * @param userId  users.id
 * @param videoId videos.id
 * @returns delete 结果；数据库不可用时为 null
 *
 * 副作用：删 `favorites` 表数据。
 * 权限：protectedProcedure。
 */
export async function removeFavorite(userId: number, videoId: number) {
  const db = await getDb();
  if (!db) return null;

  return await db
    .delete(favorites)
    .where(and(eq(favorites.userId, userId), eq(favorites.videoId, videoId)));
}

/**
 * 读取用户收藏的视频列表 (按收藏时间倒序)。
 *
 * 使用 INNER JOIN 而非两次查询：一次拿到完整视频元数据，同时天然过滤掉
 * 「已被删除的视频仍残留收藏记录」的脏数据。
 *
 * @param userId users.id
 * @param limit  返回条数上限，默认 50
 * @returns 视频数组；出错时降级为空数组
 *
 * 副作用：无 (只读)。
 * 权限：protectedProcedure。
 * 容错：`favorites` 表在未执行迁移的旧库上可能不存在，这里吞掉 SQL 错误只打 warn，
 *       避免整个 Dashboard 页面因为一个可选模块而 500。
 */
export async function getUserFavorites(userId: number, limit: number = 50) {
  const db = await getDb();
  if (!db) return [];

  try {
    const result = await db
      .select({ video: videos })
      .from(favorites)
      .innerJoin(videos, eq(favorites.videoId, videos.id))
      .where(eq(favorites.userId, userId))
      .orderBy(desc(favorites.createdAt))
      .limit(limit);

    return result.map(r => r.video);
  } catch (error) {
    console.warn("getUserFavorites error (table may not exist):", (error as any)?.sqlMessage || error);
    return [];
  }
}

// ===== 续播位置 (Resume playback queries) =====

/**
 * 写入/更新「用户在某视频上的播放进度」。
 *
 * 采用「先 SELECT 再 UPDATE 或 INSERT」的手工 upsert，而不是
 * `ON DUPLICATE KEY UPDATE`——因为 `resume_playback` 表上并没有
 * (userId, videoId) 的唯一索引，无法触发重复键路径。
 * 副作用是存在并发竞态：同一用户在两个标签页同时播放可能插入两行。
 *
 * @param userId   users.id
 * @param videoId  videos.id
 * @param position 当前播放位置 (秒)
 * @param duration 视频总时长 (秒)，冗余存储便于前端直接算进度百分比
 * @returns update/insert 结果；数据库不可用或出错时为 null
 *
 * 副作用：写 `resume_playback` 表。
 * 权限：protectedProcedure。
 * 容错：整个函数体包在 try/catch 中——播放心跳是高频调用，失败时不应打断播放。
 */
export async function updateResumePlayback(userId: number, videoId: number, position: number, duration: number) {
  try {
    const db = await getDb();
    if (!db) return null;

    const existing = await db
      .select()
      .from(resumePlayback)
      .where(and(eq(resumePlayback.userId, userId), eq(resumePlayback.videoId, videoId)))
      .limit(1);
    
    if (existing.length > 0) {
      return await db
        .update(resumePlayback)
        .set({ position, duration, lastWatchedAt: new Date() })
        .where(and(eq(resumePlayback.userId, userId), eq(resumePlayback.videoId, videoId)));
    } else {
      return await db.insert(resumePlayback).values({
        userId,
        videoId,
        position,
        duration,
      });
    }
  } catch (error) {
    console.error('Error updating resume playback:', error);
    return null;
  }
}

/**
 * 读取用户在某视频上的续播记录，用于播放器初始化时 seek 到上次位置。
 *
 * @param userId  users.id
 * @param videoId videos.id
 * @returns 续播行 (含 position/duration/lastWatchedAt)；无记录或出错时为 null
 *
 * 副作用：无 (只读)。
 * 权限：protectedProcedure。
 */
export async function getResumePlayback(userId: number, videoId: number) {
  try {
    const db = await getDb();
    if (!db) return null;
    
    const result = await db
      .select()
      .from(resumePlayback)
      .where(and(eq(resumePlayback.userId, userId), eq(resumePlayback.videoId, videoId)))
      .limit(1);
    
    return result.length > 0 ? result[0] : null;
  } catch (error) {
    console.error('Error fetching resume playback:', error);
    return null;
  }
}

// ===== 用户偏好 (User preferences queries) =====

/**
 * 读取用户的显式偏好设置 (偏好分类 / 偏好女优 / 屏蔽分类，均为 JSON 列)。
 *
 * 与 `analyzeUserPreferences` 的区别：这里是用户**主动配置**的偏好，
 * 后者是从行为日志**推断**出来的隐式画像。
 *
 * @param userId users.id
 * @returns 偏好行；未设置过或数据库不可用时为 null
 *
 * 副作用：无 (只读)。
 * 权限：protectedProcedure。
 */
export async function getUserPreferences(userId: number) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

/**
 * 更新用户偏好；不存在则创建 (手工 upsert)。
 *
 * `user_preferences.userId` 上有唯一约束，理论上可用 onDuplicateKeyUpdate，
 * 这里选择先查后写是为了复用 `getUserPreferences` 的降级逻辑。
 *
 * @param userId      users.id
 * @param preferences 部分字段的偏好对象；未传的字段保持原值 (UPDATE 只 SET 传入的列)
 * @returns update/insert 结果；数据库不可用时为 null
 *
 * 副作用：写 `user_preferences` 表。
 * 权限：protectedProcedure。
 */
export async function updateUserPreferences(userId: number, preferences: Partial<typeof userPreferences.$inferInsert>) {
  const db = await getDb();
  if (!db) return null;

  const existing = await getUserPreferences(userId);
  
  if (existing) {
    return await db
      .update(userPreferences)
      .set(preferences)
      .where(eq(userPreferences.userId, userId));
  } else {
    return await db.insert(userPreferences).values({
      userId,
      ...preferences,
    });
  }
}

// ===== AI 推荐 (Recommendations queries) =====

/**
 * 读取已落库的 AI 推荐结果，按推荐分从高到低。
 *
 * 返回值把视频元数据与推荐元信息 (reason/score) 摊平到同一个对象，
 * 方便前端 VideoCard 直接渲染「推荐理由」而不用二次关联。
 *
 * @param userId users.id
 * @param limit  返回条数上限，默认 20
 * @returns 视频数组，每项额外带 `reason` 与 `score`；出错时为空数组
 *
 * 副作用：无 (只读)。
 * 权限：protectedProcedure。
 */
export async function getRecommendations(userId: number, limit: number = 20) {
  const db = await getDb();
  if (!db) return [];

  try {
    const result = await db
      .select({ video: videos, recommendation: recommendations })
      .from(recommendations)
      .innerJoin(videos, eq(recommendations.videoId, videos.id))
      .where(eq(recommendations.userId, userId))
      .orderBy(desc(recommendations.score))
      .limit(limit);
    
    return result.map(r => ({ ...r.video, reason: r.recommendation.reason, score: r.recommendation.score }));
  } catch (error) {
    console.error("Error fetching recommendations:", error);
    return [];
  }
}

/**
 * 落库一条 AI 推荐结果。
 *
 * @param userId  users.id
 * @param videoId 被推荐的 videos.id
 * @param reason  LLM 给出的推荐理由文本，直接展示给用户
 * @param score   推荐分，取值范围与 `calculateRecommendationScore` 一致 (0~1)
 * @returns insert 结果；数据库不可用时为 null
 *
 * 副作用：写 `recommendations` 表。
 * 权限：protectedProcedure (由推荐生成流程调用)。
 *
 * 注意：`recommendations.score` 是 DECIMAL(5,2) 列，mysql2 驱动要求以字符串传入
 * 才能避免浮点精度问题，因此这里 `score.toString()` 并用 `as any` 绕过
 * Drizzle 对 decimal 列的类型声明。DECIMAL(5,2) 只保留两位小数，
 * 0~1 区间的推荐分会被截断到 0.01 的精度。
 */
export async function saveRecommendation(userId: number, videoId: number, reason: string, score: number) {
  const db = await getDb();
  if (!db) return null;

  return await db.insert(recommendations).values({
    userId,
    videoId,
    reason,
    score: score.toString() as any,
  });
}


/**
 * 读取用户观看历史 (以续播记录为数据源，按最后观看时间倒序)。
 *
 * 项目没有单独的 watch_history 表，`resume_playback` 同时充当
 * 「续播位置」和「观看过的视频」两种语义——只要播放过就会有一行。
 *
 * @param userId users.id
 * @param limit  返回条数上限，默认 20
 * @returns 视频数组 (新 → 旧)；出错时为空数组
 *
 * 副作用：无 (只读)。
 * 权限：protectedProcedure。
 */
export async function getUserWatchHistory(userId: number, limit: number = 20) {
  const db = await getDb();
  if (!db) return [];

  try {
    const result = await db
      .select({ video: videos, playback: resumePlayback })
      .from(resumePlayback)
      .innerJoin(videos, eq(resumePlayback.videoId, videos.id))
      .where(eq(resumePlayback.userId, userId))
      .orderBy(desc(resumePlayback.lastWatchedAt))
      .limit(limit);
    
    return result.map(r => r.video);
  } catch (error) {
    console.error("Error fetching watch history:", error);
    return [];
  }
}

/**
 * 清空某用户的全部历史推荐。
 *
 * 推荐流程是「全量重算」而非增量更新：前端点「刷新推荐」时先调用本函数清库，
 * 再由 LLM 生成新的一批并逐条 `saveRecommendation`，避免旧推荐与新推荐混排。
 *
 * @param userId users.id
 * @returns delete 结果；数据库不可用时为 null
 *
 * 副作用：删除 `recommendations` 表中该用户的所有行。
 * 权限：protectedProcedure。
 */
export async function clearUserRecommendations(userId: number) {
  const db = await getDb();
  if (!db) return null;

  return await db.delete(recommendations).where(eq(recommendations.userId, userId));
}

/**
 * 记录观看行为 (写入/更新 `resume_playback`)，为推荐系统提供行为数据。
 *
 * 与 `updateResumePlayback` 功能高度重叠，区别仅在于参数命名
 * (watchDuration/totalDuration vs position/duration) 以及本函数显式写入 lastWatchedAt。
 *
 * @param userId        users.id
 * @param videoId       videos.id
 * @param watchDuration 已观看时长 / 当前位置 (秒)，写入 position 列
 * @param totalDuration 视频总时长 (秒)，写入 duration 列
 * @returns update/insert 结果；数据库不可用或出错时为 null
 *
 * 副作用：写 `resume_playback` 表。
 * 权限：protectedProcedure。
 *
 * ⚠️ 已知问题：下面的 WHERE 条件用的是 JavaScript 的 `&&` 而不是 Drizzle 的 `and(...)`。
 *    `&&` 会直接返回右侧操作数 (SQL 条件对象是 truthy)，因此实际生成的条件
 *    **只有 videoId 过滤，丢失了 userId 过滤**。这里保留原样不做修改，详见返回的 observations。
 */
export async function trackWatchBehavior(userId: number, videoId: number, watchDuration: number, totalDuration: number) {
  const db = await getDb();
  if (!db) return null;

  try {
    // Update or insert resume playback record
    const existing = await db.select().from(resumePlayback)
      .where(eq(resumePlayback.userId, userId) && eq(resumePlayback.videoId, videoId))
      .limit(1);

    if (existing.length > 0) {
      return await db.update(resumePlayback)
        .set({
          position: watchDuration,
          duration: totalDuration,
          lastWatchedAt: new Date(),
        })
        .where(eq(resumePlayback.userId, userId) && eq(resumePlayback.videoId, videoId));
    } else {
      return await db.insert(resumePlayback).values({
        userId,
        videoId,
        position: watchDuration,
        duration: totalDuration,
        lastWatchedAt: new Date(),
      });
    }
  } catch (error) {
    console.error("Error tracking watch behavior:", error);
    return null;
  }
}


/**
 * 计算综合推荐分 (纯函数，无 IO)。
 *
 * 五个维度按固定权重线性加权，权重之和恰为 1.0，
 * 因此当所有入参都落在 [0,1] 时，结果同样落在 [0,1]，可直接存入 DECIMAL(5,2) 的 score 列。
 * 权重分配的业务含义：关键词命中最重要 (0.3)，分类与女优偏好次之 (各 0.2)，
 * 观看历史相似度与热度作为平滑因子 (各 0.15) 防止推荐过度收敛到单一口味。
 *
 * 注意：函数不做入参裁剪 (clamp)，传入越界值会得到越界结果，由调用方保证归一化。
 *
 * @param keywordMatch      0-1，与用户查询关键词的匹配度
 * @param categoryMatch     0-1，与用户偏好分类的匹配度
 * @param actressMatch      0-1，与用户偏好女优的匹配度
 * @param watchHistoryMatch 0-1，与已观看视频的相似度
 * @param popularityScore   0-1，视频热度 (播放量归一化)
 * @returns 加权后的推荐分 (0-1)
 *
 * 副作用：无。
 */
// Calculate recommendation score based on multiple factors
export function calculateRecommendationScore(
  keywordMatch: number, // 0-1, keyword matching score
  categoryMatch: number, // 0-1, category preference match
  actressMatch: number, // 0-1, actress preference match
  watchHistoryMatch: number, // 0-1, similar to watched videos
  popularityScore: number // 0-1, video popularity
): number {
  // Weighted scoring: keyword(0.3) + category(0.2) + actress(0.2) + watchHistory(0.15) + popularity(0.15)
  return (
    keywordMatch * 0.3 +
    categoryMatch * 0.2 +
    actressMatch * 0.2 +
    watchHistoryMatch * 0.15 +
    popularityScore * 0.15
  );
}


// ===== User Preference Analysis for Chat AI =====

/**
 * Analyze user's search history to extract keyword frequency and preferences
 *
 * 分析用户行为日志，产出一份「隐式用户画像」，供 `buildChatSystemPrompt`
 * (server/llm-prompts.ts) 拼进 LLM 的 system prompt，实现个性化推荐。
 *
 * 数据来源与聚合口径：
 *   1. 关键词      ← 最近 50 条 search_history，切词后按词频排序，取 Top 15
 *   2. 观看分类    ← 最近 30 条 resume_playback 关联的视频的 category + tags，取 Top 10
 *   3. topCategories ← 直接取 watchedCategories 的前 5 (见下方注释，与原计划不符)
 *   4. 常看女优    ← 最近 20 条收藏视频关联的女优，按出现次数排序取 Top 5
 *   5. 近期搜索    ← 原始搜索词，取最近 10 条
 *
 * @param userId users.id
 * @returns 画像对象；任一步骤失败或数据库不可用时返回**全空结构**而非抛错，
 *          保证聊天功能在无画像的情况下仍能正常工作 (降级为通用推荐)。
 *
 * 副作用：无 (只读，跨 4 张表)。
 * 权限：protectedProcedure (需要 userId)。
 *
 * 性能注意：本函数会串行发起 4~5 次查询，属于聊天请求的前置开销，
 * 目前没有缓存，高频对话场景下每条消息都会重算一次。
 */
export async function analyzeUserPreferences(userId: number): Promise<{
  topKeywords: Array<{ keyword: string; count: number }>;
  topCategories: Array<{ category: string; count: number }>;
  favoriteActresses: Array<{ id: number; name: string; profileImageUrl: string | null }>;
  recentSearches: string[];
  watchedCategories: Array<{ category: string; count: number }>;
}> {
  const db = await getDb();
  if (!db) return { topKeywords: [], topCategories: [], favoriteActresses: [], recentSearches: [], watchedCategories: [] };

  try {
    // 1. Get recent search history (last 50)
    const searches = await db
      .select()
      .from(searchHistory)
      .where(eq(searchHistory.userId, userId))
      .orderBy(desc(searchHistory.createdAt))
      .limit(50);

    // 2. Extract keyword frequency from search queries
    //
    // 词频统计：日语/中文没有天然的空格分词，这里采用「按分隔符切分」的近似方案。
    // 下面 split 用的字符类覆盖了：
    //   \s      半角空白           +   加号 (搜索框里常用作 AND 连接符)
    //   ,       半角逗号           、  日文顿号
    //   。      日文句号           ・  日文中黑点 (常用于分隔女优姓名)
    //   　  全角空格 (日文/中文输入法下的默认空格，是这里最关键的一个字符)
    // 随后的 filter(w.length >= 2) 用于滤掉「の」「的」「a」这类单字符噪音——
    // 它们出现频率极高却完全无法反映用户偏好。
    const keywordMap = new Map<string, number>();
    const recentSearches: string[] = [];
    for (const s of searches) {
      const query = s.query as string;
      if (!query) continue;
      recentSearches.push(query);
      // Split by common delimiters and count keywords
      const words = query.split(/[\s+,、。・\u3000]+/).filter(w => w.length >= 2);
      for (const word of words) {
        keywordMap.set(word, (keywordMap.get(word) || 0) + 1);
      }
    }
    // 按词频降序取 Top 15：条数上限是为了控制注入 LLM system prompt 的 token 体积。
    const topKeywords = Array.from(keywordMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([keyword, count]) => ({ keyword, count }));

    // 3. Get watched video categories
    const watchHistory = await db
      .select({ video: videos })
      .from(resumePlayback)
      .innerJoin(videos, eq(resumePlayback.videoId, videos.id))
      .where(eq(resumePlayback.userId, userId))
      .orderBy(desc(resumePlayback.lastWatchedAt))
      .limit(30);

    // 把 category (单值) 与 tags (JSON 数组) 混在同一个计数 Map 里统计：
    // 对 LLM 而言两者都是「内容标签」，不需要区分来源；
    // 代价是同名的分类与标签会被合并计数。
    const categoryMap = new Map<string, number>();
    for (const { video } of watchHistory) {
      if (video.category) {
        categoryMap.set(video.category, (categoryMap.get(video.category) || 0) + 1);
      }
      // Also count tags
      if (video.tags && Array.isArray(video.tags)) {
        for (const tag of video.tags as string[]) {
          categoryMap.set(tag, (categoryMap.get(tag) || 0) + 1);
        }
      }
    }
    const watchedCategories = Array.from(categoryMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([category, count]) => ({ category, count }));

    // 4. Get top categories from search history keywords matching video categories
    //
    // 注意：注释描述的是「用搜索关键词去匹配视频分类」，但实现只是把观看分类截了前 5 条，
    // 因此 topCategories 目前是 watchedCategories 的子集，两者信息重复。
    // 保持原样不动，问题记录在 observations 中。
    const topCategories = watchedCategories.slice(0, 5);

    // 5. Get favorite actresses (from videos the user watched or favorited)
    //
    // 这一段单独包 try/catch：favorites / video_actresses 属于较晚加入的表，
    // 在未执行迁移的旧库上会直接报 SQL 错误。女优画像是「锦上添花」的信息，
    // 缺失时不应让整个画像分析失败，因此这里静默降级为空数组。
    let favoriteActresses: Array<{ id: number; name: string; profileImageUrl: string | null }> = [];
    try {
      // Get actresses from favorited videos
      const favVideos = await db
        .select({ videoId: favorites.videoId })
        .from(favorites)
        .where(eq(favorites.userId, userId))
        .limit(20);

      if (favVideos.length > 0) {
        const videoIds = favVideos.map(f => f.videoId);
        const actressResults = await db
          .select({ actress: actresses })
          .from(videoActresses)
          .innerJoin(actresses, eq(videoActresses.actressId, actresses.id))
          .where(inArray(videoActresses.videoId, videoIds))
          .limit(10);

        // 以 actress.id 为键做去重 + 计数：一位女优在多部收藏作品中出现，
        // 说明用户偏好更强，count 越大排序越靠前。
        const actressMap = new Map<number, { id: number; name: string; profileImageUrl: string | null; count: number }>();
        for (const { actress } of actressResults) {
          const existing = actressMap.get(actress.id);
          if (existing) {
            existing.count++;
          } else {
            actressMap.set(actress.id, { id: actress.id, name: actress.name, profileImageUrl: actress.profileImageUrl, count: 1 });
          }
        }
        favoriteActresses = Array.from(actressMap.values())
          .sort((a, b) => b.count - a.count)
          .slice(0, 5)
          .map(({ id, name, profileImageUrl }) => ({ id, name, profileImageUrl }));
      }
    } catch (e) {
      // Silently handle if tables don't exist yet
    }

    return {
      topKeywords,
      topCategories,
      favoriteActresses,
      recentSearches: recentSearches.slice(0, 10),
      watchedCategories,
    };
  } catch (error) {
    console.error("Error analyzing user preferences:", error);
    return { topKeywords: [], topCategories: [], favoriteActresses: [], recentSearches: [], watchedCategories: [] };
  }
}

/**
 * Get relevant videos based on user preferences for chat recommendations
 *
 * 为 Chat AI 检索「可推荐的候选视频」，结果会被注入 system prompt，
 * 让 LLM 只在数据库真实存在的视频里做推荐 (避免凭空捏造标题/ID)。
 *
 * 检索策略 (两路召回 + 合并去重)：
 *   A. 标题 / 分类 LIKE 模糊匹配 —— 每个关键词生成 2 个 OR 条件；
 *   B. 女优姓名 (name / japaneseName / chineseName) 匹配 → 经 video_actresses 反查视频；
 *   两路结果按 id 去重后截取 limit 条，A 路优先 (排在数组前面)。
 * 关键词为空时退化为「按播放量取热门视频」。
 *
 * @param query 用户本轮的自然语言提问，直接按分隔符切词使用
 * @param limit 返回条数上限，默认 10 (同样是为了控制 prompt token 体积)
 * @returns 精简后的视频字段数组 (id/title/thumbnailUrl/category/rating/tags)；出错时为空数组
 *
 * 副作用：无 (只读)。
 * 权限：protectedProcedure。
 *
 * 注意：`userId` 参数当前在函数体内未被使用——检索是纯 query 驱动的，
 * 个性化部分由 `analyzeUserPreferences` 单独提供。
 */
export async function getRelevantVideosForChat(userId: number, query: string, limit: number = 10): Promise<Array<{ id: number; title: string; thumbnailUrl: string | null; category: string | null; rating: string | null; tags: string[] | null }>> {
  const db = await getDb();
  if (!db) return [];

  try {
    // Search videos matching the query keywords
    const keywords = query.split(/[\s+,、。・\u3000]+/).filter(w => w.length >= 1);
    
    // 这里的切词过滤条件是 length >= 1 (而非画像统计里的 >= 2)：
    // 用户可能直接搜单个汉字/假名的分类名，召回阶段宁可放宽也不要漏召。
    if (keywords.length === 0) {
      // Return popular videos if no keywords
      const results = await db
        .select()
        .from(videos)
        .orderBy(desc(videos.views))
        .limit(limit);
      return results.map(v => ({ id: v.id, title: v.title, thumbnailUrl: v.thumbnailUrl, category: v.category, rating: v.rating, tags: v.tags }));
    }

    // Build OR conditions for keyword matching on video title/category
    //
    // flatMap 把 N 个关键词展开成 2N 个 LIKE 条件，最终用 or(...) 串成
    // `title LIKE %kw1% OR category LIKE %kw1% OR title LIKE %kw2% ...`。
    // 这是 OR 语义 (任一命中即召回) 而非 AND，属于「宽召回 + 交给 LLM 精排」的设计。
    // 坑：`%kw%` 前置通配符使 MySQL 无法走索引，视频量大时会全表扫描；
    //     同时关键词中的 % 与 _ 未做转义 (Drizzle 只做参数绑定，不转义 LIKE 元字符)。
    const conditions = keywords.flatMap(kw => [
      like(videos.title, `%${kw}%`),
      like(videos.category, `%${kw}%`),
    ]);

    const results = await db
      .select()
      .from(videos)
      .where(or(...conditions))
      .orderBy(desc(videos.views))
      .limit(limit);

    // Also search by actress name to find videos linked to matching actresses
    //
    // 第二路召回：用户常常直接输入女优名字，而视频标题里未必包含该名字，
    // 因此需要「关键词 → 女优 → video_actresses → 视频」三跳查询。
    // 三个姓名字段都要匹配，因为同一位女优有罗马字/日文/中文三种常见写法。
    const actressConditions = keywords.flatMap(kw => [
      like(actresses.name, `%${kw}%`),
      like(actresses.japaneseName, `%${kw}%`),
      like(actresses.chineseName, `%${kw}%`),
    ]);

    let actressVideoResults: Array<{ id: number; title: string; thumbnailUrl: string | null; category: string | null; rating: string | null; tags: string[] | null }> = [];
    try {
      const matchedActresses = await db
        .select({ id: actresses.id })
        .from(actresses)
        .where(or(...actressConditions))
        .limit(10);

      if (matchedActresses.length > 0) {
        const actressIds = matchedActresses.map(a => a.id);
        const vaRecords = await db
          .select()
          .from(videoActresses)
          .where(inArray(videoActresses.actressId, actressIds));

        const actressVideoIds = vaRecords.map(va => va.videoId);
        if (actressVideoIds.length > 0) {
          const actressVideos = await db
            .select()
            .from(videos)
            .where(inArray(videos.id, actressVideoIds))
            .orderBy(desc(videos.views))
            .limit(limit);
          actressVideoResults = actressVideos.map(v => ({ id: v.id, title: v.title, thumbnailUrl: v.thumbnailUrl, category: v.category, rating: v.rating, tags: v.tags }));
        }
      }
    } catch (e) {
      // Actress search failed, continue with title/category results only
    }

    // Merge results, deduplicate by id
    //
    // 合并顺序决定优先级：标题/分类命中的结果排在女优命中的结果之前，
    // 用 Set 记录已出现的 id 保证 filter 只保留首次出现的那条，
    // 因此重复视频会保留「优先级更高」的那一路来源。最后统一截断到 limit。
    const allResults = [...results.map(v => ({ id: v.id, title: v.title, thumbnailUrl: v.thumbnailUrl, category: v.category, rating: v.rating, tags: v.tags })), ...actressVideoResults];
    const seen = new Set<number>();
    const deduplicated = allResults.filter(v => {
      if (seen.has(v.id)) return false;
      seen.add(v.id);
      return true;
    });

    return deduplicated.slice(0, limit);
  } catch (error) {
    console.error("Error getting relevant videos for chat:", error);
    return [];
  }
}

/**
 * Get relevant actresses based on query
 *
 * 为 Chat AI 检索「可提及的候选女优」，与 `getRelevantVideosForChat` 配套使用，
 * 结果同样注入 system prompt，约束 LLM 只谈论库内真实存在的女优。
 *
 * 匹配三个姓名字段 (name / japaneseName / chineseName) 的 LIKE OR 条件；
 * 关键词为空时退化为「按参演作品数 videoCount 取头部女优」。
 *
 * @param query 用户本轮提问文本
 * @param limit 返回条数上限，默认 5
 * @returns 精简后的女优字段数组 (id/name/profileImageUrl/tags)；出错时为空数组
 *
 * 副作用：无 (只读)。
 * 权限：protectedProcedure。
 *
 * 注意：与视频检索不同，本函数没有按热度排序，命中结果的顺序由数据库返回顺序决定。
 */
export async function getRelevantActressesForChat(query: string, limit: number = 5): Promise<Array<{ id: number; name: string; profileImageUrl: string | null; tags: string[] | null }>> {
  const db = await getDb();
  if (!db) return [];

  try {
    const keywords = query.split(/[\s+,、。・\u3000]+/).filter(w => w.length >= 1);
    
    if (keywords.length === 0) {
      // Return popular actresses when no keywords
      const results = await db
        .select()
        .from(actresses)
        .orderBy(desc(actresses.videoCount))
        .limit(limit);
      return results.map(a => ({ id: a.id, name: a.name, profileImageUrl: a.profileImageUrl, tags: a.tags }));
    }

    const conditions = keywords.flatMap(kw => [
      like(actresses.name, `%${kw}%`),
      like(actresses.japaneseName, `%${kw}%`),
      like(actresses.chineseName, `%${kw}%`),
    ]);

    const results = await db
      .select()
      .from(actresses)
      .where(or(...conditions))
      .limit(limit);

    return results.map(a => ({ id: a.id, name: a.name, profileImageUrl: a.profileImageUrl, tags: a.tags }));
  } catch (error) {
    console.error("Error getting relevant actresses for chat:", error);
    return [];
  }
}
