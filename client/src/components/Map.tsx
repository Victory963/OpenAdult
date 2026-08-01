/**
 * GOOGLE MAPS FRONTEND INTEGRATION - ESSENTIAL GUIDE
 *
 * USAGE FROM PARENT COMPONENT:
 * ======
 *
 * const mapRef = useRef<google.maps.Map | null>(null);
 *
 * <MapView
 *   initialCenter={{ lat: 40.7128, lng: -74.0060 }}
 *   initialZoom={15}
 *   onMapReady={(map) => {
 *     mapRef.current = map; // Store to control map from parent anytime, google map itself is in charge of the re-rendering, not react state.
 * </MapView>
 *
 * ======
 * Available Libraries and Core Features:
 * -------------------------------
 * 📍 MARKER (from `marker` library)
 * - Attaches to map using { map, position }
 * new google.maps.marker.AdvancedMarkerElement({
 *   map,
 *   position: { lat: 37.7749, lng: -122.4194 },
 *   title: "San Francisco",
 * });
 *
 * -------------------------------
 * 🏢 PLACES (from `places` library)
 * - Does not attach directly to map; use data with your map manually.
 * const place = new google.maps.places.Place({ id: PLACE_ID });
 * await place.fetchFields({ fields: ["displayName", "location"] });
 * map.setCenter(place.location);
 * new google.maps.marker.AdvancedMarkerElement({ map, position: place.location });
 *
 * -------------------------------
 * 🧭 GEOCODER (from `geocoding` library)
 * - Standalone service; manually apply results to map.
 * const geocoder = new google.maps.Geocoder();
 * geocoder.geocode({ address: "New York" }, (results, status) => {
 *   if (status === "OK" && results[0]) {
 *     map.setCenter(results[0].geometry.location);
 *     new google.maps.marker.AdvancedMarkerElement({
 *       map,
 *       position: results[0].geometry.location,
 *     });
 *   }
 * });
 *
 * -------------------------------
 * 📐 GEOMETRY (from `geometry` library)
 * - Pure utility functions; not attached to map.
 * const dist = google.maps.geometry.spherical.computeDistanceBetween(p1, p2);
 *
 * -------------------------------
 * 🛣️ ROUTES (from `routes` library)
 * - Combines DirectionsService (standalone) + DirectionsRenderer (map-attached)
 * const directionsService = new google.maps.DirectionsService();
 * const directionsRenderer = new google.maps.DirectionsRenderer({ map });
 * directionsService.route(
 *   { origin, destination, travelMode: "DRIVING" },
 *   (res, status) => status === "OK" && directionsRenderer.setDirections(res)
 * );
 *
 * -------------------------------
 * 🌦️ MAP LAYERS (attach directly to map)
 * - new google.maps.TrafficLayer().setMap(map);
 * - new google.maps.TransitLayer().setMap(map);
 * - new google.maps.BicyclingLayer().setMap(map);
 *
 * -------------------------------
 * ✅ SUMMARY
 * - “map-attached” → AdvancedMarkerElement, DirectionsRenderer, Layers.
 * - “standalone” → Geocoder, DirectionsService, DistanceMatrixService, ElevationService.
 * - “data-only” → Place, Geometry utilities.
 */

