/**
 * ============================================================================
 * server/routers/admin-auth.ts — 管理面板独立密码认证（tRPC 路由层）
 * ============================================================================
 *
 * ## 架构定位
 * 属于**路由层**（server/routers/）。在 `server/routers.ts` 中以 `adminAuth`
 * 命名空间注册，前端通过 `trpc.adminAuth.*` 调用。
 *
 * 本文件实现的是 OpenAdult 的**第二套认证体系**（见 CLAUDE.md 设计决策 #4）：
 * - 第一套：Manus OAuth + `session` cookie → `ctx.user` → protectedProcedure/adminProcedure
 * - 第二套（本文件）：用户名 + 密码 → `admin_session_id` cookie → 管理面板专用
 * 两套完全独立、互不影响；管理面板刻意不依赖 OAuth，以便在 OAuth 服务不可用时仍能运维。
 *
 * ## 主要导出
 * - `adminAuthRouter` — 四个 procedure（均为 publicProcedure，鉴权在函数体内做）：
 *   | procedure           | 类型     | 用途 |
 *   |---------------------|----------|------|
 *   | `me`                | query    | 探测当前是否已是管理员（前端路由守卫用） |
 *   | `login`             | mutation | 账号密码登录，成功后种 admin cookie |
 *   | `logout`            | mutation | 清除 admin cookie |
 *   | `changeCredentials` | mutation | 修改管理员用户名/密码（需带当前密码） |
 *
 * ## 上下游依赖
 * - 上游调用方：
 *   - `client/src/pages/AdminLoginPage.tsx`（login）
 *   - `client/src/pages/ActressManagementPage.tsx`、`Home.tsx`（me / logout）
 *   - `client/src/components/AdminCredentialsForm.tsx`（changeCredentials）
 * - 下游依赖：`getDb()`；`getSessionCookieOptions()`（_core/cookies.ts）；`ENV.cookieSecret`
 * - 本文件签发的 token 由 `server/routers/ad-management.ts` 的 `verifyAdminFromCtx()` 校验
 *
 * ## ⚠️ 关键设计决策与坑
 * 1. **admin_credentials 表不在 drizzle/schema.ts 中**：它由 `ensureAdminCredentials()`
 *    在首次登录时用 `CREATE TABLE IF NOT EXISTS` 运行时自建，因此没有类型、没有迁移文件，
 *    也无法用 Drizzle 的查询构造器访问 —— 这正是下面全部走裸 SQL 的原因。
 * 2. **首个管理员账号来自环境变量**：表为空时**只有**在配置了 `ADMIN_INITIAL_PASSWORD`
 *    的前提下才播种（用户名取 `ADMIN_INITIAL_USERNAME`，默认 `admin`）。
 *    未配置则**不播种任何账号**，login 一律返回「凭据错误」。
 *    历史实现曾无条件播种 admin / admin —— 这是公开可知的默认口令，任何人都能在
 *    全新部署的「运维还没来得及改密」窗口期内抢先登录并拿到 30 天 admin cookie，已修复。
 * 3. **裸 SQL 一律参数化**：所有含外部输入的语句都用 Drizzle 的 `sql` 模板标签
 *    （值被编译成 `?` 占位符，由 mysql2 驱动绑定），**不再**用 `sql.raw` 拼字符串。
 *    只有完全静态、不含任何变量的 DDL / COUNT 语句仍走 `sql.raw`。
 *    历史实现曾用 `sql.raw` + 手工把 `'` 替换成 `''` 转义，在 MySQL 默认模式
 *    （未开启 NO_BACKSLASH_ESCAPES）下可被 `\'` 绕过，属于 SQL 注入漏洞，已修复。
 * 4. **密码用 bcrypt (cost=10) 哈希**，数据库中不存明文。
 */

import { router, publicProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb } from "../db";
import { getSessionCookieOptions } from "../_core/cookies";
import { ENV } from "../_core/env";
import { SignJWT, jwtVerify } from "jose";
import { sql } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { parse as parseCookieHeader } from "cookie";

/** 管理员会话 cookie 名（与 ad-management.ts 中的同名常量必须保持一致） */
const ADMIN_COOKIE_NAME = "admin_session_id";
/** JWT issuer 声明；签发与校验两侧都会带上，用于隔离本系统的 token */
const ADMIN_JWT_ISSUER = "openadult-admin";

