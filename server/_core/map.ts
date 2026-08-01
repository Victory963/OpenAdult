/**
 * Google Maps API Integration for Manus WebDev Templates
 * 
 * Main function: makeRequest<T>(endpoint, params) - Makes authenticated requests to Google Maps APIs
 * All credentials are automatically injected. Array parameters use | as separator.
 * 
 * See API examples below the type definitions for usage patterns.
 *
 * ============================================================================
 * server/_core/map.ts — Google Maps API 代理封装
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 外部服务适配层**。
 * 通过 Forge 网关的 `/v1/maps/proxy` 反向代理访问 Google Maps 全家桶。
 * 本项目不持有 Google 的 API Key，凭据由网关代持。
 *
 * ## 主要导出
 * - `makeRequest<T>(endpoint, params, options)` —— **唯一的运行时函数**，
 *   泛型化的通用请求器；具体调哪个 Maps 接口由 `endpoint` 决定。
 * - 一组响应体类型：`DirectionsResult` / `DistanceMatrixResult` / `GeocodingResult` /
 *   `PlacesSearchResult` / `PlaceDetailsResult` / `ElevationResult` / `TimeZoneResult` /
 *   `RoadsResult`，以及 `LatLng` / `TravelMode` / `MapType` / `SpeedUnit` 等基础类型。
 * - 文件末尾是**纯文档区**：一组只有 JSDoc 没有代码的注释块，逐个列出各 Maps 接口的
 *   endpoint、入参与返回类型，作为调用速查表使用。
 *
 * ## 上下游依赖
 * - 上游调用方：当前代码库中**暂无业务调用**（Manus 模板预置能力；成人视频平台
 *   本身没有地理信息需求，此文件属于模板携带的通用工具）。
 * - 下游依赖：`./env` 的 `ENV.forgeApiUrl` / `ENV.forgeApiKey`。
 *
 * ## 关键设计决策与坑
 * 1. **只提供一个通用请求器，不给每个 API 各包一个函数**：Maps 接口众多且入参差异大，
 *    逐个封装收益低；改为「通用函数 + 类型定义 + 文档速查表」的组合。
 *    代价是 `endpoint` 与泛型 `T` 的对应关系**没有类型约束**，写错不会被编译器发现。
 * 2. **数组参数用 `|` 分隔**（Google Maps 的约定），例如 `origins: "NYC|Boston"`。
 *    本函数不做数组转换，调用方需自行拼接。
 * 3. **HTTP 200 不等于成功**：Maps API 会在 200 响应体里用 `status` 字段表达
 *    `ZERO_RESULTS` / `OVER_QUERY_LIMIT` / `REQUEST_DENIED` 等业务错误。
 *    本函数只在非 2xx 时抛错，**不检查 `status`** —— 调用方必须自行判断。
 * 4. **Static Maps 例外**：该接口返回图片而非 JSON，不能走 `makeRequest`，
 *    需用 `getMapsConfig()` 自行拼 URL（但该函数未导出，实际需要时得先改成导出）。
 */

import { ENV } from "./env";

// ============================================================================
// Configuration
// ============================================================================

/** 代理访问所需的配置：网关基址 + API Key。 */
type MapsConfig = {
  baseUrl: string;
  apiKey: string;
};

/**
 * 读取并校验 Maps 代理配置（内部辅助，未导出）。
 *
 * 复用的是 Forge 网关的通用凭据（`BUILT_IN_FORGE_API_URL` / `BUILT_IN_FORGE_API_KEY`），
 * 而非 Google 自己的 key —— 真正的 Google 凭据在网关侧注入。
 *
 * @returns 归一化后的配置；`baseUrl` 已去除**所有**末尾斜杠（`/\/+$/`），
 *          因为后续是用模板字符串手工拼接路径（`${baseUrl}/v1/maps/proxy${endpoint}`），
 *          留斜杠会拼出双斜杠。注意这与本目录其他文件"补齐斜杠给 new URL 用"的做法相反。
 * @throws Error 当任一环境变量缺失时
 */
function getMapsConfig(): MapsConfig {
  const baseUrl = ENV.forgeApiUrl;
  const apiKey = ENV.forgeApiKey;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "Google Maps proxy credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
  };
}

// ============================================================================
// Core Request Handler
// ============================================================================

/**
 * 额外请求选项。
 * @property method 默认 GET。绝大多数 Maps 接口都是 GET，POST 仅用于少数 Roads 接口。
 * @property body   JSON 请求体，仅在 POST 时有意义。
 */
