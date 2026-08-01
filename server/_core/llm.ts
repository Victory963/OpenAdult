/**
 * ============================================================================
 * server/_core/llm.ts — LLM 调用封装（Forge 网关 / OpenAI Chat Completions 协议）
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 外部服务适配层**。
 * 全站唯一的 LLM 出口：所有需要「大模型推理」的业务（AI 聊天推荐、人脸特征抽取、
 * 视频标题/描述自动生成、图像内容分析）都必须经由本文件的 `invokeLLM()`，
 * 不允许在路由层自行 fetch LLM 接口。
 *
 * ## 主要导出
 * - `invokeLLM(params)` —— 唯一的运行时函数，向 Forge 网关发起一次
 *   Chat Completions 请求并返回原始响应体（不做 JSON 解析、不做重试）。
 * - 一组类型定义：
 *   - 消息侧：`Role` / `TextContent` / `ImageContent` / `FileContent` /
 *     `MessageContent` / `Message`
 *   - 工具调用侧：`Tool` / `ToolChoice`（及其三种子形态）/ `ToolCall`
 *   - 结构化输出侧：`JsonSchema` / `OutputSchema` / `ResponseFormat`
 *   - 入参出参：`InvokeParams` / `InvokeResult`
 *
 * ## 上下游依赖
 * - 上游调用方（谁在用）：
 *   - `server/routers.ts`（AI 聊天推荐）
 *   - `server/search.ts`（文本 + 图像多模态搜索）
 *   - `server/file-upload.ts`、`server/routers/video-upload.ts`、
 *     `server/routers/video-upload-v2.ts`（根据文件名/封面生成元数据）
 *   - `server/_core/faceRecognition.ts`（视觉打分抽取"人脸特征"）
 *   - `server/routers/faceSearch.ts`（视觉 + 文本两次调用）
 * - 下游依赖：`./env` 的 `ENV.forgeApiUrl` / `ENV.forgeApiKey` / `ENV.hereticLlmModel`；
 *   网络出口为 Forge 网关的 `/v1/chat/completions`。
 *
 * ## 关键设计决策与坑
 * 1. **camelCase / snake_case 双写兼容**：`InvokeParams` 同时接受 `toolChoice` 与
 *    `tool_choice`、`maxTokens` 与 `max_tokens`、`outputSchema` 与 `output_schema`、
 *    `responseFormat` 与 `response_format`。目的是让习惯 OpenAI SDK 原生写法的调用方
 *    可以直接照抄。归一化在本文件内部完成，发出去的 payload 一律是 snake_case。
 * 2. **模型不可由调用方指定**：`payload.model` 恒为 `ENV.hereticLlmModel`。本站内容领域
 *    会触发通用对齐模型的安全拒答，因此全站锁死使用去对齐（abliterated）模型。
 * 3. **`maxTokens` 未传时兜底为 32768**：调用方传入的 `maxTokens` / `max_tokens` 会被透传给上游，
 *    两者都没传才用 32768（模型最大输出窗口）兜底。
 * 4. **无重试、无超时、无流式**：一次 `fetch` 定生死；非 2xx 直接抛 `Error`（注意是原生
 *    Error 而非 `TRPCError`，落到 tRPC 层会变成 INTERNAL_SERVER_ERROR）。调用方若需要
 *    容错，需自行 try/catch（`faceRecognition.ts` 就是这么做的）。
 * 5. **响应体不做校验**：直接 `as InvokeResult` 断言。上游必须用可选链读取
 *    `response.choices[0]?.message?.content`。
 */
import { ENV } from "./env";

/** 消息角色。`tool` / `function` 为工具调用的回执消息，其 content 会被强制压平为字符串。 */
export type Role = "system" | "user" | "assistant" | "tool" | "function";

/** 纯文本内容块。 */
export type TextContent = {
  type: "text";
  text: string;
};

/**
 * 图像内容块（多模态输入）。
 * `url` 既可以是 http(s) 公网地址，也可以是 `data:image/jpeg;base64,...` 内联 data URL
 * （`faceRecognition.ts` 传 Buffer 时走的就是 data URL 分支）。
 * `detail` 控制视觉分辨率档位，`high` 更贵但更准，人脸特征抽取固定用 `high`。
 */
export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

/**
 * 文件内容块（音频 / PDF / 视频）。
 * mime_type 为白名单枚举 —— 网关只受理这几种类型，传其他类型会被上游拒绝。
 */
export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

