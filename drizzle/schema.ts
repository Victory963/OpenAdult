/**
 * drizzle/schema.ts —— 数据库表结构单一事实来源（架构分层：数据访问层 / schema 定义）
 *
 * ## 角色
 * 用 Drizzle ORM 的 `mysqlTable()` DSL 声明 MySQL/TiDB 的全部业务表，并由
 * `$inferSelect` / `$inferInsert` 推导出「查询行类型」与「插入参数类型」。
 * 这里是**类型与表结构的唯一权威**：改了这里 → `pnpm drizzle-kit generate` 生成迁移
 * SQL → 应用到数据库；同时 TS 类型会顺着 tRPC 一路流到前端。
 *
 * ## 主要导出物
 * 表对象（18 张）与对应类型：
 * | 表对象 | 表名 | 用途 |
 * |--------|------|------|
 * | `users`                  | users                  | OAuth 用户账号、角色、语言偏好 |
 * | `videos`                 | videos                 | 视频元数据（标题/时长/URL/分类/评分） |
 * | `actresses`              | actresses              | 女优资料（多语言名字、头像、人脸特征） |
 * | `videoActresses`         | video_actresses        | 视频↔女优 多对多关联表 |
 * | `chatMessages`           | chat_messages          | AI 聊天推荐的对话历史 |
 * | `searchHistory`          | search_history         | 文本/人脸/图像搜索历史 |
 * | `favorites`              | favorites              | 用户收藏 |
 * | `resumePlayback`         | resume_playback        | 续播进度 |
 * | `userPreferences`        | user_preferences       | 推荐用的偏好画像 |
 * | `recommendations`        | recommendations        | AI 生成的推荐结果 |
 * | `userUploads`            | user_uploads           | 用户上传的图片/视频记录 |
 * | `actressFaceEmbeddings`  | actress_face_embeddings| 女优人脸特征向量（相似度检索） |
 * | `faceSearchHistory`      | face_search_history    | 人脸检索历史与命中结果 |
 * | `videoUploadSessions`    | video_upload_sessions  | 分片上传会话（状态机主表） |
 * | `videoUploadChunks`      | video_upload_chunks    | 分片元数据（支持断点续传） |
 * | `ads`                    | ads                    | SSAI 广告素材 |
 * | `adPlacements`           | ad_placements          | 广告投放位（pre/mid/post-roll） |
 * | `adImpressions`          | ad_impressions         | 广告曝光/播放进度/点击埋点 |
 *
 * 另外导出一个手写类型 `UserUploadInput`（向后兼容用，见其自身注释）。
 *
 * ## 上下游依赖
 * - 下游：仅 `drizzle-orm/mysql-core` 的列构造器。
 * - 上游（谁引用它）：
 *   - `server/db.ts` —— 传给 `drizzle(pool, { schema })`，并封装绝大多数查询助手；
 *   - `server/search.ts`（actresses/videos/videoActresses）、
 *     `server/routers/videos-v2.ts`、`server/routers/actressManagement.ts`（人脸向量）、
 *     `server/routers/ad-management.ts`（三张广告表）、
 *     `server/file-upload.ts`（userUploads）、
 *     `server/_core/fastUpload.ts` 与 `server/_core/videoStream.ts`（分片上传两表）；
 *   - `server/_core/context.ts` / `server/_core/sdk.ts` —— 只 `import type { User }`；
 *   - `shared/types.ts` —— `export type *` 把行类型转发给前端；
 *   - `drizzle.config.ts` —— 指向本文件生成迁移。
 *
 * ## 关键设计决策 / 坑
 * 1. **列名不遵循 snake_case**：TS 属性名与实际列名保持一致的 camelCase
 *    （`varchar("thumbnailUrl")` 而非 `thumbnail_url`）。手写原生 SQL 时必须加反引号，
 *    否则在大小写敏感的库上会报列不存在。
 * 2. **几乎没有外键约束**：全库唯一的 FK 是 `video_upload_chunks.sessionId →
 *    video_upload_sessions.id ON DELETE CASCADE`（见 0002 迁移）。`videoActresses`、
 *    `favorites`、`recommendations` 等表的 `userId`/`videoId`/`actressId` 都是裸 int，
 *    引用完整性完全靠应用层保证 —— 删除视频/女优时必须自己清理关联行，否则产生孤儿数据。
 *    这是为兼容 TiDB / 便于水平扩展做的取舍。
 * 3. **没有任何二级索引**：schema 里没有 `index()` / `uniqueIndex()` 调用，迁移 SQL 中
 *    也只有主键和两个 UNIQUE（`users.openId`、`user_preferences.userId`）。
 *    像 `favorites.userId`、`videoActresses.videoId` 这类高频过滤列走的是全表扫描，
 *    数据量上来后需要单独补索引。
 * 4. **`decimal` 列在 drizzle-mysql 中读出来是 `string` 而非 `number`**
 *    （`rating`、`score`、`similarityScore`），前端做数值比较前要先 `parseFloat`。
 * 5. **`timestamp` + `onUpdateNow()`** 依赖 MySQL 的 `ON UPDATE CURRENT_TIMESTAMP`，
 *    只要该行有任何字段被 UPDATE 就会自动刷新，无需应用层显式赋值。
 * 6. `json().$type<T>()` 只是**编译期**断言，数据库不会校验；老数据或手工写入的脏数据
 *    读出来可能并不符合 `T`。
 */