interface RequestOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}

/**
 * Make authenticated requests to Google Maps APIs
 * 
 * @param endpoint - The API endpoint (e.g., "/maps/api/geocode/json")
 * @param params - Query parameters for the request
 * @param options - Additional request options
 * @returns The API response
 *
 * 向 Google Maps API 发起一次带鉴权的代理请求（本文件唯一的运行时函数）。
 *
 * 权限级别：无（内部工具函数，鉴权由调用它的 tRPC procedure 负责）。
 *
 * 副作用：一次出网 HTTP 请求到 Forge 网关（**计费**，Maps API 按次收费）。
 * 不写库、不写 S3、无重试、无超时、无缓存。
 *
 * @typeParam T 期望的响应体类型，从本文件的 `*Result` 类型中挑选。
 *              ⚠️ 与 `endpoint` 的对应关系**不受类型系统保护**，选错类型不会报错，
 *              请对照文件末尾的接口速查表填写。
 * @param endpoint Maps 接口路径，需以 `/` 开头，如 `"/maps/api/geocode/json"`
 * @param params   查询参数。值为 `undefined` / `null` 的键会被跳过；其余一律
 *                 `String(value)` 转字符串。数组参数需调用方**自行用 `|` 拼好**再传入
 * @param options  见 `RequestOptions`
 * @returns 解析后的 JSON 响应。⚠️ 返回成功**不代表业务成功**，务必检查响应体里的
 *          `status` 字段（`OK` / `ZERO_RESULTS` / `OVER_QUERY_LIMIT` / `REQUEST_DENIED` …）
 * @throws Error 当环境变量缺失，或 HTTP 状态码非 2xx（错误信息含状态码与响应体）时
 */