/**
 * 派生管理员 JWT 的 HMAC-SHA256 密钥。
 *
 * 在 `ENV.cookieSecret` 后追加 `"_admin"` 做域分离：
 * 管理员 token 与普通用户会话 token 的密钥不同，拿到一种也无法伪造另一种。
 * 副作用：一旦轮换 `ENV.cookieSecret`（JWT_SECRET），所有管理员会话会立即失效，需要重新登录。
 */
function getAdminJwtSecret() {
  return new TextEncoder().encode(ENV.cookieSecret + "_admin");
}

/**
 * 签发管理员 JWT。
 *
 * payload 仅含 `{ username, isAdmin: true }` —— 刻意不放密码哈希等敏感信息，
 * 因为 JWT payload 只是 base64 编码（非加密），任何人都能解开看。
 *
 * @param username 管理员用户名，写入 payload 供 changeCredentials 定位记录
 * @returns 已签名的 JWT 字符串，有效期 30 天
 * @remarks 无「服务端吊销」机制：改密码后旧 token 在过期前依然有效
 *          （changeCredentials 只是给当前浏览器换发新 token，并不会踢掉其他设备）
 */
async function signAdminToken(username: string): Promise<string> {
  const secret = getAdminJwtSecret();
  return new SignJWT({ username, isAdmin: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ADMIN_JWT_ISSUER)
    .setExpirationTime("30d")
    .sign(secret);
}

/**
 * 校验管理员 JWT 并取出身份信息。
 *
 * `jwtVerify` 一次性校验：HMAC 签名、issuer 是否为 `openadult-admin`、exp 是否过期。
 * 任一不通过都走 catch 分支统一返回 null（不区分失败原因，避免向调用方泄漏细节）。
 *
 * @param token cookie 中取出的 JWT 字符串
 * @returns `{ username, isAdmin: true }`；校验失败返回 `null`
 * @remarks 返回值中的 `isAdmin` 是硬编码 true，而非读自 payload——
 *          因为只要签名校验通过就必然是本系统签发的管理员 token。
 */
async function verifyAdminToken(
  token: string
): Promise<{ username: string; isAdmin: boolean } | null> {
  try {
    const secret = getAdminJwtSecret();
    const { payload } = await jwtVerify(token, secret, {
      issuer: ADMIN_JWT_ISSUER,
    });
    return { username: payload.username as string, isAdmin: true };
  } catch {
    return null;
  }
}

/**
 * 从请求头中提取管理员 token。
 *
 * @param req 只需具备 `headers.cookie` 的对象（宽松结构类型，便于测试时传 mock）
 * @returns `admin_session_id` 的值；不存在时为 `undefined`
 */
function getAdminCookie(req: { headers: { cookie?: string } }): string | undefined {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  return cookies[ADMIN_COOKIE_NAME];
}

/**
 * 幂等地确保 `admin_credentials` 表存在；仅在**显式配置了初始口令**时播种首个管理员账号。
 *
 * 这张表**没有**定义在 `drizzle/schema.ts` 里，也没有对应的迁移文件，
 * 而是在每次 `login` 前用 `CREATE TABLE IF NOT EXISTS` 惰性自建。
 * 这样做的好处是部署时无需额外迁移步骤；代价是它游离于 schema 之外，
 * 只能用裸 SQL（参数化的 `sql` 模板标签）访问，且 `pnpm db:push` 不会管理它。
 *
 * 播种逻辑（表内行数为 0 时）：
 * - `ADMIN_INITIAL_PASSWORD` **未配置或为空** → **不插入任何账号**，仅打一条 error 日志。
 *   此时 login 查不到行，统一返回「IDまたはパスワードが正しくありません」，
 *   管理面板处于「无账号 = 无法登录」的安全默认态（fail-closed）。
 * - 已配置 → 用户名取 `ADMIN_INITIAL_USERNAME`（缺省 `admin`），
 *   口令经 bcrypt cost=10 哈希后写入，并打日志提醒尽快通过 `changeCredentials` 改密。
 *
 * @sideEffect 可能执行 DDL（建表）与 DML（插入初始账号）
 * @remarks
 * - ⚠️ **安全**（修复要点）：历史实现无条件播种硬编码的 admin / admin。由于本函数在
 *   每次 login 前无条件执行，全新部署时攻击者只需抢先调用一次
 *   `login {username:"admin", password:"admin"}`，即可在同一次调用里触发播种并登录成功，
 *   拿到 30 天有效的 `admin_session_id`（该 cookie 同时被 ad-management / actressManagement /
 *   _core/fastUpload 认可，等于全站 CRUD + 上传通道沦陷）。现改为必须显式配置初始口令。
 * - 本文件按项目约定本应从 `_core/env.ts` 的 `ENV` 读配置，但此处直接读 `process.env`：
 *   `ENV` 是模块加载期的快照且不含这两个键，而本轮修复限定只改本文件；
 *   同样的直读方式在 `_core/hlsRoutes.ts`（`ADMIN_API_KEY`）中已有先例。
 * - 整个函数用 try/catch 吞掉所有异常并只打 console.error —— 建表失败时不会阻断流程，
 *   而是让后续的 SELECT 抛错，报错信息会比较费解。
 * - 每次 login 都会跑一遍建表 + COUNT，属于可优化的额外开销（可加进程内标志位缓存）。
 */
async function ensureAdminCredentials() {
  const db = await getDb();
  if (!db) return;
  try {
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS admin_credentials (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        passwordHash VARCHAR(255) NOT NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `));
    const rows = await db.execute(
      sql.raw("SELECT COUNT(*) as cnt FROM admin_credentials")
    );
    // mysql2 的 execute 返回 [rows, fields]，故双层下标 [0][0] 才是第一行数据。
    // 这个取值形状在本文件的每处查询中都重复出现。
    const cnt = (rows as any)[0]?.[0]?.cnt ?? 0;
    if (Number(cnt) === 0) {
      // 修复：硬编码默认凭据 admin/admin —— 初始口令改为必须由部署方通过
      // ADMIN_INITIAL_PASSWORD 显式提供；未提供则**不播种任何账号**（fail-closed），
      // 避免全新部署存在「公开可知的默认口令」窗口期。
      const initialPassword = process.env.ADMIN_INITIAL_PASSWORD ?? "";
      if (initialPassword.length === 0) {
        console.error(
          "[AdminAuth] admin_credentials is empty and ADMIN_INITIAL_PASSWORD is not set — " +
            "refusing to seed a default account. Admin login stays disabled until you set " +
            "ADMIN_INITIAL_PASSWORD (or insert a bcrypt-hashed row yourself)."
        );
        return;
      }
      const initialUsername = (process.env.ADMIN_INITIAL_USERNAME ?? "admin").trim() || "admin";
      // bcrypt cost factor = 10：约 2^10 轮加盐迭代，是 bcrypt 的通用默认值，
      // 在「单次哈希约 50~100ms」与「抗暴力破解」之间取平衡。
      const hashed = await bcrypt.hash(initialPassword, 10);
      // 修复：SQL 注入 —— 改用参数化的 `sql` 模板标签（值编译为 `?` 由驱动绑定），
      // 不再用 sql.raw 拼接 + 手工 `'`→`''` 转义。用户名同样走占位符。
      await db.execute(
        sql`INSERT INTO admin_credentials (username, passwordHash) VALUES (${initialUsername}, ${hashed})`
      );
      console.warn(
        `[AdminAuth] Seeded initial admin account "${initialUsername}" from ADMIN_INITIAL_PASSWORD. ` +
          "Change it via adminAuth.changeCredentials and remove the env var afterwards."
      );
    }
  } catch (e) {
    console.error("[AdminAuth] ensureAdminCredentials error:", e);
  }
}

export const adminAuthRouter = router({
  // Check current admin session
  /**
   * 【public / query】探测当前请求是否携带有效的管理员会话。
   *
   * 前端用它做路由守卫：`ActressManagementPage` / `Home` 在渲染管理入口前先查这个，
   * 未登录则跳转 `AdminLoginPage`。
   *
   * @returns `{ isAdmin: true, username }` 或 `{ isAdmin: false, username: null }`
   * @sideEffect 无（纯校验，不读库、不写 cookie）
   * @remarks 刻意**不抛错**：无会话是正常状态而非异常，抛 UNAUTHORIZED 会让前端
   *          react-query 反复重试并在控制台刷红。
   */
  me: publicProcedure.query(async ({ ctx }) => {
    const token = getAdminCookie(ctx.req);
    if (!token) return { isAdmin: false, username: null };
    const payload = await verifyAdminToken(token);
    if (!payload) return { isAdmin: false, username: null };
    return { isAdmin: true, username: payload.username };
  }),

  // Admin login with username/password
  /**
   * 【public / mutation】管理员账号密码登录。
   *
   * 流程：确保表存在（并在配置了 `ADMIN_INITIAL_PASSWORD` 时播种首个账号）→
   * 按用户名查出 passwordHash → bcrypt 比对 → 签发 30 天 JWT → 写入 HttpOnly cookie。
   *
   * @param input.username 用户名
   * @param input.password 明文密码（依赖 HTTPS 传输保护；服务端不落库、不打日志）
   * @returns `{ success: true, username }`
   *
   * @sideEffect 可能建表/播种初始账号（仅当配置了 `ADMIN_INITIAL_PASSWORD`）；
   *             读库 1 次；在响应上设置 `admin_session_id` cookie
   * @throws TRPCError INTERNAL_SERVER_ERROR — DB 不可用
   * @throws TRPCError UNAUTHORIZED — 用户名不存在或密码错误
   *
   * @remarks
   * - 用户名不存在与密码错误返回**同一条**错误文案（"IDまたはパスワードが正しくありません"），
   *   避免通过错误信息枚举出有效用户名。
   *   但两条分支的耗时不同（前者不跑 bcrypt），理论上存在时序侧信道。
   * - ⚠️ 无登录失败次数限制 / 无验证码 / 无锁定，可被在线暴力破解。
   * - 表为空且未配置 `ADMIN_INITIAL_PASSWORD` 时，任何用户名/密码组合都会命中
   *   「用户不存在」分支并返回凭据错误 —— 这是刻意的 fail-closed 行为（见
   *   `ensureAdminCredentials`），排查时请先看服务端 `[AdminAuth]` 日志。
   * - 用户名以参数化占位符传入（`sql` 模板标签），不参与 SQL 文本拼接，无注入风险。
   */
  login: publicProcedure
    .input(
      z.object({
        username: z.string().min(1),
        password: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await ensureAdminCredentials();
      const db = await getDb();
      if (!db)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "データベースに接続できません" });

      // 因 admin_credentials 不在 Drizzle schema 中，只能走裸 SQL；
      // 修复：SQL 注入 —— 用 `sql` 模板标签而非 sql.raw，用户名被编译成 `?` 占位符
      // 由 mysql2 驱动绑定，彻底摆脱手工转义（原先的 `'`→`''` 可被 `\'` 绕过）。
      const rows = await db.execute(
        sql`SELECT id, username, passwordHash FROM admin_credentials WHERE username = ${input.username} LIMIT 1`
      );
      const row = (rows as any)[0]?.[0] ?? null;
      // 用户不存在、或该行没有密码哈希（脏数据），都走同一条「凭据错误」分支
      if (!row || !row.passwordHash) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "IDまたはパスワードが正しくありません" });
      }
      const valid = await bcrypt.compare(input.password, row.passwordHash);
      if (!valid) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "IDまたはパスワードが正しくありません" });
      }
      const adminToken = await signAdminToken(input.username);
      // 复用框架统一的 cookie 策略（httpOnly / secure / sameSite / domain 由
      // _core/cookies.ts 依据请求来源推导），仅覆盖 maxAge 使其与 JWT 的 30d 有效期对齐。
      // 30 * 24 * 60 * 60 * 1000 = 30 天（毫秒）；注意 Express 的 maxAge 单位是毫秒，
      // 而 JWT 的 setExpirationTime("30d") 用的是时长字符串，两者需人工保持一致。
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(ADMIN_COOKIE_NAME, adminToken, {
        ...cookieOptions,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });
      return { success: true, username: input.username };
    }),

  // Admin logout
  /**
   * 【public / mutation】退出管理员登录 —— 清除 `admin_session_id` cookie。
   *
   * @returns `{ success: true }`（无条件成功，未登录时调用也不报错）
   * @sideEffect 在响应上清除 cookie
   * @remarks
   * - 传入的 cookieOptions 必须与设置时**完全一致**（尤其 path / domain），
   *   否则浏览器会认为是另一个 cookie 而删除失败。`maxAge: -1` 是让其立即过期的写法。
   * - 这是**纯客户端登出**：JWT 本身仍然有效，服务端没有黑名单。
   *   若 token 已泄漏，清 cookie 并不能阻止攻击者继续使用它，只能靠轮换 JWT_SECRET。
   */
  logout: publicProcedure.mutation(({ ctx }) => {
    const cookieOptions = getSessionCookieOptions(ctx.req);
    ctx.res.clearCookie(ADMIN_COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    return { success: true };
  }),

  // Change admin credentials
  /**
   * 【public + 内部鉴权 / mutation】修改管理员用户名与密码。
   *
   * 双重校验：
   *   1. 必须携带有效的 admin JWT（证明「当前已登录」）
   *   2. 必须提供正确的 currentPassword（证明「本人在操作」，防 XSS/CSRF 盗用会话直接改密）
   *
   * @param input.currentPassword 当前密码，用于二次确认
   * @param input.newUsername     可选的新用户名；省略或全空白则沿用 token 中的旧用户名
   * @param input.newPassword     新密码，**至少 6 位**（zod 层强制，唯一的密码强度要求）
   * @returns `{ success: true, username }`，username 为生效后的用户名
   *
   * @sideEffect 读库 1 次、更新 `admin_credentials` 1 行；重新签发 JWT 并覆写 cookie
   * @throws TRPCError UNAUTHORIZED — 未登录 / 会话无效 / 当前密码错误
   * @throws TRPCError INTERNAL_SERVER_ERROR — DB 不可用
   * @throws TRPCError NOT_FOUND — token 里的用户名在库中已不存在
   *
   * @remarks
   * - 改完立即换发新 token 并覆盖 cookie：因为 JWT payload 里带着 username，
   *   改名后不换发的话，旧 token 会指向一个已不存在的用户名，导致下次操作报 NOT_FOUND。
   * - 定位记录用的是 token 中的 username，而非客户端传参，避免越权修改他人账号。
   * - 新用户名/新哈希同样以参数化占位符写入（`sql` 模板标签），不参与 SQL 文本拼接。
   * - ⚠️ 未校验新用户名是否与现有账号冲突；表上 username 有 UNIQUE 约束，
   *   撞名时会抛出原始 MySQL 错误而非友好提示。
   */
  changeCredentials: publicProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newUsername: z.string().min(1).optional(),
        newPassword: z.string().min(6),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const token = getAdminCookie(ctx.req);
      if (!token)
        throw new TRPCError({ code: "UNAUTHORIZED", message: "管理者としてログインしていません" });
      const payload = await verifyAdminToken(token);
      if (!payload)
        throw new TRPCError({ code: "UNAUTHORIZED", message: "セッションが無効です" });

      const db = await getDb();
      if (!db)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "データベースに接続できません" });

      // 用 token 里的 username（而非客户端入参）定位记录，杜绝改他人凭据
      // 修复：SQL 注入 —— 参数化占位符替代 sql.raw 字符串拼接
      const rows = await db.execute(
        sql`SELECT id, username, passwordHash FROM admin_credentials WHERE username = ${payload.username} LIMIT 1`
      );
      const row = (rows as any)[0]?.[0] ?? null;
      if (!row || !row.passwordHash)
        throw new TRPCError({ code: "NOT_FOUND", message: "管理者情報が見つかりません" });

      const valid = await bcrypt.compare(input.currentPassword, row.passwordHash);
      if (!valid)
        throw new TRPCError({ code: "UNAUTHORIZED", message: "現在のパスワードが正しくありません" });

      // `?.trim() || payload.username`：未传、传空串、传纯空白都退回旧用户名，
      // 避免把管理员账号改成空名而彻底锁死后台。
      const newUsername = input.newUsername?.trim() || payload.username;
      const newHash = await bcrypt.hash(input.newPassword, 10); // cost=10，与播种时保持一致

      // 用主键 id 定位（而非 username），保证即使改名也精确命中同一行
      // 修复：SQL 注入 —— newUsername 完全由调用方控制，这里是注入面最大的一处；
      // 改为参数化占位符后，任何引号/反斜杠都只会被当作普通字符存入。
      await db.execute(
        sql`UPDATE admin_credentials SET username = ${newUsername}, passwordHash = ${newHash} WHERE id = ${row.id}`
      );

      // 换发 token：旧 token 的 payload.username 可能已过期（改名场景），
      // 不换发会导致本次会话后续操作找不到账号。
      const newToken = await signAdminToken(newUsername);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(ADMIN_COOKIE_NAME, newToken, {
        ...cookieOptions,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天（毫秒），与 login 处及 JWT 有效期保持一致
      });
      return { success: true, username: newUsername };
    }),
});