import { int, mysqlEnum, mysqlTable, text, mediumtext, timestamp, varchar, boolean, decimal, json, bigint } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 *
 * `users` —— 用户账号主表，认证链路的核心。
 *
 * 由 Manus OAuth 回调 upsert 写入：`server/_core/oauth.ts` 拿到 openId 后调用
 * `server/db.ts` 的用户助手落库；`server/_core/context.ts` 每次请求用会话 cookie
 * 解析出的 openId 反查本表，把整行放进 tRPC 的 `ctx.user`。
 *
 * 字段说明：
 * - `openId`：Manus OAuth 的全局唯一用户标识，**业务主键**（有 UNIQUE 约束）。
 *   自增 `id` 只作内部外键使用，跨系统对账一律用 openId。长度 64 足够容纳其 ID 格式。
 * - `email`：长度 320 = RFC 5321 规定的邮箱最大长度（local-part 64 + "@" + domain 255）。
 *   可空 —— 部分 OAuth 登录方式（如手机号）拿不到邮箱。
 * - `loginMethod`：登录渠道标记（google / email / 手机等），由 OAuth 上游下发，仅作统计。
 * - `role`：权限级别。`adminProcedure` 中间件校验此列，非 `admin` 抛 `NOT_ADMIN_ERR_MSG`。
 *   默认 `user` —— 新用户不可能自动获得管理权限。注意管理面板还有一套独立的密码认证
 *   （`server/routers/admin-auth.ts` 的 `admin_credentials` 表），与本列**互相独立**。
 * - `language`：界面语言，默认 `ja`（日语，本站主要受众），与前端
 *   `LanguageContext` 的三种取值一一对应。
 * - `updatedAt`：`onUpdateNow()` 由 MySQL 自动维护。
 * - `lastSignedIn`：最近登录时间；**没有** `onUpdateNow()`，需要登录流程显式写入，
 *   否则会一直停留在注册时刻。
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  language: mysqlEnum("language", ["ja", "zh", "en"]).default("ja").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

/** 查询结果行类型（SELECT）。会通过 `ctx.user` 与 `shared/types.ts` 流向前端。 */
export type User = typeof users.$inferSelect;
/** 插入参数类型（INSERT）：带默认值的列（role/language/各时间戳）在此为可选。 */
export type InsertUser = typeof users.$inferInsert;

/**
 * Videos table - stores adult video metadata
 *
 * `videos` —— 视频元数据主表，站内几乎所有页面的数据源。
 *
 * 读取方：`server/routers/videos.ts` / `videos-v2.ts`（列表与详情）、`server/search.ts`
 * （文本搜索 + JOIN video_actresses）、`server/routers/hls-stream.ts`（取 videoUrl 拼
 * HLS manifest）、`server/routers/ad-management.ts`（投放位关联视频）。
 * 写入方：`server/routers/video-upload*.ts` 在分片上传完成后落库。
 *
 * 字段说明：
 * - `duration`：**秒**为单位的整数（不是毫秒），mid-roll 广告的插入点计算依赖它。
 * - `thumbnailUrl` / `videoUrl`：S3 或 CDN 上的地址，512 字符足够容纳带签名参数的
 *   presigned URL 前缀；真正播放时前端还会经过 `client/src/lib/videoUrl.ts` 改写域名
 *   （配合域名轮换反封锁）。
 * - `category`：单值分类字符串，与 `tags` 的多值标签是两套维度，前端筛选各用各的。
 * - `tags`：JSON 数组，`$type<string[]>()` 仅编译期约束；MySQL 层无法索引数组元素，
 *   按标签过滤只能全表扫 + JSON 函数或在 JS 内存中筛。
 * - `views`：累加计数器，非事务安全的 `+1` 更新，高并发下可能少计。
 * - `rating`：`decimal(3,2)` → 取值范围 0.00~9.99，读出来是 **string**（如 `"8.50"`），
 *   前端排序/比较前需 `parseFloat`。
 */