/** 单个内容块。裸字符串是 `TextContent` 的简写，会在归一化阶段被包成 `{type:"text"}`。 */
export type MessageContent = string | TextContent | ImageContent | FileContent;

/**
 * 一条对话消息。
 * - `content` 支持单块或多块（多模态时传数组，例如 [文本提示, 图片]）。
 * - `name`：可选的发言者名字（OpenAI 协议字段）。
 * - `tool_call_id`：仅当 `role` 为 `tool`/`function` 时使用，回指对应的 `ToolCall.id`。
 */
export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

/** 可供模型调用的工具（function calling）。`parameters` 为 JSON Schema。 */
export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

/** 工具选择策略的简写形态。注意 `required` 在本封装中有特殊限制，见 `normalizeToolChoice`。 */
export type ToolChoicePrimitive = "none" | "auto" | "required";
/** 只给名字的简写形态：`{ name: "my_tool" }`。 */
export type ToolChoiceByName = { name: string };
/** OpenAI 原生完整形态，归一化的目标格式。 */
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

/**
 * `invokeLLM()` 的入参。
 *
 * 成对出现的 camelCase / snake_case 字段是**同义别名**，两者都传时以 camelCase 优先
 * （见 `invokeLLM` 中的 `toolChoice || tool_choice` 等表达式）。
 *
 * 注意：`maxTokens` / `max_tokens` 会被透传为 payload 的 `max_tokens`；两者都未传时
 * 兜底为 32768。
 */
export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};

/** 模型发起的一次工具调用。`arguments` 是**未解析的 JSON 字符串**，调用方需自行 JSON.parse。 */
export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/**
 * Chat Completions 响应体（OpenAI 兼容格式）。
 *
 * 该类型是对上游 JSON 的**乐观断言**，运行时未做任何校验：`choices` 可能为空数组，
 * `content` 在纯工具调用场景下可能为 null/undefined，务必用可选链访问。
 */
export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

/**
 * 结构化输出用的 JSON Schema 描述。
 * - `name`：schema 名称（上游要求必填）。
 * - `schema`：标准 JSON Schema 对象。
 * - `strict`：是否强制严格模式（模型输出必须完全符合 schema）。
 */
export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

/** `outputSchema` 是 `responseFormat: {type:"json_schema"}` 的简写入口，二者最终等价。 */
export type OutputSchema = JsonSchema;

/** 响应格式：纯文本 / 任意 JSON 对象 / 受 JSON Schema 约束的 JSON。 */
export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

/** 把「单块或多块」内容统一成数组，简化后续 map 处理。 */
const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

/**
 * 归一化单个内容块：裸字符串 → `{type:"text"}`；已是结构化块则原样返回。
 * 遇到未知 `type` 抛错，属于调用方编程错误（类型系统本应拦住，运行时兜底）。
 */
const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

/**
 * 把一条 `Message` 转换成上游 API 期望的形状。
 *
 * 两条分支的差异是刻意的：
 * - `tool` / `function` 角色：OpenAI 协议要求 content 必须是**纯字符串**，
 *   因此把多块内容序列化后用换行拼接，并保留 `tool_call_id` 以回指发起的工具调用。
 * - 其他角色：保留多模态数组结构；但如果只有唯一一个文本块，则**塌缩成裸字符串** ——
 *   这是为了兼容那些不接受 content 数组形式的旧版/精简版网关实现。
 */
const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

/**
 * 把三种 `ToolChoice` 简写形态统一成上游认识的两种：字面量 `none`/`auto`，
 * 或完整的 `{type:"function", function:{name}}`。
 *
 * 关键取舍：上游网关**不支持** OpenAI 的 `"required"` 字面量（"必须调工具但由模型选哪个"），
 * 所以这里退化实现为「只有恰好配置了一个工具时，才把 required 翻译成指定调用该工具」。
 * 0 个工具 → 抛错（语义矛盾）；多于 1 个工具 → 抛错并提示显式指定工具名。
 *
 * @throws Error 当 `required` 与工具数量不匹配时
 */
const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

/**
 * 解析 Chat Completions 端点地址。
 * `replace(/\/$/, "")` 去掉 base URL 末尾多余的斜杠，避免拼出 `//v1/...`。
 * 未配置 `BUILT_IN_FORGE_API_URL` 时回退到 Manus 官方公网网关（硬编码兜底）。
 */