export async function makeRequest<T = unknown>(
  endpoint: string,
  params: Record<string, unknown> = {},
  options: RequestOptions = {}
): Promise<T> {
  const { baseUrl, apiKey } = getMapsConfig();

  // Construct full URL: baseUrl + /v1/maps/proxy + endpoint
  // 直接用模板字符串拼接（而非 `new URL(relative, base)`），因为 endpoint 已带前导 `/`，
  // 且 baseUrl 在 getMapsConfig 里已剥掉尾部斜杠，两者拼接结果天然正确。
  const url = new URL(`${baseUrl}/v1/maps/proxy${endpoint}`);

  // Add API key as query parameter (standard Google Maps API authentication)
  // Maps 系列走 query 参数鉴权（`?key=`）而非 Authorization 头 —— 这是 Google 的
  // 标准做法，网关在转发时会用真实的 Google key 替换掉这里的 Forge key。
  url.searchParams.append("key", apiKey);

  // Add other query parameters
  // 跳过 undefined/null，避免拼出 `?foo=undefined` 这种会被 Maps 判为非法值的参数。
  // 注意用的是 append 而非 set：同名参数可重复出现（部分 Maps 接口支持）。
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  });

  // 即便是 GET 也固定发送 Content-Type: application/json —— 无害且简化了分支。
  // body 仅在 options.body 存在时序列化；GET 请求传 body 会被 fetch 拒绝，
  // 因此调用方需保证 body 只与 method:"POST" 搭配使用。
  const response = await fetch(url.toString(), {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Google Maps API request failed (${response.status} ${response.statusText}): ${errorText}`
    );
  }

  // 乐观断言，不做运行时校验；业务级错误藏在 `status` 字段里，需调用方自查。
  return (await response.json()) as T;
}

// ============================================================================
// Type Definitions
// 以下均为 Google Maps 官方响应结构的 TypeScript 映射，字段名保持 snake_case
// 以与原始 JSON 一一对应（Roads API 例外，官方本身就用 camelCase）。
// ============================================================================

/** 出行方式，用于 Directions / Distance Matrix。 */
export type TravelMode = "driving" | "walking" | "bicycling" | "transit";
/** 静态地图底图类型。 */
export type MapType = "roadmap" | "satellite" | "terrain" | "hybrid";
/** 限速单位，用于 Roads API 的 speedLimits。 */
export type SpeedUnit = "KPH" | "MPH";

/** 经纬度坐标对。 */
export type LatLng = {
  lat: number;
  lng: number;
};

/**
 * 路线规划结果。
 * 层级结构：`routes[]`（备选路线）→ `legs[]`（途经点切分出的路段）→ `steps[]`（转向指令）。
 * `distance.value` 单位为米，`duration.value` 单位为秒；同名的 `text` 是本地化后的可读文案。
 * `overview_polyline.points` 是编码折线，可直接喂给地图组件绘制路径。
 * `html_instructions` 含 HTML 标签，渲染前需注意 XSS 转义。
 */
export type DirectionsResult = {
  routes: Array<{
    legs: Array<{
      distance: { text: string; value: number };
      duration: { text: string; value: number };
      start_address: string;
      end_address: string;
      start_location: LatLng;
      end_location: LatLng;
      steps: Array<{
        distance: { text: string; value: number };
        duration: { text: string; value: number };
        html_instructions: string;
        travel_mode: string;
        start_location: LatLng;
        end_location: LatLng;
      }>;
    }>;
    overview_polyline: { points: string };
    summary: string;
    warnings: string[];
    waypoint_order: number[];
  }>;
  status: string;
};

/**
 * 距离矩阵结果：多起点 × 多终点的两两距离/时长。
 * 索引方式为 `rows[起点下标].elements[终点下标]`，下标顺序与请求里 `origins` /
 * `destinations` 的拼接顺序一致。每个 element 有自己的 `status`
 * （如某对不可达时为 `ZERO_RESULTS`），需逐项检查。
 */
export type DistanceMatrixResult = {
  rows: Array<{
    elements: Array<{
      distance: { text: string; value: number };
      duration: { text: string; value: number };
      status: string;
    }>;
  }>;
  origin_addresses: string[];
  destination_addresses: string[];
  status: string;
};

/**
 * 地理编码 / 逆地理编码结果（同一个端点双向复用）。
 * `results` 按匹配度降序，常用 `results[0]`。
 * `address_components` 是拆解后的地址片段（国家/省/市/街道…），
 * 靠 `types` 数组判别每段是什么（如 `["locality"]` 表示城市）。
 * `geometry.viewport` 是建议的地图可视范围，适合用来自动缩放。
 */
export type GeocodingResult = {
  results: Array<{
    address_components: Array<{
      long_name: string;
      short_name: string;
      types: string[];
    }>;
    formatted_address: string;
    geometry: {
      location: LatLng;
      location_type: string;
      viewport: {
        northeast: LatLng;
        southwest: LatLng;
      };
    };
    place_id: string;
    types: string[];
  }>;
  status: string;
};

/**
 * 地点搜索结果，Text Search 与 Nearby Search 共用此结构。
 * `place_id` 是稳定标识，可拿去调 Place Details 取详情。
 * `business_status` 标示营业状态（如 `OPERATIONAL` / `CLOSED_PERMANENTLY`）。
 */
export type PlacesSearchResult = {
  results: Array<{
    place_id: string;
    name: string;
    formatted_address: string;
    geometry: {
      location: LatLng;
    };
    rating?: number;
    user_ratings_total?: number;
    business_status?: string;
    types: string[];
  }>;
  status: string;
};

/**
 * 地点详情。注意返回的是单个 `result` 而非数组。
 * 大量字段为可选 —— 实际返回哪些取决于请求时的 `fields` 参数，
 * **且 `fields` 直接影响计费档位**，只取需要的字段可显著降低成本。
 * `reviews[].time` 是 Unix 秒级时间戳。
 */
export type PlaceDetailsResult = {
  result: {
    place_id: string;
    name: string;
    formatted_address: string;
    formatted_phone_number?: string;
    international_phone_number?: string;
    website?: string;
    rating?: number;
    user_ratings_total?: number;
    reviews?: Array<{
      author_name: string;
      rating: number;
      text: string;
      time: number;
    }>;
    opening_hours?: {
      open_now: boolean;
      weekday_text: string[];
    };
    geometry: {
      location: LatLng;
    };
  };
  status: string;
};

/**
 * 海拔查询结果。
 * `elevation` 单位为米（可为负，表示低于海平面）；
 * `resolution` 是采样数据的水平分辨率（米），值越小数据越精细。
 */
export type ElevationResult = {
  results: Array<{
    elevation: number;
    location: LatLng;
    resolution: number;
  }>;
  status: string;
};

/**
 * 时区查询结果。
 * 当地 UTC 偏移 = `rawOffset + dstOffset`，两者单位均为**秒**
 * （`dstOffset` 为夏令时附加偏移，非夏令时期间为 0）。
 * 查询必须带 `timestamp`，因为夏令时状态随时间变化。
 */
export type TimeZoneResult = {
  dstOffset: number;
  rawOffset: number;
  status: string;
  timeZoneId: string;
  timeZoneName: string;
};

/**
 * Roads API 结果（GPS 轨迹吸附到路网）。
 * 注意此接口字段是 camelCase（与其他 Maps 接口的 snake_case 不同），且**没有 `status` 字段**。
 * `originalIndex` 回指请求 `path` 中原始点的下标；开启 `interpolate` 后新插入的
 * 补间点不带该字段，可据此区分原始点与插值点。
 */
export type RoadsResult = {
  snappedPoints: Array<{
    location: LatLng;
    originalIndex?: number;
    placeId: string;
  }>;
};

// ============================================================================
// Google Maps API Reference
// ----------------------------------------------------------------------------
// 以下全部是**纯文档注释，不含任何可执行代码**。
// 每个块描述一个 Maps 接口的「endpoint + 入参 + 对应返回类型」，
// 作为调用 `makeRequest<T>()` 时的速查表 —— 因为 endpoint 与泛型 T 的搭配
// 没有类型约束，只能靠这份清单来保证不写错。
// ============================================================================

/**
 * GEOCODING - Convert between addresses and coordinates
 * Endpoint: /maps/api/geocode/json
 * Input: { address: string } OR { latlng: string }  // latlng: "37.42,-122.08"
 * Output: GeocodingResult  // results[0].geometry.location, results[0].formatted_address
 */

/**
 * DIRECTIONS - Get navigation routes between locations
 * Endpoint: /maps/api/directions/json
 * Input: { origin: string, destination: string, mode?: TravelMode, waypoints?: string, alternatives?: boolean }
 * Output: DirectionsResult  // routes[0].legs[0].distance, duration, steps
 */

/**
 * DISTANCE MATRIX - Calculate travel times/distances for multiple origin-destination pairs
 * Endpoint: /maps/api/distancematrix/json
 * Input: { origins: string, destinations: string, mode?: TravelMode, units?: "metric"|"imperial" }  // origins: "NYC|Boston"
 * Output: DistanceMatrixResult  // rows[0].elements[1] = first origin to second destination
 */

/**
 * PLACE SEARCH - Find businesses/POIs by text query
 * Endpoint: /maps/api/place/textsearch/json
 * Input: { query: string, location?: string, radius?: number, type?: string }  // location: "40.7,-74.0"
 * Output: PlacesSearchResult  // results[].name, rating, geometry.location, place_id
 */

/**
 * NEARBY SEARCH - Find places near a specific location
 * Endpoint: /maps/api/place/nearbysearch/json
 * Input: { location: string, radius: number, type?: string, keyword?: string }  // location: "40.7,-74.0"
 * Output: PlacesSearchResult
 */

/**
 * PLACE DETAILS - Get comprehensive information about a specific place
 * Endpoint: /maps/api/place/details/json
 * Input: { place_id: string, fields?: string }  // fields: "name,rating,opening_hours,website"
 * Output: PlaceDetailsResult  // result.name, rating, opening_hours, etc.
 */

/**
 * ELEVATION - Get altitude data for geographic points
 * Endpoint: /maps/api/elevation/json
 * Input: { locations?: string, path?: string, samples?: number }  // locations: "39.73,-104.98|36.45,-116.86"
 * Output: ElevationResult  // results[].elevation (meters)
 */

/**
 * TIME ZONE - Get timezone information for a location
 * Endpoint: /maps/api/timezone/json
 * Input: { location: string, timestamp: number }  // timestamp: Math.floor(Date.now()/1000)
 * Output: TimeZoneResult  // timeZoneId, timeZoneName
 */

/**
 * ROADS - Snap GPS traces to roads, find nearest roads, get speed limits
 * - /v1/snapToRoads: Input: { path: string, interpolate?: boolean }  // path: "lat,lng|lat,lng"
 * - /v1/nearestRoads: Input: { points: string }  // points: "lat,lng|lat,lng"
 * - /v1/speedLimits: Input: { path: string, units?: SpeedUnit }
 * Output: RoadsResult
 */

/**
 * PLACE AUTOCOMPLETE - Real-time place suggestions as user types
 * Endpoint: /maps/api/place/autocomplete/json
 * Input: { input: string, location?: string, radius?: number }
 * Output: { predictions: Array<{ description: string, place_id: string }> }
 */

/**
 * STATIC MAPS - Generate map images as URLs (for emails, reports, <img> tags)
 * Endpoint: /maps/api/staticmap
 * Input: URL params - center: string, zoom: number, size: string, markers?: string, maptype?: MapType
 * Output: Image URL (not JSON) - use directly in <img src={url} />
 * Note: Construct URL manually with getMapsConfig() for auth
 */




