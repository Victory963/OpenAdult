/**
 * ============================================================================
 * server/_core/heartbeat.ts — 定时任务（cron）管理 SDK
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 外部服务适配层**。
 * 封装 Manus Heartbeat 服务的四个 RPC（Create / Update / Delete / List），
 * 用于**注册托管在平台侧的 cron 任务**。
 *
 * ## 工作模型（关键，先理解这个再看代码）
 * 定时器**不跑在本进程里**。本模块只是向平台注册一条"到点请回调我"的规则；
 * 到时间后，平台会主动向本站发起 HTTP 请求，打到 `/api/scheduled/**` 路径上。
 * 因此：
 * - 回调路径被强制要求以 `/api/scheduled/` 开头（见 `validateCallbackPath`）；
 * - 业务侧需要自行实现对应的 Express 路由来接收回调；
 * - 多实例部署时不会出现"每个实例各跑一份定时器"的重复执行问题。
 * 详见 `references/periodic-updates.md`。
 *
 * ## 主要导出
 * - `createHeartbeatJob(job, userSession)` —— 创建，返回 `taskUid`（**必须持久化**）。
 * - `updateHeartbeatJob(taskUid, patch, userSession)` —— 局部更新 / 暂停恢复。
 * - `deleteHeartbeatJob(taskUid, userSession)` —— 删除。
 * - `listHeartbeatJobs(userSession, pagination?)` —— 分页列出当前身份的任务。
 * - 类型：`HeartbeatJob` / `HeartbeatJobUpdate` / `HeartbeatJobInfo`。
 *
 * ## 上下游依赖
 * - 上游调用方：当前代码库中**暂无业务调用**（Manus 模板预置能力）。
 * - 下游依赖：`./env` 的 `ENV.forgeApiUrl` / `ENV.forgeApiKey`；
 *   `@trpc/server` 的 `TRPCError`（错误直接以 tRPC 错误码形式抛出）。
 *
 * ## 关键设计决策与坑
 * 1. **`userSession` 决定"任务属于谁"**：传入解码后的 `app_session_id` cookie 值
 *    → 任务归属该终端用户；传空串 → 归属项目所有者。这个身份同时决定了
 *    `listHeartbeatJobs` 能看到哪些任务。
 * 2. **`taskUid` 是唯一句柄**：创建后必须存到业务表里，否则再也无法定位该任务
 *    去更新/删除（`name` 只是 (project, owner) 维度的展示名，不能用于寻址）。
 * 3. **错误统一转成 `TRPCError`**（见 `mapForgeError`），与 `llm.ts` 抛原生 Error
 *    的风格不同 —— 这样可以把上游的 401/404/429 语义原样透给前端。
 * 4. **无重试**。
 */
import { TRPCError } from "@trpc/server";
import { ENV } from "./env";

/**
 * 创建 cron 任务的入参。
 *
 * @property name        任务名。作为 (project, owner) 作用域内的**逻辑主键**，创建后不可修改。
 * @property cron        6 段式 cron 表达式（含秒），UTC 时区，最小间隔 60s。
 * @property path        回调路径，必须以 `/api/scheduled/` 开头。
 * @property method      回调 HTTP 方法，默认 POST。
 * @property payload     回调时随请求体发送的数据，会被序列化成字符串（见 `stringifyPayload`）。
 * @property description 备注说明，默认空串。
 */
export type HeartbeatJob = {
  name: string;
  /**
   * 6-field cron with seconds (`sec min hour dom mon dow`), UTC, min interval 60s.
   * Use `0` for the seconds field — e.g. `"0 0 9 * * *"` is daily 09:00 UTC.
   * See periodic-updates.md.
   */
  cron: string;
  /** Callback path. MUST start with `/api/scheduled/`. */
  path: string;
  method?: "POST" | "PUT";
  payload?: unknown;
  description?: string;
};

/**
 * Update patch. All fields optional; unset = leave unchanged.
 * `enable`: true = resume, false = pause; omit = unchanged.
 * `name` is the (project, owner)-scope key and cannot be changed.
 */
export type HeartbeatJobUpdate = Partial<Omit<HeartbeatJob, "name">> & {
  enable?: boolean;
};

