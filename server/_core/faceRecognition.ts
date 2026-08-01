/**
 * Face Recognition Utilities - LLM-based approach
 * Since face-api.js requires browser DOM (HTMLImageElement, Canvas),
 * we use LLM-based facial feature extraction for server-side processing.
 * The embeddings are stored as feature description hashes for similarity matching.
 *
 * ============================================================================
 * server/_core/faceRecognition.ts — 基于 LLM 视觉打分的「伪人脸向量」工具集
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 领域算法层**。
 * 为「女优相似度检索」功能提供特征抽取与相似度计算能力，本身不碰数据库、不碰 HTTP。
 *
 * ## 主要导出
 * - `extractFaceEmbedding(imageSource)` —— 调 LLM 视觉能力，把一张人脸图片转成
 *   14 维、归一化到 0~1 的 `Float32Array` 伪向量。失败返回 `null`（不抛错）。
 * - `calculateCosineSimilarity(a, b)` —— 余弦相似度，返回 0~1（理论上也可能为负，见下）。
 * - `findSimilarActresses(userEmbedding, actressEmbeddings, threshold)` —— 批量比对 +
 *   阈值过滤 + 按相似度降序排序。
 * - `parseEmbedding(json)` / `stringifyEmbedding(embedding)` —— 数据库存取用的
 *   JSON 字符串 ⇄ Float32Array 编解码（`actress_face_embeddings.embedding` 列存的就是这个 JSON）。
 *
 * ## 上下游依赖
 * - 上游调用方：
 *   - `server/routers/actressManagement.ts`（录入女优头像时抽取并落库）
 *   - `server/routers/faceSearch.ts` / `server/search.ts`（检索侧比对）
 * - 下游依赖：`./llm` 的 `invokeLLM()` → Forge LLM 网关（视觉多模态调用，**计费**）。
 *
 * ## 关键设计决策与坑
 * 1. **为什么不是真正的人脸 embedding**：face-api.js / face-recognition 这类库依赖浏览器
 *    DOM（HTMLImageElement、Canvas），Node 端跑不起来；引入 ONNX/dlib 又要带上模型文件和
 *    原生依赖，与本项目「纯 TS + Docker 轻量镜像」的取舍冲突。因此改用 LLM 给一组预定义的
 *    面部属性打分，把这 14 个分数当作低维向量使用。
 * 2. **这不是身份识别，是"风格/长相类型"匹配**：14 维远不足以区分个体，且部分维度
 *    （hair_color、hair_length）会随妆造/滤镜变化，甚至根本不是脸部固有属性。
 *    真实作用更接近"找长得像这一挂的女优"，不要当人脸识别用。
 * 3. **LLM 输出不稳定**：同一张图多次调用可能给出不同分数，向量不具备可复现性。
 *    这也意味着入库的 embedding 与查询时现算的 embedding 之间天然存在噪声。
 * 4. **相似度天然偏高**：所有分量都在 [0,1] 且多数落在 0.2~0.8，两个随机向量的余弦
 *    相似度通常已 >0.9，所以默认阈值 0.7 几乎不过滤任何东西。调阈值时要基于实测分布，
 *    不能套用真实 embedding 的经验值。
 */

import { invokeLLM } from "./llm";

/**
 * Extract face features from image URL using LLM vision
 * Returns a pseudo-embedding (feature hash array) for similarity comparison
 *
 * 用 LLM 视觉能力从图片中抽取「伪人脸向量」。
 *
 * 权限级别：无（内部工具函数，鉴权由调用它的 tRPC procedure 负责）。
 *
 * 副作用：调用 LLM（出网 HTTP + **计费**）；失败时写 `console.warn` / `console.error` 日志。
 * 不写库、不写 S3。
 *
 * 容错策略：**全程吞异常**。无论是 LLM 报错、返回空、还是 JSON 解析失败，一律返回
 * `null` 而非抛出 —— 因为该函数常在批量导入女优的循环里被调用，单张图失败不应中断整批。
 * 调用方必须显式判空。
 *
 * @param imageSource 图片来源。传 `string` 视为可直接访问的 URL（http(s) 或已有的 data URL）；
 *                    传 `Buffer` 则会被转成 `data:image/jpeg;base64,...` 内联进请求。
 *                    ⚠️ Buffer 分支硬编码了 `image/jpeg` 前缀，实际传 PNG/WebP 时
 *                    MIME 声明与内容不符（多数模型能容忍，但并非保证）。
 * @returns 长度 14、取值范围 0~1 的 `Float32Array`；任何环节失败返回 `null`。
 */
