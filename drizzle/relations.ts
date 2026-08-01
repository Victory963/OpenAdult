/**
 * drizzle/relations.ts —— Drizzle ORM 关系定义（架构分层：数据访问层 / schema 定义）
 *
 * ## 角色
 * Drizzle Kit 在 introspect（`drizzle-kit pull`）时会生成 `schema.ts` + `relations.ts`
 * 一对文件：前者描述表结构，后者用 `relations()` 描述表与表之间的关联，供
 * **relational query API**（`db.query.videos.findMany({ with: { actresses: true } })`）
 * 使用。本文件即为那个关系文件。
 *
 * ## 主要导出物
 * **当前为空** —— 文件里只有一条空的 `import {} from "./schema"`，没有导出任何
 * `relations()` 定义。也就是说本项目并未启用 Drizzle 的 relational query API。
 *
 * ## 上下游依赖
 * - 下游：`./schema`（当前 import 列表为空，实际未取用任何符号）。
 * - 上游：**没有任何文件 import 本模块**。`server/db.ts` 里
 *   `drizzle(pool, { schema, mode })` 传入的也只是 `schema.ts`，未传 relations。
 *
 * ## 关键设计决策 / 坑
 * 1. 由于没有 relations 定义，全项目的关联查询一律走**显式 JOIN**（见
 *    `server/search.ts`、`server/routers/videos-v2.ts` 中对 `video_actresses`
 *    的手写 `innerJoin`），而不是 `db.query.*.with`。新增关联查询时请沿用 JOIN 写法，
 *    或先在此文件补齐 `relations()` 并把它一起传给 `drizzle()` 的 `schema` 选项。
 * 2. `import {} from "./schema"` 是一条**副作用导入**（side-effect import）：它不引入
 *    任何绑定，但仍会执行 `schema.ts` 模块体。因为本文件没有被任何地方引用，
 *    实际不会产生影响；属于 drizzle-kit 生成的残留骨架，保留以便将来补充关系定义。
 */
import {} from "./schema";