/**
 * `listHeartbeatJobs` 返回的任务详情（上游原始字段，命名与本地 `HeartbeatJob` 不同）。
 *
 * 字段对应关系：`cronExpression` ↔ `HeartbeatJob.cron`、`callbackPath` ↔ `.path`、
 * `callbackMethod` ↔ `.method`、`callbackPayload` ↔ `.payload`（**字符串形式**，
 * 需自行 JSON.parse）。
 *
 * @property taskUid         任务唯一句柄，更新/删除时使用
 * @property userId          任务归属的用户 ID
 * @property isEnable        当前是否启用（false = 已暂停）
 * @property lastExecutedAt  上次执行时间；从未执行过为 null
 * @property nextExecutionAt 下次预计执行时间；已暂停时可能为 null
 */
export type HeartbeatJobInfo = {
  taskUid: string;
  name: string;
  userId: string;
  description: string;
  cronExpression: string;
  callbackPath: string;
  callbackMethod: string;
  callbackPayload: string;
  isEnable: boolean;
  createdAt?: string | null;
  lastExecutedAt?: string | null;
  nextExecutionAt?: string | null;
};

/** Connect RPC 服务名，与 `notification.ts` / `dataApi.ts` 共用同一个 WebDevService。 */
const SERVICE = "webdevtoken.v1.WebDevService";

/**
 * 拼接指定 RPC 的完整端点地址，并顺带做配置前置校验。
 *
 * 把「配置校验」放在 URL 构造里，是为了让四个导出函数都自动获得这层保护，
 * 无需各自重复检查。
 *
 * @param rpc RPC 方法名，如 `"CreateHeartbeatJob"`
 * @throws TRPCError(INTERNAL_SERVER_ERROR) 当 forge URL 或 API Key 未配置时
 */
const buildEndpoint = (rpc: string): string => {
  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Heartbeat service URL is not configured (BUILT_IN_FORGE_API_URL).",
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Heartbeat service API key is not configured (BUILT_IN_FORGE_API_KEY).",
    });
  }
  // 补齐末尾斜杠：`new URL(relative, base)` 在 base 不以 "/" 结尾时会替换掉
  // base 的最后一段路径，导致端点拼错。
  const baseUrl = ENV.forgeApiUrl;
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`${SERVICE}/${rpc}`, normalizedBase).toString();
};

/**
 * 四个导出函数共用的 RPC 发送器。
 *
 * 职责：拼端点 → 组装鉴权与身份头 → POST → 状态码映射 → 反序列化。
 *
 * @typeParam T 期望的响应体类型（调用方指定，运行时不校验）
 * @param rpc         RPC 方法名
 * @param body        请求体（Connect RPC 一律用 POST + JSON）
 * @param userSession 见文件头「关键设计决策」第 1 条
 * @throws TRPCError 网络异常 → INTERNAL_SERVER_ERROR；非 2xx → 见 `mapForgeError`
 */
const callForge = async <T>(
  rpc: string,
  body: Record<string, unknown>,
  userSession: string
): Promise<T> => {
  const endpoint = buildEndpoint(rpc);
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${ENV.forgeApiKey}`,
    "content-type": "application/json",
    "connect-protocol-version": "1",
  };
  // userSession is the decoded `app_session_id` cookie value (NOT the raw
  // Cookie header). Empty string falls back to the project owner identity.
  // 身份切换开关：带上这个头 = 以终端用户身份操作（任务归该用户所有）；
  // 不带 = 以项目所有者身份操作。传值必须是**解码后的 app_session_id cookie 值**，
  // 不能把整个 `Cookie:` 请求头原样塞进来。空串走 falsy 分支，等同于不带。
  if (userSession) {
    headers["x-manus-user-session"] = userSession;
  }

  // 只把 fetch 本身包进 try：这里捕获的是**网络层**失败（DNS/连接/超时），
  // 需要转成 TRPCError；而 HTTP 层的非 2xx 由下面的 `response.ok` 分支单独处理，
  // 两者的错误码映射规则不同，故不合并。
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Heartbeat ${rpc} network error: ${String(error)}`,
    });
  }

  if (!response.ok) {
    // `.catch(() => "")`：读响应体本身也可能失败，此时降级为空 detail，
    // 保证抛出的仍是那条带状态码的可读错误。
    const detail = await response.text().catch(() => "");
    throw mapForgeError(response, detail, rpc);
  }
  // 乐观断言，不做运行时结构校验。
  return (await response.json()) as T;
};

/**
 * 把上游 HTTP 状态码翻译成对应的 tRPC 错误码，使前端能按语义分支处理
 * （例如 429 提示"操作过于频繁"、404 提示"任务不存在"），而不是一律看到 500。
 *
 * 未覆盖的状态码（如 500/502/503）统一落到 INTERNAL_SERVER_ERROR。
 *
 * @returns 构造好的 TRPCError（**返回而非抛出**，由调用方 throw）
 */