const resolveApiUrl = () =>
  ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0
    ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`
    : "https://forge.manus.im/v1/chat/completions";

/**
 * 前置校验 API Key。
 * 注意错误文案里的 `OPENAI_API_KEY` 与本项目实际使用的环境变量名
 * `BUILT_IN_FORGE_API_KEY` 不一致（模板遗留），排错时以后者为准。
 */
const assertApiKey = () => {
  if (!ENV.forgeApiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
};

/**
 * 归一化响应格式，把 4 个别名字段收敛成一个 `response_format`。
 *
 * 优先级：显式的 `responseFormat`/`response_format` > 简写的 `outputSchema`/`output_schema`。
 * 两者都没有则返回 undefined（不往 payload 里塞该字段，让上游用默认的自由文本输出）。
 *
 * @throws Error 当 json_schema 缺少 `schema`，或 outputSchema 缺少 `name`/`schema` 时
 */
const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  // 走简写通道：把 outputSchema 提升为完整的 json_schema response_format。
  // `strict` 仅在调用方明确传了布尔值时才透传，避免误把 undefined 当成 false 发出去。
  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

/**
 * 发起一次 LLM Chat Completions 调用（全站唯一的 LLM 入口）。
 *
 * 权限级别：**无**。这是一个纯服务端工具函数，不做鉴权 —— 鉴权由调用它的
 * tRPC procedure（publicProcedure / protectedProcedure / adminProcedure）负责。
 *
 * 副作用：
 * - 发起一次出网 HTTP POST 到 Forge 网关（**计费**）。
 * - 不写库、不写 S3、无缓存、无重试。
 *
 * 行为要点：
 * - 模型固定为 `ENV.hereticLlmModel`，调用方无法覆盖。
 * - `tools` 为空数组时不会写入 payload（避免上游因空数组报错）。
 * - 同步阻塞直到上游返回完整响应（非流式）。
 *
 * @param params 见 `InvokeParams`；支持 camelCase / snake_case 双写。
 * @returns 上游原始响应体，未做结构校验；典型读取方式
 *          `res.choices[0]?.message?.content`。
 * @throws Error 当 `BUILT_IN_FORGE_API_KEY` 未配置、`toolChoice` 归一化失败、
 *         `responseFormat` 非法，或上游返回非 2xx（错误信息含状态码与响应体）时。
 *         网络层异常（DNS/连接失败）则由 `fetch` 直接抛出 TypeError。
 */
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  assertApiKey();

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    maxTokens,
    max_tokens,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
  } = params;

  // 模型名不来自入参，而是全局锁定 ENV.hereticLlmModel（去对齐模型，避免安全拒答）。
  const payload: Record<string, unknown> = {
    model: ENV.hereticLlmModel,
    messages: messages.map(normalizeMessage),
  };

  // 空数组也不发送：部分网关实现会把 `tools: []` 视为非法请求。
  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  // 魔法数字说明：
  // - max_tokens 默认 32768（32K）：单次响应的输出上限，取本项目所用模型的最大输出窗口，
  //   意在避免长篇推荐/描述被中途截断（finish_reason = "length"）。
  //   修复：改为透传调用方的 `maxTokens` / `max_tokens`（camelCase 优先），仅在两者都未传
  //   时才用 32768 兜底。此前是硬编码覆盖，任何传值限制输出长度的调用点都会静默失效。
  //   用 `??` 而非 `||`，以便调用方显式传 0 时也能原样发给上游而不被吞成默认值。
  // - thinking.budget_tokens = 128：思维链（reasoning）token 预算，刻意压到很低。
  //   本站的 LLM 用途（分类、打分、写标题）都是短判断型任务，不需要长推理；
  //   限制预算可显著降低延迟与成本，同时防止模型把 token 花在自我审查上。
  payload.max_tokens = maxTokens ?? max_tokens ?? 32768;
  payload.thinking = {
    "budget_tokens": 128
  }

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });

  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  // 无超时控制：依赖 Node fetch 的默认行为。若上游长时间不响应，
  // 该 tRPC 请求会一直挂起 —— 已知风险，需要超时的调用方应自行包 AbortSignal。
  const response = await fetch(resolveApiUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.forgeApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    // 把上游响应体一并带进错误信息，便于排查是鉴权失败、模型不存在还是入参非法。
    const errorText = await response.text();
    throw new Error(
      `LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`
    );
  }

  // 直接类型断言，不做运行时校验（见文件头「关键设计决策」第 5 条）。
  return (await response.json()) as InvokeResult;
}