export async function extractFaceEmbedding(
  imageSource: string | Buffer
): Promise<Float32Array | null> {
  try {
    let imageUrl: string;
    if (typeof imageSource === "string") {
      imageUrl = imageSource;
    } else {
      // Convert buffer to base64 data URL
      // Buffer 分支：把二进制内联成 data URL，免去先上传 S3 再回传 URL 的往返。
      // 代价是请求体膨胀约 33%（base64 编码开销），大图会显著拉高延迟。
      const base64 = imageSource.toString("base64");
      imageUrl = `data:image/jpeg;base64,${base64}`;
    }

    // Use LLM to extract facial features
    // 提示词设计要点：把每个面部属性映射到一个**固定的离散分数刻度**（如 round=10、
    // oval=30…），而不是让模型自由打分。这样做是为了尽量压低 LLM 输出的随机性，
    // 让同一类长相落到同一个刻度上，否则向量在不同次调用之间会漂移得没法比。
    // detail:"high" 是必要的 —— 低分辨率档位下模型看不清五官细节，分数会退化成常数。
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a facial feature extraction system. Analyze the face in the image and return a JSON object with these numeric scores (0-100 for each):
{
  "face_shape": <round=10, oval=30, square=50, heart=70, long=90>,
  "eye_size": <small=20, medium=50, large=80>,
  "eye_shape": <round=20, almond=50, monolid=80>,
  "nose_size": <small=20, medium=50, large=80>,
  "nose_shape": <button=20, straight=50, wide=80>,
  "lip_fullness": <thin=20, medium=50, full=80>,
  "cheekbone": <low=20, medium=50, high=80>,
  "jaw_definition": <soft=20, medium=50, strong=80>,
  "forehead": <small=20, medium=50, large=80>,
  "skin_tone": <very_fair=10, fair=30, medium=50, tan=70, dark=90>,
  "age_appearance": <18-25=20, 25-30=40, 30-35=60, 35-40=80, 40+=95>,
  "hair_color": <black=20, brown=40, blonde=60, red=80, other=50>,
  "hair_length": <short=20, medium=50, long=80>,
  "overall_attractiveness_style": <cute=20, elegant=40, sexy=60, cool=80, natural=50>
}
Return ONLY the JSON object, no other text.`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract facial features from this image." },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          ],
        },
      ],
    });

    // content 可能是字符串，也可能是多模态内容块数组；后者退化为 JSON.stringify 再尝试解析
    // （几乎必然解析失败并返回 null，属于兜底而非正常路径）。
    const rawContent = response.choices[0]?.message?.content;
    if (!rawContent) return null;
    const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);

    // Parse the feature scores
    // 尽管提示词写了"只返回 JSON"，模型仍常把结果包在 ```json ... ``` 代码块里，
    // 这里先剥掉围栏再解析。两条 replace 分别处理开栏（带 json 语言标记）和闭栏。
    // 注意：这是纯字符串清洗，若模型额外输出了前后说明文字，解析仍会失败 → 返回 null。
    let features: Record<string, number>;
    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      features = JSON.parse(cleaned);
    } catch {
      console.warn("[Face Recognition] Failed to parse LLM response:", content);
      return null;
    }

    // Convert to a fixed-size array (14 dimensions matching the features)
    // 这个数组是**向量维度的唯一权威定义**：顺序即维度下标，必须与上面提示词里的
    // 键名和顺序严格一致。改动它（增删/换序）会让历史入库的 embedding 全部失去可比性，
    // 需要重跑全量女优的特征抽取。
    const featureKeys = [
      "face_shape", "eye_size", "eye_shape", "nose_size", "nose_shape",
      "lip_fullness", "cheekbone", "jaw_definition", "forehead", "skin_tone",
      "age_appearance", "hair_color", "hair_length", "overall_attractiveness_style",
    ];

    // 缺失维度用 50（即中位刻度）兜底而非 0：0 会在余弦相似度里被当成"极端取值"，
    // 把缺失当成中性值更符合语义。随后统一除以 100 归一化到 0~1。
    const embedding = new Float32Array(featureKeys.length);
    featureKeys.forEach((key, i) => {
      embedding[i] = (features[key] ?? 50) / 100; // Normalize to 0-1
    });

    return embedding;
  } catch (error) {
    console.error("[Face Recognition] Error extracting face embedding:", error);
    return null;
  }
}

/**
 * Calculate cosine similarity between two embeddings
 * Returns a value between 0 and 1, where 1 is identical
 *
 * 计算两个向量的余弦相似度。
 *
 * 权限级别：无（纯函数）。副作用：无。
 *
 * 关于返回值范围：注释写的是 0~1，这在本模块场景下成立，因为伪向量的所有分量都
 * 非负（0~1 归一化），点积必然 ≥0。若传入含负分量的通用 embedding，返回值可能落在
 * [-1, 1]，调用方需自行留意。
 *
 * 边界处理：任一向量为零向量（模长 0）时返回 0，避免除零得到 NaN。
 *
 * @param embedding1 向量 A，`Float32Array` 或普通数字数组
 * @param embedding2 向量 B
 * @returns 相似度分值，1 表示方向完全一致
 */
export function calculateCosineSimilarity(
  embedding1: Float32Array | number[],
  embedding2: Float32Array | number[]
): number {
  // 统一成普通数组，屏蔽 Float32Array 与 number[] 的下标访问差异
  const arr1 = Array.isArray(embedding1) ? embedding1 : Array.from(embedding1);
  const arr2 = Array.isArray(embedding2) ? embedding2 : Array.from(embedding2);

  // 维度不一致的兜底分支：只在两者重叠的前 minLen 维上计算，多余维度直接丢弃。
  // 该分支存在的原因是历史数据可能用旧版 featureKeys（维度不同）生成，
  // 截断比直接报错更利于灰度迁移。代价是相似度会被系统性高估。
  if (arr1.length !== arr2.length) {
    // If dimensions don't match, use Euclidean distance on overlapping dimensions
    const minLen = Math.min(arr1.length, arr2.length);
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;
    for (let i = 0; i < minLen; i++) {
      dotProduct += arr1[i] * arr2[i];
      norm1 += arr1[i] * arr1[i];
      norm2 += arr2[i] * arr2[i];
    }
    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);
    if (norm1 === 0 || norm2 === 0) return 0;
    return dotProduct / (norm1 * norm2);
  }

  // 等维度主路径：一次遍历同时累加点积与两个平方模长，避免三次循环。
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < arr1.length; i++) {
    dotProduct += arr1[i] * arr2[i];
    norm1 += arr1[i] * arr1[i];
    norm2 += arr2[i] * arr2[i];
  }

  norm1 = Math.sqrt(norm1);
  norm2 = Math.sqrt(norm2);

  if (norm1 === 0 || norm2 === 0) {
    return 0;
  }

  return dotProduct / (norm1 * norm2);
}

/**
 * Find similar actresses based on face embedding
 *
 * 在候选女优向量集合中，找出与查询向量相似的条目。
 *
 * 权限级别：无（纯计算）。副作用：无 —— **不查库**，候选集需由调用方预先从
 * `actress_face_embeddings` 表读出并传入。
 *
 * 实现为「全量线性扫描」：复杂度 O(n × 14)。因为维度极低且女优总数有限，
 * 无需向量索引（HNSW/IVF）；若数据量增长到十万级需另做方案。
 *
 * 注意：函数签名是 `async` 但内部无任何 await，返回值恒为已 resolve 的 Promise ——
 * 保留 async 只是为了将来换成查库实现时不破坏调用方签名。
 *
 * @param userEmbedding    查询向量（用户上传图片抽取出的伪向量）
 * @param actressEmbeddings 候选集，每项含 `actressId`、`embedding`，`name` 可选（仅用于回显）
 * @param threshold        相似度下限（含），默认 0.7。⚠️ 由于本模块伪向量分量全为正，
 *                         随机两向量的余弦相似度通常已 >0.9，0.7 实际上几乎不过滤任何结果，
 *                         调参需以实测分布为准
 * @returns 相似度 ≥ threshold 的结果，**按相似度降序**排列；无匹配时返回空数组
 */
export async function findSimilarActresses(
  userEmbedding: Float32Array | number[],
  actressEmbeddings: Array<{
    actressId: number;
    embedding: Float32Array | number[];
    name?: string;
  }>,
  threshold: number = 0.7
): Promise<
  Array<{
    actressId: number;
    name?: string;
    similarity: number;
  }>
> {
  // map → filter → sort 三段式：先全量算分，再按阈值裁剪，最后降序排。
  // 排序放在 filter 之后可以少排一些元素（虽然量级小，影响可忽略）。
  const results = actressEmbeddings
    .map((actress) => ({
      actressId: actress.actressId,
      name: actress.name,
      similarity: calculateCosineSimilarity(userEmbedding, actress.embedding),
    }))
    .filter((result) => result.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);

  return results;
}

/**
 * Parse embedding from JSON string (stored in database)
 *
 * 把数据库中以 JSON 字符串形式存储的向量还原成 `Float32Array`。
 * 对应 `actress_face_embeddings.embedding` 列，与 `stringifyEmbedding()` 互为逆操作。
 *
 * 权限级别：无。副作用：解析失败时写 `console.error` 日志。
 *
 * @param embeddingJson 形如 `"[0.1,0.5,...]"` 的 JSON 数组字符串
 * @returns 还原后的 Float32Array
 * @throws SyntaxError 当字符串不是合法 JSON 时**向上抛出**（注意与
 *         `extractFaceEmbedding` 的吞异常风格不同，调用方必须自行 try/catch）
 */
export function parseEmbedding(embeddingJson: string): Float32Array {
  try {
    const arr = JSON.parse(embeddingJson);
    return new Float32Array(arr);
  } catch (error) {
    console.error("[Face Recognition] Error parsing embedding:", error);
    throw error;
  }
}

/**
 * Stringify embedding for database storage
 *
 * 把 `Float32Array` 序列化为可入库的 JSON 字符串（`parseEmbedding` 的逆操作）。
 * 必须先 `Array.from` 转普通数组 —— 直接 `JSON.stringify(Float32Array)` 会得到
 * `{"0":0.1,"1":0.5,...}` 这样的对象形式而非数组，反序列化时会出错。
 *
 * 权限级别：无。副作用：无。
 *
 * @param embedding 14 维伪向量
 * @returns 形如 `"[0.1,0.5,...]"` 的 JSON 数组字符串
 */
export function stringifyEmbedding(embedding: Float32Array): string {
  return JSON.stringify(Array.from(embedding));
}