const mapForgeError = (
  response: Response,
  detail: string,
  rpc: string
): TRPCError => {
  const status = response.status;
  let code: TRPCError["code"] = "INTERNAL_SERVER_ERROR";
  if (status === 401) code = "UNAUTHORIZED";
  else if (status === 403) code = "FORBIDDEN";
  else if (status === 404) code = "NOT_FOUND";
  else if (status === 400 || status === 422) code = "BAD_REQUEST";
  else if (status === 409) code = "CONFLICT";
  else if (status === 429) code = "TOO_MANY_REQUESTS";
  return new TRPCError({
    code,
    message: `Heartbeat ${rpc} failed (${status})${detail ? `: ${detail}` : ""}`,
  });
};

/**
 * 把回调 payload 规范化为字符串（上游 `callbackPayload` 字段要求字符串类型）。
 *
 * 三条分支的取舍：
 * - null/undefined → `"{}"`，保证回调时业务侧总能安全 JSON.parse 出一个对象；
 * - 已是字符串     → **原样返回不再包一层**，允许调用方传入自己拼好的 JSON
 *   （若传的是非 JSON 纯文本，业务侧解析会失败，属调用方自负）；
 * - 其他           → JSON.stringify。
 */
const stringifyPayload = (payload: unknown): string => {
  if (payload === undefined || payload === null) return "{}";
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
};

/**
 * 强制回调路径落在 `/api/scheduled/` 命名空间下。
 *
 * 这不是风格约束而是安全边界：平台会以外部身份主动请求该路径，限定前缀可以确保
 * 定时回调只能命中专门为其开设的、有独立校验逻辑的路由，无法被用来触发任意
 * 内部接口（例如把回调指向 `/api/trpc/...` 越权调用业务 procedure）。
 *
 * @throws TRPCError(BAD_REQUEST) 路径为空或前缀不符时
 */
const validateCallbackPath = (path: string): void => {
  if (!path || !path.startsWith("/api/scheduled/")) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "callback path must start with /api/scheduled/",
    });
  }
};

/**
 * Create a new HTTP cron job. Returns the assigned `taskUid` to persist on
 * your business row so callbacks can dereference it.
 *
 * 创建一个由平台托管的 cron 任务。
 *
 * 权限级别：无（内部工具函数）；实际操作身份由 `userSession` 决定。
 *
 * 副作用：一次出网 RPC；在平台侧**创建持久化的定时任务**（不会自动清理，
 * 需显式 delete）。本地不写库 —— `taskUid` 由调用方负责落库。
 *
 * @param job         见 `HeartbeatJob`；`method` 默认 POST，`description` 默认空串
 * @param userSession 终端用户 session（空串 = 项目所有者身份）
 * @returns `{ taskUid, nextExecutionAt }`。**`taskUid` 必须持久化到业务表**，
 *          它是后续 update/delete 的唯一寻址方式，丢了就只能靠 list 找回
 * @throws TRPCError(BAD_REQUEST) 回调路径前缀非法；其余见 `callForge` / `mapForgeError`
 */
export async function createHeartbeatJob(
  job: HeartbeatJob,
  userSession: string
): Promise<{ taskUid: string; nextExecutionAt?: string | null }> {
  validateCallbackPath(job.path);
  return callForge<{ taskUid: string; nextExecutionAt?: string | null }>(
    "CreateHeartbeatJob",
    {
      name: job.name,
      cronExpression: job.cron,
      callbackPath: job.path,
      callbackMethod: job.method ?? "POST",
      callbackPayload: stringifyPayload(job.payload),
      description: job.description ?? "",
    },
    userSession
  );
}

/**
 * Update an existing cron located by `taskUid`. Only fields you pass in
 * `patch` are mutated. `enable` flips resume/pause; omit to leave alone.
 *
 * 局部更新一个已存在的 cron 任务。
 *
 * 权限级别：无（内部工具函数）；操作身份由 `userSession` 决定，只能改自己名下的任务。
 *
 * 副作用：一次出网 RPC，修改平台侧任务配置。
 *
 * @param taskUid     创建时返回并落库的任务句柄
 * @param patch       局部补丁，见 `HeartbeatJobUpdate`。**`undefined` = 不修改**，
 *                    因此无法用本接口把某字段清空为 null
 * @param userSession 终端用户 session（空串 = 项目所有者身份）
 * @returns `{ nextExecutionAt }` 更新后的下次执行时间
 * @throws TRPCError(BAD_REQUEST) 新回调路径前缀非法；
 *         TRPCError(NOT_FOUND) taskUid 不存在或不属于当前身份
 */