/**
 * ============================================================================
 * client/src/components/Map.tsx — Google Maps 容器组件（UI 组件层 / 脚手架自带）
 * ============================================================================
 * （以上英文块是 Manus 脚手架附带的 Google Maps JS API 速查手册，原样保留。）
 *
 * ## 在架构中的位置
 * 属于**前端可复用组件层** (`client/src/components/`)，是对 Google Maps JavaScript API
 * 的一层极薄 React 封装。服务端有对应的代理 `server/_core/map.ts`，但本组件走的是
 * **前端直连 Forge 网关**的路径，不经过本项目的 Express。
 *
 * ## 主要导出
 * - `MapView`（具名导出）：唯一导出，渲染一个撑满宽度、默认 500px 高的地图容器。
 *
 * ## 上下游依赖
 * - 上游调用方：**当前代码库中无人引用**。OpenAdult 是视频平台，没有地图相关业务，
 *   这是 Manus 脚手架模板残留的组件，属于可安全删除的死代码（见 observations）。
 * - 下游依赖：
 *   - `@/hooks/usePersistFn`（保持 init 函数引用稳定，避免 useEffect 重复执行）
 *   - Forge 网关的 Maps 代理 `${FORGE_BASE_URL}/v1/maps/proxy`
 *   - 全局 `window.google`（由动态注入的 script 挂上）
 *
 * ## 关键设计决策与坑
 * 1. **地图实例存在 ref 而非 state**：Google Maps 自己管理内部渲染与 DOM 变更，
 *    把它塞进 React state 只会引发无意义的 re-render，还可能让 React 试图接管
 *    由 Maps SDK 修改的 DOM。父组件要操控地图，靠 `onMapReady` 拿到实例自行保存。
 * 2. **走 Forge 代理而非 maps.googleapis.com 直连**：API Key 由网关侧兜底/限流，
 *    前端只带一个受限的 `VITE_FRONTEND_FORGE_API_KEY`。
 * 3. **script 加载没有去重**：多个 MapView 同时挂载会重复注入脚本（见 observations）。
 * 4. **无卸载清理**：组件卸载时不销毁 map 实例，也不移除事件监听。Maps SDK 没有
 *    官方 destroy API，通常靠容器 DOM 被移除后 GC 回收，但监听器可能残留。
 */

/// <reference types="@types/google.maps" />

import { useEffect, useRef } from "react";
import { usePersistFn } from "@/hooks/usePersistFn";
import { cn } from "@/lib/utils";

// 声明合并：Maps SDK 通过 <script> 把命名空间挂到 window.google 上，
// 加载完成前该属性不存在，故标记为可选（`?`），使用处必须先确保脚本已就绪。
declare global {
  interface Window {
    google?: typeof google;
  }
}

// 三个模块级常量在构建时由 Vite 静态替换（import.meta.env 只暴露 VITE_ 前缀变量）。
const API_KEY = import.meta.env.VITE_FRONTEND_FORGE_API_KEY;
// 未配置时回落到 Forge 公共网关域名，保证开箱即用。
const FORGE_BASE_URL =
  import.meta.env.VITE_FRONTEND_FORGE_API_URL ||
  "https://forge.butterfly-effect.dev";
// 代理前缀：网关会把 /v1/maps/proxy/** 透传到 maps.googleapis.com/**
const MAPS_PROXY_URL = `${FORGE_BASE_URL}/v1/maps/proxy`;

/**
 * 动态注入 Google Maps JS SDK 并在 onload 时 resolve。
 *
 * URL 各参数含义：
 * - `key`       —— Forge 前端 API Key（非 Google 原生 Key，由网关换发）
 * - `v=weekly`  —— 使用每周更新的准稳定版通道（Google 提供 weekly/quarterly/beta 等通道）
 * - `libraries` —— 按需加载的可选库，这里一次性载入 marker/places/geocoding/geometry
 *                  四个（见文件顶部速查手册），避免后续再动态 importLibrary
 *
 * @returns Promise，脚本 load 完成后 resolve(null)
 * @副作用 向 `document.head` 注入 `<script>`；执行后把 `google` 命名空间挂到 window 上。
 *
 * ⚠️ 两个已知问题（见 observations）：
 *   - 加载失败时只 `console.error`，Promise **永远不 resolve/reject**，调用方会一直挂起；
 *   - 无「已加载」判重，重复调用会重复注入脚本、重复触发 SDK 初始化。
 */
function loadMapScript() {
  return new Promise(resolve => {
    const script = document.createElement("script");
    script.src = `${MAPS_PROXY_URL}/maps/api/js?key=${API_KEY}&v=weekly&libraries=marker,places,geocoding,geometry`;
    // async：不阻塞 HTML 解析；crossOrigin=anonymous：让跨域脚本的错误堆栈可读，
    // 同时避免携带 cookie 到网关。
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      resolve(null);
      // 脚本执行完毕后其副作用（window.google）已经生效，
      // 移除 <script> 标签只是清理 DOM，不会卸载已加载的 SDK。
      script.remove(); // Clean up immediately
    };
    script.onerror = () => {
      console.error("Failed to load Google Maps script");
    };
    document.head.appendChild(script);
  });
}