export const videos = mysqlTable("videos", {
  id: int("id").autoincrement().primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  duration: int("duration"), // in seconds
  releaseDate: timestamp("releaseDate"),
  thumbnailUrl: varchar("thumbnailUrl", { length: 512 }),
  videoUrl: varchar("videoUrl", { length: 512 }),
  category: varchar("category", { length: 100 }),
  tags: json("tags").$type<string[]>().default([]),
  views: int("views").default(0),
  rating: decimal("rating", { precision: 3, scale: 2 }).default("0"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** 视频行类型（SELECT）。注意 `rating` 为 `string`、`tags` 为 `string[] | null`。 */
export type Video = typeof videos.$inferSelect;
/** 视频插入类型（INSERT）：仅 `title` 必填，其余列均有默认值或可空。 */
export type InsertVideo = typeof videos.$inferInsert;

/**
 * Actresses table - stores actress/performer information
 *
 * `actresses` —— 女优（演员）资料表，人脸/名称检索的主体。
 *
 * 读取方：`server/routers/faceSearch.ts`（先按名称/特征取候选，再在 JS 内存里算相似度）、
 * `server/search.ts`、`server/routers/actressManagement.ts` 与 `actress-management-v2.ts`。
 *
 * 字段说明：
 * - `name` / `japaneseName` / `chineseName`：同一人的三种写法，用于跨语言搜索命中
 *   （日文艺名、汉字名、罗马字）。只有 `name` 必填。
 * - `faceEmbedding`：**遗留字段**，单条人脸特征的文本表示。新链路改用下方的
 *   `actress_face_embeddings` 表（一个女优可存多张脸）。`server/search.ts` 中有注释指出
 *   生产库可能尚未迁移出该列，读取时需容错。
 * - `videoCount`：冗余计数（反规范化），避免每次列表页都 `COUNT(*)` join
 *   `video_actresses`；代价是新增/删除关联时必须由应用层同步维护，存在漂移风险。
 */
export const actresses = mysqlTable("actresses", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  japaneseName: varchar("japaneseName", { length: 255 }),
  chineseName: varchar("chineseName", { length: 255 }),
  bio: text("bio"),
  birthDate: timestamp("birthDate"),
  profileImageUrl: varchar("profileImageUrl", { length: 512 }),
  faceEmbedding: text("faceEmbedding"), // Store face embedding for recognition
  tags: json("tags").$type<string[]>().default([]),
  videoCount: int("videoCount").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** 女优行类型（SELECT）。 */
export type Actress = typeof actresses.$inferSelect;
/** 女优插入类型（INSERT）：仅 `name` 必填。 */
export type InsertActress = typeof actresses.$inferInsert;

/**
 * Video-Actress relationship table
 *
 * `video_actresses` —— 视频↔女优的**多对多关联表**（junction table）。
 * 一部视频可有多位出演者，一位女优也出演多部视频。
 *
 * 使用方：`server/search.ts` 与 `server/routers/videos-v2.ts` 用它做 `innerJoin`，
 * 实现「按女优筛视频」「按视频列出演员」；`videos-v2.ts` 的更新流程是
 * **先全删该 videoId 的关联行、再批量插入新集合**（见其 "Delete existing relationships"），
 * 因此本表不保证 id 连续。
 *
 * 坑：
 * - 没有 `(videoId, actressId)` 唯一索引，重复插入会产生重复关联行，JOIN 时导致视频重复。
 * - 两列都是裸 int，没有外键；删除视频或女优后残留的行需要应用层自己清理。
 */
export const videoActresses = mysqlTable("video_actresses", {
  id: int("id").autoincrement().primaryKey(),
  videoId: int("videoId").notNull(),
  actressId: int("actressId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 关联行类型（SELECT）。 */
export type VideoActress = typeof videoActresses.$inferSelect;
/** 关联插入类型（INSERT）。 */
export type InsertVideoActress = typeof videoActresses.$inferInsert;

/**
 * Chat messages table - stores conversation history for AI chat
 *
 * `chat_messages` —— AI 聊天推荐（`client/src/pages/ChatPage.tsx` + `AIChatBox.tsx`）的
 * 对话历史。每条消息一行，按 `userId` 分组、按 `createdAt` 排序即为完整会话。
 *
 * 使用方：`server/db.ts` 的聊天助手 → 被 protectedProcedure 的聊天路由调用；
 * 回话时会把历史消息拼成 `messages` 数组喂给 `invokeLLM()`。
 *
 * 字段说明：
 * - `role`：只有 `user` / `assistant` 两种，**没有 `system`** —— system prompt 由
 *   `server/llm-prompts.ts` 在调用时即时拼接，不入库，方便随时改提示词而不影响历史。
 * - `content`：`text` 类型，上限约 64KB；长对话或超长 LLM 回复有被截断的风险。
 *
 * 坑：没有会话（conversation）维度的分组列，同一用户的所有对话是一条时间线，
 * 无法支持「多个独立会话」；也没有 `userId` 索引，历史变长后查询会退化。
 */
export const chatMessages = mysqlTable("chat_messages", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  role: mysqlEnum("role", ["user", "assistant"]).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 聊天消息行类型（SELECT）。 */
export type ChatMessage = typeof chatMessages.$inferSelect;
/** 聊天消息插入类型（INSERT）。 */
export type InsertChatMessage = typeof chatMessages.$inferInsert;

/**
 * Search history table - tracks user searches
 *
 * `search_history` —— 通用搜索历史，用于「最近搜索」回显和推荐画像的行为信号。
 *
 * 写入方：`server/search.ts` 在每次搜索成功后追加一行。
 *
 * 字段说明：
 * - `searchType`：`text`（关键词）/ `face`（上传人脸图）/ `image`（以图搜图）。
 *   注意人脸检索另有一张更详细的 `face_search_history` 表记录命中结果，
 *   本表只记录「发生过一次搜索」这一事实，两者是**并存**关系，不要混用。
 * - `query`：`text` 类型；当 `searchType` 为 face/image 时这里通常存的是图片 URL 或占位串。
 * - `resultsCount`：命中条数，用于分析零结果查询（可反哺补充素材）。
 *
 * 坑：`userId` 为 notNull，因此**匿名用户的搜索无法记录**，只有登录态搜索才会落库。
 */
export const searchHistory = mysqlTable("search_history", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  query: text("query").notNull(),
  searchType: mysqlEnum("searchType", ["text", "face", "image"]).notNull(),
  resultsCount: int("resultsCount").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 搜索历史行类型（SELECT）。 */
export type SearchHistory = typeof searchHistory.$inferSelect;
/** 搜索历史插入类型（INSERT）。 */
export type InsertSearchHistory = typeof searchHistory.$inferInsert;

/**
 * Favorites table - user's favorite videos
 *
 * `favorites` —— 用户收藏（用户↔视频的多对多关联）。
 * 由 protectedProcedure 的收藏接口读写（需登录），也是推荐系统的正向信号来源之一。
 *
 * 坑：**没有 `(userId, videoId)` 唯一索引**，取消收藏靠 DELETE、添加靠 INSERT，
 * 若前端重复点击或并发请求会插入重复行，导致收藏列表出现同一视频多次。
 * 应用层需要先查存在性再插入（存在 check-then-act 竞态）。
 */
export const favorites = mysqlTable("favorites", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  videoId: int("videoId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 收藏行类型（SELECT）。 */
export type Favorite = typeof favorites.$inferSelect;
/** 收藏插入类型（INSERT）。 */
export type InsertFavorite = typeof favorites.$inferInsert;

/**
 * Resume playback table - tracks where user left off in videos
 *
 * `resume_playback` —— 续播进度。播放页定期上报当前播放位置，下次打开同一视频时
 * 从 `position` 秒继续（`client/src/components/VideoPlayer.tsx` 消费）。
 *
 * 字段说明：
 * - `position`：**秒**为单位的已观看位置。
 * - `duration`：写入时的视频总时长快照；冗余存一份是为了在不 JOIN `videos` 的前提下
 *   直接算出进度百分比（`position / duration`），也能在视频被替换后察觉时长不一致。
 * - `lastWatchedAt`：带 `onUpdateNow()`，任意字段更新即自动刷新，用于「继续观看」列表排序。
 *
 * 坑：没有 `(userId, videoId)` 唯一索引，语义上却是「每人每片一行」的 upsert 表；
 * 若应用层没有正确 update 而走了 insert，同一视频会残留多条进度记录。
 */
export const resumePlayback = mysqlTable("resume_playback", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  videoId: int("videoId").notNull(),
  position: int("position").notNull(), // in seconds
  duration: int("duration").notNull(), // total video duration
  lastWatchedAt: timestamp("lastWatchedAt").defaultNow().onUpdateNow().notNull(),
});

/** 续播进度行类型（SELECT）。 */
export type ResumePlayback = typeof resumePlayback.$inferSelect;
/** 续播进度插入类型（INSERT）。 */
export type InsertResumePlayback = typeof resumePlayback.$inferInsert;

/**
 * User preferences table - stores user preferences for recommendations
 *
 * `user_preferences` —— 用户偏好画像，喂给 LLM 推荐和列表排序。
 * `userId` 上有 **UNIQUE 约束**（见 0001 迁移），因此语义为「每用户一行」，
 * 可以安全地做 `ON DUPLICATE KEY UPDATE` 式 upsert —— 这是本 schema 中少数几个
 * 有唯一约束保护的表之一。
 *
 * 字段说明：
 * - `preferredCategories` / `avoidedCategories`：分类名字符串数组，正/负两个方向的信号；
 *   推荐时先按 preferred 加权，再用 avoided 做硬过滤。
 * - `preferredActresses`：女优 **id** 数组（`number[]`，不是名字），需 JOIN `actresses` 展示。
 *
 * 坑：三个 JSON 列都无法建索引，也无法在 SQL 层做「包含某分类的用户」这类反查，
 * 只能全表取出后在 JS 里过滤。
 */
export const userPreferences = mysqlTable("user_preferences", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  preferredCategories: json("preferredCategories").$type<string[]>().default([]),
  preferredActresses: json("preferredActresses").$type<number[]>().default([]),
  avoidedCategories: json("avoidedCategories").$type<string[]>().default([]),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** 偏好画像行类型（SELECT）。 */
export type UserPreferences = typeof userPreferences.$inferSelect;
/** 偏好画像插入类型（INSERT）。 */
export type InsertUserPreferences = typeof userPreferences.$inferInsert;

/**
 * Recommendations table - stores AI-generated recommendations
 *
 * `recommendations` —— LLM 生成的推荐结果落库快照（推荐是异步/离线产出的，
 * 前端读的是本表而不是实时调 LLM，避免每次进首页都产生一次 LLM 调用成本）。
 *
 * 字段说明：
 * - `reason`：推荐理由的自然语言文本，由 LLM 直接输出，用于前端展示「为什么推荐给你」。
 * - `score`：`decimal(5,2)` → 范围 0.00~999.99，读出来是 **string**，排序前需 `parseFloat`。
 *
 * 坑：表里没有「是否已消费 / 过期时间」列，也没有唯一约束，重复生成会不断堆积旧推荐；
 * 清理策略需由应用层（如 `server/_core/heartbeat.ts` 的定时任务）负责。
 */
export const recommendations = mysqlTable("recommendations", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  videoId: int("videoId").notNull(),
  reason: text("reason"), // Why this video was recommended
  score: decimal("score", { precision: 5, scale: 2 }).default("0"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 推荐结果行类型（SELECT）。注意 `score` 为 `string`。 */
export type Recommendation = typeof recommendations.$inferSelect;
/** 推荐结果插入类型（INSERT）。 */
export type InsertRecommendation = typeof recommendations.$inferInsert;

/**
 * User uploads table - stores user-uploaded images/files
 *
 * `user_uploads` —— 用户上传文件（主要是人脸检索用的图片）的登记表。
 * 唯一写入方：`server/file-upload.ts`（文件本体经 `storagePut()` 落 S3，
 * 这里只存元数据与访问地址）。
 *
 * 字段说明：
 * - `fileUrl`：对外可访问的 URL（`text` 类型，因 presigned URL 带签名参数可能很长）。
 * - `s3Key` / `s3Url`：S3 对象键与直链，用于后续删除/重签名；与 `fileUrl` 可能重复，
 *   属于历史演进留下的三个地址列并存。
 * - `metadata`：自由格式的 JSON **字符串**（注意不是 `json()` 列，读出来是 string，
 *   需要自己 `JSON.parse`）。
 * - `expiresAt`：临时文件的过期时间，供清理任务筛选；**数据库不会自动删除**，
 *   需要定时任务扫描后调 S3 删除并清行。
 */
export const userUploads = mysqlTable("user_uploads", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  uploadType: mysqlEnum("uploadType", ["image", "video"]).notNull(),
  fileUrl: text("fileUrl").notNull(),
  metadata: text("metadata"),
  s3Key: varchar("s3Key", { length: 512 }),
  s3Url: varchar("s3Url", { length: 512 }),
  fileSize: int("fileSize"),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 上传记录行类型（SELECT）。 */
export type UserUpload = typeof userUploads.$inferSelect;
/** 上传记录插入类型（INSERT，由 drizzle 推导）。 */
export type InsertUserUpload = typeof userUploads.$inferInsert;

// Alias for backward compatibility
/**
 * `UserUploadInput` —— 上传登记的**手写**入参类型，为向后兼容保留。
 *
 * 与推导出的 `InsertUserUpload` 的区别：这里省略了 `id` / `createdAt`（由数据库生成），
 * 并把可选列显式标成 `?`，因此调用方无需理解 drizzle 的推导规则。
 *
 * 坑：这是**手工维护的副本**，与上面的表定义没有类型上的绑定关系 ——
 * 给 `user_uploads` 增删列时必须记得同步修改此处，否则会静默漂移。
 * 新代码建议直接用 `InsertUserUpload`。
 */
export type UserUploadInput = {
  userId: number;
  uploadType: "image" | "video";
  fileUrl: string;
  metadata?: string;
  s3Key?: string;
  s3Url?: string;
  fileSize?: number;
  expiresAt?: Date;
};

/**
 * Actress face embeddings table - stores face embeddings for similarity search
 *
 * `actress_face_embeddings` —— 女优人脸特征向量表，支撑「上传照片找女优」功能。
 * 一位女优可以有多行（不同角度/年代的照片各存一条），比 `actresses.faceEmbedding`
 * 那个单值遗留列更灵活。
 *
 * 使用方：`server/routers/actressManagement.ts` 写入，`server/routers/faceSearch.ts` 读取。
 *
 * 关键设计：本项目**不用 face-api.js**（Node 端缺 DOM 依赖），而是用 LLM 做图像分析
 * 抽取面部特征描述再转成向量（见 `server/_core/faceRecognition.ts`）。
 *
 * 字段说明：
 * - `embedding`：向量本体，以 **JSON 数组字符串**存进 `text` 列（MySQL/TiDB 无原生
 *   向量类型），读出后 `JSON.parse` 再在 **JS 内存中**逐条算余弦相似度 ——
 *   这是 O(n) 全表扫描，女优规模变大后会成为性能瓶颈，届时需要引入向量数据库。
 * - `embeddingDimension`：向量维度，默认 **128**（沿用 FaceNet/dlib 系人脸特征的经典维度）；
 *   显式存下来是为了在换模型后能区分新旧维度的向量，避免拿不同维度的向量做点积。
 * - `faceImageUrl`：该向量对应的原图，便于人工核对与重新计算。
 *
 * 坑：`actressId` 上**没有唯一索引**（`actressManagement.ts` 中已有注释指出这点），
 * 重复导入同一张脸会产生多条等价向量，从而在相似度排序里让该女优被重复计分。
 */
export const actressFaceEmbeddings = mysqlTable("actress_face_embeddings", {
  id: int("id").autoincrement().primaryKey(),
  actressId: int("actressId").notNull(),
  faceImageUrl: varchar("faceImageUrl", { length: 512 }).notNull(),
  embedding: text("embedding").notNull(), // JSON array of face embedding vector
  embeddingDimension: int("embeddingDimension").default(128), // Dimension of the embedding
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 人脸向量行类型（SELECT）。`embedding` 是 JSON 字符串，需自行 parse。 */
export type ActressFaceEmbedding = typeof actressFaceEmbeddings.$inferSelect;
/** 人脸向量插入类型（INSERT）。 */
export type InsertActressFaceEmbedding = typeof actressFaceEmbeddings.$inferInsert;

/**
 * Face search history table - tracks user face searches
 *
 * `face_search_history` —— 人脸检索的**结果**留档（与 `search_history` 的粗粒度记录并存，
 * 这里额外记录命中了谁、相似度多少），可用于评估检索质量和做「最近识别」回显。
 *
 * 字段说明：
 * - `uploadedImageUrl`：用户上传的查询图地址（通常指向 `user_uploads` 落的 S3 对象）。
 * - `matchedActressIds`：命中的女优 id 列表，同样是 **JSON 数组字符串**存在 `text` 列里
 *   （注意：不是 `json()` 列，读出来要 `JSON.parse`），与 `userPreferences` 用 `json()`
 *   的写法不一致，属于历史遗留的风格分裂。
 * - `topMatchActressId`：Top-1 命中，冗余出来方便直接展示，无需 parse JSON。
 * - `similarityScore`：`decimal(5,4)` → 4 位小数精度，承载 0.0000~1.0000 的归一化余弦相似度；
 *   读出来是 **string**。选 5,4 而非 3,2 是因为人脸相似度阈值判定对小数位敏感
 *   （0.85 与 0.8523 的区分度有意义）。
 */
export const faceSearchHistory = mysqlTable("face_search_history", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  uploadedImageUrl: varchar("uploadedImageUrl", { length: 512 }),
  matchedActressIds: text("matchedActressIds"), // JSON array of matched actress IDs
  topMatchActressId: int("topMatchActressId"), // Top matched actress
  similarityScore: decimal("similarityScore", { precision: 5, scale: 4 }), // Similarity score (0-1)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 人脸检索历史行类型（SELECT）。`similarityScore` 为 `string`。 */
export type FaceSearchHistory = typeof faceSearchHistory.$inferSelect;
/** 人脸检索历史插入类型（INSERT）。 */
export type InsertFaceSearchHistory = typeof faceSearchHistory.$inferInsert;

/**
 * Video upload sessions table - tracks chunked upload progress
 *
 * `video_upload_sessions` —— 视频**分片上传的状态机主表**（大文件断点续传的核心）。
 *
 * 使用方：`server/_core/fastUpload.ts`（二进制分片接收，直接读写本表）、
 * `server/routers/video-upload-v2.ts`（tRPC 侧的会话创建/查询/完成）、
 * `server/_core/videoStream.ts`（按分片拼流回放）。
 *
 * ### 状态转移
 * ```
 *  uploading ──(全部分片收齐)──> processing ──(合并/转码/落 S3 成功)──> completed
 *      │                              │
 *      └──────────(异常/超时)─────────┴────────> failed
 * ```
 * - `uploading`：默认初始态，`uploadedChunks < totalChunks`，允许客户端继续 PUT 分片；
 * - `processing`：分片齐了，后台在做合并/转码，此时不应再接受新分片；
 * - `completed`：`storageKey` 已写入，可据此生成播放地址；
 * - `failed`：终态，需要客户端重新建会话。
 *
 * ### 字段说明
 * - `id`：`varchar(255)` 主键而非自增 int —— 会话 id 由应用层生成（UUID 之类），
 *   这样客户端在**第一个分片上传前**就能拿到 id，且 id 不可枚举（防止遍历他人上传会话）。
 * - `fileSize`：`bigint` 且 `mode: "bigint"`，读出来是 JS 的 **BigInt** 而不是 number；
 *   直接和 number 做算术会抛 TypeError，`JSON.stringify` 也会失败（本项目靠 superjson
 *   序列化才能安全穿过 tRPC）。用 bigint 是为了支持 >2GB（超过 int 上限）的视频文件。
 * - `uploadedChunks`：已收分片计数，用于算进度条；与 `uploadedChunkIds` 冗余，
 *   两者由应用层同时更新，存在不一致风险。
 * - `uploadedChunkIds`：已收分片下标的 JSON 数组字符串。**断点续传的关键**——
 *   客户端重连后据此计算「还差哪几片」，而不是从头再传。
 * - `storageKey`：合并完成后的 S3 对象键；为 null 表示尚未产出最终对象。
 * - `metadata`：`mediumtext`（约 16MB，远大于 `text` 的 64KB）—— 因为里面塞了
 *   **base64 的封面图 `thumbnailData`** 以及 title/description/category/duration，
 *   普通 `text` 装不下，这是选 mediumtext 的直接原因。
 * - `expiresAt`：会话过期时间，用于清理长期未完成的僵尸会话及其 S3 分片碎片；
 *   数据库不会自动删，需定时任务处理。
 */
export const videoUploadSessions = mysqlTable("video_upload_sessions", {
  id: varchar("id", { length: 255 }).primaryKey(),
  userId: int("userId").notNull(),
  fileName: varchar("fileName", { length: 512 }).notNull(),
  fileSize: bigint("fileSize", { mode: "bigint" }).notNull(),
  totalChunks: int("totalChunks").notNull(),
  uploadedChunks: int("uploadedChunks").default(0).notNull(),
  uploadedChunkIds: text("uploadedChunkIds"), // JSON array of uploaded chunk indices
  storageKey: varchar("storageKey", { length: 512 }), // S3 storage key after completion
  status: mysqlEnum("status", ["uploading", "processing", "completed", "failed"]).default("uploading").notNull(),
  metadata: mediumtext("metadata"), // JSON object with title, description, category, duration, thumbnailData
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  expiresAt: timestamp("expiresAt"), // Session expiration time
});

/** 上传会话行类型（SELECT）。注意 `fileSize` 是 **BigInt**。 */
export type VideoUploadSession = typeof videoUploadSessions.$inferSelect;
/** 上传会话插入类型（INSERT）：`id` 必须由调用方显式提供（非自增）。 */
export type InsertVideoUploadSession = typeof videoUploadSessions.$inferInsert;

/**
 * Video upload chunks table - stores chunk metadata for resume capability
 *
 * `video_upload_chunks` —— 每个已上传分片的元数据，是断点续传与按片回放的依据。
 * 与 `video_upload_sessions` 构成一对多。
 *
 * 字段说明：
 * - `sessionId`：**全库唯一的外键**，指向 `video_upload_sessions.id` 且
 *   `ON DELETE CASCADE` —— 删除会话时分片行自动清除（但 **S3 上的分片对象不会**被级联删除，
 *   仍需应用层或清理任务显式删对象，否则产生存储泄漏）。
 * - `chunkIndex`：分片序号（从 0 开始），合并时按此排序拼接，顺序错了文件即损坏。
 * - `chunkSize`：`int` 类型，单片最大约 2GB —— 分片粒度远小于此，不构成限制。
 * - `storageKey`：该分片在 S3 上的对象键。
 * - `checksum`：`varchar(64)`，长度按 **SHA-256 的 64 位十六进制**取；MD5（32 位）也放得下。
 *   用于完整性校验，可空表示未校验。
 *
 * 坑：`(sessionId, chunkIndex)` 上没有唯一索引，同一分片重传会插入重复行，
 * 合并前需要去重（否则会把同一段字节拼两次）。
 */
export const videoUploadChunks = mysqlTable("video_upload_chunks", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: varchar("sessionId", { length: 255 }).notNull().references(() => videoUploadSessions.id, { onDelete: "cascade" }),
  chunkIndex: int("chunkIndex").notNull(),
  chunkSize: int("chunkSize").notNull(),
  storageKey: varchar("storageKey", { length: 512 }).notNull(), // S3 key for this chunk
  checksum: varchar("checksum", { length: 64 }), // MD5/SHA256 for integrity check
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 分片元数据行类型（SELECT）。 */
export type VideoUploadChunk = typeof videoUploadChunks.$inferSelect;
/** 分片元数据插入类型（INSERT）。 */
export type InsertVideoUploadChunk = typeof videoUploadChunks.$inferInsert;


/**
 * Ads table - stores advertisement materials for SSAI
 *
 * `ads` —— SSAI（Server-Side Ad Insertion，服务端广告拼接）的广告**素材**表。
 * 素材在 CDN 层由 OpenResty Lua 脚本拼进 HLS manifest，播放器无法用普通拦截插件屏蔽
 * （这正是选 SSAI 而非客户端广告的原因）。
 *
 * 使用方：`server/routers/ad-management.ts`（admin 权限的 CRUD），
 * `server/routers/hls-stream.ts`（拼接时读取素材与投放位）。
 *
 * 字段说明：
 * - `type`：素材自身标注的适用位置（pre/mid/post-roll）；真正投放到哪里由
 *   `ad_placements.position` 决定，两者**可能不一致**，以 placement 为准。
 * - `videoUrl`：广告视频（MP4）的 S3 地址；SSAI 拼接前需要预先转成与正片同参数的
 *   HLS 切片，否则播放器在切换码流时会卡顿。
 * - `duration`：广告时长（秒），拼接时用来生成 manifest 里的 `#EXTINF` 时长与
 *   计算正片时间轴偏移，**填错会导致进度条错位**。
 * - `priority`：数值越大越优先展示（同一投放位有多条素材时用于挑选）。
 * - `isActive`：软下线开关，下线素材不参与拼接但保留统计数据。
 * - `impressions` / `clicks` / `completions`：反规范化的累计计数，避免每次都对
 *   `ad_impressions` 做 `COUNT(*)`；代价是需要在埋点写入时同步 `+1`，可能与明细表漂移。
 */
export const ads = mysqlTable("ads", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  type: mysqlEnum("type", ["pre-roll", "mid-roll", "post-roll"]).notNull(),
  videoUrl: varchar("videoUrl", { length: 512 }).notNull(), // S3 URL of ad video (MP4)
  thumbnailUrl: varchar("thumbnailUrl", { length: 512 }),
  clickUrl: varchar("clickUrl", { length: 512 }), // Ad click-through URL
  duration: int("duration").notNull(), // Ad duration in seconds
  priority: int("priority").default(0), // Higher = more likely to show
  isActive: boolean("isActive").default(true).notNull(),
  impressions: int("impressions").default(0),
  clicks: int("clicks").default(0),
  completions: int("completions").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** 广告素材行类型（SELECT）。 */
export type Ad = typeof ads.$inferSelect;
/** 广告素材插入类型（INSERT）。 */
export type InsertAd = typeof ads.$inferInsert;

/**
 * Ad placements - defines where ads are inserted in videos
 *
 * `ad_placements` —— 投放规则：把某条 `ads` 素材绑定到「哪些视频的哪个时间点」。
 *
 * 字段说明：
 * - `videoId`：**可空**，`null` 表示「全局投放，适用于所有视频」——
 *   这是本表唯一用 nullable 表达通配语义的地方，查询时必须写成
 *   `videoId = ? OR videoId IS NULL`，漏掉后半段会导致全局广告不生效。
 * - `adId`：指向 `ads.id`（无外键约束）。删除素材时 `ad-management.ts` 会**先删本表引用行
 *   再删素材**，靠代码顺序而非数据库级联维持一致性。
 * - `position`：pre-roll（片头）/ mid-roll（片中）/ post-roll（片尾）。
 * - `insertAtSeconds`：仅 mid-roll 使用 —— 距正片开头的秒数，指定单个插入点。
 * - `midRollInterval`：仅 mid-roll 使用 —— 每 N 秒重复插入一次（例：300 = 每 5 分钟一次）。
 *   与 `insertAtSeconds` 是两种互斥的表达方式，schema 层没有约束二者不能同时填，
 *   拼接逻辑需要自己决定优先级。
 * - `isActive`：投放开关，可在不删规则的前提下暂停。
 */
export const adPlacements = mysqlTable("ad_placements", {
  id: int("id").autoincrement().primaryKey(),
  videoId: int("videoId"), // null = applies to all videos
  adId: int("adId").notNull(),
  position: mysqlEnum("position", ["pre-roll", "mid-roll", "post-roll"]).notNull(),
  insertAtSeconds: int("insertAtSeconds"), // For mid-roll: seconds from start
  midRollInterval: int("midRollInterval"), // For mid-roll: repeat every N seconds (e.g., 300 = every 5 min)
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 投放规则行类型（SELECT）。`videoId` 为 null 表示全局投放。 */
export type AdPlacement = typeof adPlacements.$inferSelect;
/** 投放规则插入类型（INSERT）。 */
export type InsertAdPlacement = typeof adPlacements.$inferInsert;

/**
 * Ad impressions tracking - for analytics
 *
 * `ad_impressions` —— 广告埋点明细表（曝光/播放进度/点击），只追加不更新，
 * 是计费与效果分析的原始数据。`ads` 表上的 impressions/clicks/completions
 * 是它的聚合缓存。
 *
 * 字段说明：
 * - `event`：七种事件，其中 `start` / `firstQuartile`（25%）/ `midpoint`（50%）/
 *   `thirdQuartile`（75%）/ `complete`（100%）这套四分位命名直接对应
 *   **IAB VAST 标准**的 tracking event，便于和第三方广告平台对接。
 *   `impression`（素材被请求/渲染）与 `start`（真正开始播放）语义不同，不要混用。
 * - `videoId` / `userId`：均可空 —— 匿名用户或全局广告位没有对应值，
 *   统计时需注意 `NULL` 不参与 `GROUP BY` 分组计数。
 *
 * 坑：本表是高写入量表且**无任何索引**，长期运行会迅速膨胀并拖慢 `adId` 维度的聚合查询，
 * 需要按时间分区/归档策略配合。
 */
export const adImpressions = mysqlTable("ad_impressions", {
  id: int("id").autoincrement().primaryKey(),
  adId: int("adId").notNull(),
  videoId: int("videoId"),
  userId: int("userId"),
  event: mysqlEnum("event", ["impression", "start", "firstQuartile", "midpoint", "thirdQuartile", "complete", "click"]).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 广告埋点行类型（SELECT）。 */
export type AdImpression = typeof adImpressions.$inferSelect;
/** 广告埋点插入类型（INSERT）。 */
export type InsertAdImpression = typeof adImpressions.$inferInsert;