export async function updateHeartbeatJob(
  taskUid: string,
  patch: HeartbeatJobUpdate,
  userSession: string
): Promise<{ nextExecutionAt?: string | null }> {
  if (patch.path !== undefined) validateCallbackPath(patch.path);
  // 逐字段 `!== undefined` 判断而非直接展开：目的是实现真正的 PATCH 语义 ——
  // 只把调用方显式给出的字段写进请求体，未提及的字段在上游保持原值。
  // 若直接 `{...patch}`，undefined 会被 JSON.stringify 丢弃，结果虽相同但
  // 无法区分"没传"和"传了 undefined"，且字段名也需要从 cron→cronExpression 等重映射。
  const body: Record<string, unknown> = { taskUid };
  if (patch.cron !== undefined) body.cronExpression = patch.cron;
  if (patch.path !== undefined) body.callbackPath = patch.path;
  if (patch.method !== undefined) body.callbackMethod = patch.method;
  if (patch.payload !== undefined) {
    body.callbackPayload = stringifyPayload(patch.payload);
  }
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.enable !== undefined) body.enable = patch.enable;
  return callForge<{ nextExecutionAt?: string | null }>(
    "UpdateHeartbeatJob",
    body,
    userSession
  );
}

/**
 * Delete a cron located by `taskUid`. Idempotent on caller side.
 *
 * 删除一个 cron 任务。
 *
 * 权限级别：无（内部工具函数）；操作身份由 `userSession` 决定。
 * 副作用：一次出网 RPC，永久移除平台侧任务。
 *
 * 关于"幂等"：指调用方视角上重复删除同一个 taskUid 是安全的（业务上无副作用差异）；
 * 但上游对已删除的 taskUid 仍可能返回 404 → 抛 `TRPCError(NOT_FOUND)`，
 * 需要静默幂等的调用方应自行捕获该错误。
 *
 * @param taskUid     任务句柄
 * @param userSession 终端用户 session（空串 = 项目所有者身份）
 * @throws TRPCError 见 `mapForgeError`
 */
export async function deleteHeartbeatJob(
  taskUid: string,
  userSession: string
): Promise<void> {
  await callForge("DeleteHeartbeatJob", { taskUid }, userSession);
}

/**
 * List cron jobs owned by the resolved actor (end-user when `userSession`
 * is set, project owner otherwise) within the current project.
 *
 * `actorUserId` in the response echoes whose cron list you got back. End-users
 * cannot list other users' crons via this SDK; cross-user inspection is
 * owner-only via the sandbox CLI (`manus-heartbeat list --user-id <uid>`).
 *
 * 分页列出当前身份在本项目下的 cron 任务。
 *
 * 权限级别：无（内部工具函数），但**隐含了越权隔离**：能看到哪些任务完全由
 * `userSession` 解析出的身份决定 —— 终端用户只能看自己的，看不到别人的。
 * 跨用户巡检只能由所有者通过沙箱 CLI（`manus-heartbeat list --user-id <uid>`）进行。
 *
 * 副作用：一次出网 RPC，只读。
 *
 * @param userSession 终端用户 session（空串 = 以项目所有者身份列举）
 * @param pagination  分页参数，两个字段均可选；不传则使用上游默认分页
 * @returns `{ total, actorUserId, jobs }`。`actorUserId` 回显"这是谁的列表"，
 *          可用于确认身份解析是否符合预期
 * @throws TRPCError 见 `mapForgeError`
 */
export async function listHeartbeatJobs(
  userSession: string,
  pagination?: { page?: number; pageSize?: number }
): Promise<{ total: number; actorUserId: string; jobs: HeartbeatJobInfo[] }> {
  // 同样是 `!== undefined` 逐字段写入：不传分页参数时请求体保持为空对象，
  // 由上游决定默认页码与页大小，避免本地硬编码默认值与上游不一致。
  const body: Record<string, unknown> = {};
  if (pagination?.page !== undefined) body.page = pagination.page;
  if (pagination?.pageSize !== undefined) body.pageSize = pagination.pageSize;
  return callForge<{
    total: number;
    actorUserId: string;
    jobs: HeartbeatJobInfo[];
  }>("ListHeartbeatJobs", body, userSession);
}