/**
 * MapView 的 props 契约。
 *
 * @property className     附加到容器 div 的类名，会与默认的 `w-full h-[500px]` 合并
 *                         （通过 `cn()`，后者可覆盖前者的冲突类）。
 * @property initialCenter 初始中心点，默认旧金山 (37.7749, -122.4194)。
 *                         **仅初始化时读取一次**，后续变更不会重新居中。
 * @property initialZoom   初始缩放级别，默认 12（约城市级视野）。同样只读一次。
 * @property onMapReady    地图实例创建完成后的回调。父组件应在此保存实例引用，
 *                         之后所有的标记/路线/图层操作都直接调 Maps API，绕开 React。
 */
interface MapViewProps {
  className?: string;
  initialCenter?: google.maps.LatLngLiteral;
  initialZoom?: number;
  onMapReady?: (map: google.maps.Map) => void;
}

/**
 * 渲染一个 Google 地图容器，并在挂载后异步完成 SDK 加载与地图实例化。
 *
 * 内部 ref 职责：
 * - `mapContainer` —— 指向承载地图的 div，交给 `new google.maps.Map(el, opts)`；
 * - `map`          —— 保存地图实例本身，避免触发 React 重渲染（见文件头设计决策 1）。
 *
 * @副作用 注入外部 script、创建 Maps 实例、触发 onMapReady 回调。
 */
export function MapView({
  className,
  initialCenter = { lat: 37.7749, lng: -122.4194 },
  initialZoom = 12,
  onMapReady,
}: MapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);

  // usePersistFn 返回一个**引用永久稳定**的包装函数（内部始终调用最新一版闭包）。
  // 这里用它有两个目的：
  //   1. 让下面的 useEffect 依赖 [init] 等价于「只在挂载时跑一次」，即使 props 变化
  //      也不会重新加载脚本、重建地图；
  //   2. 同时保证函数体里读到的 initialZoom/initialCenter/onMapReady 是最新值，
  //      不会像普通 useCallback(fn, []) 那样闭包捕获过期的 props。
  const init = usePersistFn(async () => {
    await loadMapScript();
    // 这一步在 await 之后，组件可能已经卸载（ref 被置空），此时安全退出。
    if (!mapContainer.current) {
      console.error("Map container not found");
      return;
    }
    // 四个 *Control 选项全开：显示地图类型切换、全屏、缩放、街景四组默认控件。
    // mapId 是使用 AdvancedMarkerElement（见顶部速查手册）的**前置条件** ——
    // 没有 mapId 的地图不支持新版标记，会静默降级。"DEMO_MAP_ID" 是 Google 提供的
    // 演示用 ID，生产环境应替换为在 Cloud Console 里创建的真实 Map ID。
    map.current = new window.google.maps.Map(mapContainer.current, {
      zoom: initialZoom,
      center: initialCenter,
      mapTypeControl: true,
      fullscreenControl: true,
      zoomControl: true,
      streetViewControl: true,
      mapId: "DEMO_MAP_ID",
    });
    if (onMapReady) {
      onMapReady(map.current);
    }
  });

  // 依赖 [init]：因为 init 引用恒定，这个 effect 实际只在挂载时执行一次。
  // 没有返回清理函数 —— Maps SDK 没有官方 destroy API（见文件头坑 4）。
  useEffect(() => {
    init();
  }, [init]);

  // 必须给容器一个**确定的高度**，否则 Maps SDK 会渲染成 0 高度的空白区。
  // 默认 500px 可被调用方通过 className 覆盖（cn/tailwind-merge 会解决类冲突）。
  return (
    <div ref={mapContainer} className={cn("w-full h-[500px]", className)} />
  );
}
