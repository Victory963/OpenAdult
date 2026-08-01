/**
 * ============================================================================
 * client/src/components/VideoPlayer.tsx — 自定义 HLS/MP4 播放器 (UI 层 / 组件)
 * ============================================================================
 *
 * 架构角色：
 *   展示层的「重组件」。项目没有使用 video.js / plyr 等成品播放器，而是基于原生
 *   <video> + hls.js 自行实现全套控制条（进度条拖拽、音量、倍速、清晰度、全屏），
 *   这样才能把两件平台特有的事情塞进播放链路：
 *     1) **广告插播**（SSAI 服务端拼接 + 客户端 overlay 双模式）
 *     2) **续播位置**（resume playback）的自动读写
 *
 * 主要导出物：
 *   - default VideoPlayer(props: VideoPlayerProps) — 唯一导出，受控于父页面
 *
 * 上下游依赖：
 *   ← client/src/pages/VideoDetailPage.tsx（主要调用方）
 *   → trpc.hlsStream.getManifest    取 pseudo-HLS m3u8 或 direct 直链（判别联合 type 字段）
 *   → trpc.hlsStream.getVideoAds    取广告时间表（overlay 模式用，按 triggerAt 升序）
 *   → trpc.hlsStream.trackAdEvent   广告埋点上报（impression / start / complete / click）
 *   → trpc.resumePlayback.get/update 续播位置读写
 *   → hls.js（npm 包）
 *   → /api/video-stream/:id（分片视频的服务端虚拟拼接端点）
 *
 * 关键设计决策 / 坑：
 *   1. **两套广告机制并存**，靠 getManifest 的 type 字段分流：
 *      - type === 'hls'    ：广告已被服务端拼进 m3u8，播放器只负责在 FRAG_CHANGED 时
 *                            读 EXT-X-CUE-OUT / CUE-IN 标记来点亮「広告」角标并禁用拖拽；
 *      - type === 'direct' ：manifest 不可用（通常是 duration 未回填），改为在主视频之上
 *                            覆盖一个独立的 <video> 播广告（见 activeAd 状态）。
 *      两条路径互斥，direct-mode 的触发 effect 里显式 return 掉 hls 情况。
 *   2. 播放源优先级：hls.js → Safari 原生 HLS → 直链 MP4。三级降级都在同一个 effect 里。
 *   3. 全屏有两套实现：优先 Fullscreen API；被浏览器/iframe 策略拒绝时退化为
 *      `position: fixed; inset: 0; z-9999` 的「伪全屏」，因此判断当前是否真全屏时
 *      要同时看 isFullscreen 与 document.fullscreenElement。
 *   4. 进度条是完全自绘的 div（非 <input type=range>），因为需要同时渲染
 *      缓冲进度 / 播放进度 / 悬停时间提示 / 拖拽 thumb 四层，并在广告播放时整体禁用。
 */

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Settings,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import Hls from "hls.js";

/**
 * VideoPlayer 的 props 契约。
 *
 * @property videoUrl     兜底播放地址。当 HLS manifest 不可用时直接喂给 <video src>。
 *                        允许是 `multi-chunk:<sessionId>` 哨兵值，内部会转成 /api/video-stream/:id。
 * @property title        视频标题。当前仅作语义信息保留，未在 DOM 中渲染。
 * @property thumbnailUrl 可选封面，作为 <video poster>，首帧加载前显示。
 * @property videoId      videos 表主键。缺省时**所有依赖 videoId 的能力全部关闭**：
 *                        续播、HLS manifest、广告、multi-chunk 解析。
 * @property hlsEnabled   是否尝试 HLS 播放，默认 true。传 false 可强制走 MP4 直链
 *                        （调试或已知转码未完成时使用）。
 */
interface VideoPlayerProps {
  videoUrl: string;
  title: string;
  thumbnailUrl?: string;
  videoId?: number;
  hlsEnabled?: boolean; // Enable HLS mode
}

/**
 * 自定义视频播放器组件。
 *
 * 内部状态分工（按职责分组，命名与 UI 一一对应）：
 *   —— 播放核心 ——
 *   isPlaying / currentTime / duration / buffered：镜像 <video> 元素的运行时状态，
 *     由 onPlay / onPause / onTimeUpdate / onLoadedMetadata 回调单向同步过来。
 *   isMuted / volume / playbackRate：用户偏好，写入时直接改 DOM 属性（非受控）。
 *   —— UI ——
 *   isFullscreen / showControls / showQualityMenu：纯外观状态。
 *   —— HLS ——
 *   hlsLevels：MANIFEST_PARSED 时从 hls.js 抽出的清晰度档位列表。
 *   currentLevel：当前档位下标，-1 代表 hls.js 自动码率切换（ABR）。
 *   —— 广告 ——
 *   isAdPlaying：两种模式共用的「当前正在放广告」总开关，会禁用进度条拖拽。
 *   activeAd：仅 direct/overlay 模式使用；非 null 时渲染覆盖层广告 <video>。
 *   adRemainingTime：广告倒计时秒数，驱动角标文案与「跳过」按钮出现时机。
 *   shownAdIds：已播过的广告去重集合，key 形如 `pre-<adId>` / `mid-<adId>-<triggerAt>`，
 *     防止用户来回拖动进度条时同一个 mid-roll 反复弹出。
 *   preRollDone：前贴片阶段是否已结束，是「前贴片 → 中插」的一次性状态闸门。
 *   —— 进度条拖拽 ——
 *   isDragging / dragTime：拖拽中用 dragTime 覆盖 currentTime 渲染，避免和
 *     onTimeUpdate 回流打架造成进度条抖动。
 *   hoverTime / hoverX：鼠标悬停预览时间气泡的内容与横向像素位置。
 */
export default function VideoPlayer({
  videoUrl,
  title,
  thumbnailUrl,
  videoId,
  hlsEnabled = true,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [buffered, setBuffered] = useState(0);

  // HLS state
  const [hlsLevels, setHlsLevels] = useState<{ height: number; bitrate: number; index: number }[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1); // -1 = auto
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [isAdPlaying, setIsAdPlaying] = useState(false);
  const [adRemainingTime, setAdRemainingTime] = useState(0);

  // Direct-mode ad overlay state
  // 结构与 hlsStream.getVideoAds 返回的单条广告对齐（此处未复用服务端类型，手写了一份）
  const [activeAd, setActiveAd] = useState<{
    adId: number; name: string; videoUrl: string;
    clickUrl: string | null; duration: number; position: string;
  } | null>(null);
  // 用 useState(初始化函数) 造一个「永不变化」的可变容器来存广告 <video> 的 DOM 引用。
  // 效果等价于 useRef，写成这样是为了在 JSX 的 ref 回调里赋值时不触发 lint 的 ref 规则。
  const [adVideoRef] = useState(() => ({ current: null as HTMLVideoElement | null }));
  const [shownAdIds, setShownAdIds] = useState<Set<string>>(new Set());
  const [preRollDone, setPreRollDone] = useState(false);

  // Seekbar drag state
  const [isDragging, setIsDragging] = useState(false);
  const [dragTime, setDragTime] = useState(0);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);

  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 拖拽开始前是否正在播放：拖拽期间会主动 pause，松手后据此决定要不要恢复播放
  const wasPlayingRef = useRef(false);

  // Resume playback mutations
  // 续播：读一次（挂载时定位），写多次（定时 / 暂停 / 关页面）
  const updateResumeMutation = trpc.resumePlayback.update.useMutation();
  const getResumeQuery = trpc.resumePlayback.get.useQuery(
    // videoId 缺省时传 0 只是为了满足 zod 输入类型，enabled=false 保证请求不会真的发出
    { videoId: videoId || 0 },
    // retry: false —— 未登录/无记录时接口会失败，这属于正常情况，不该重试刷日志
    { enabled: !!videoId, retry: false }
  );

  // Get HLS manifest URL
  // 返回判别联合：{ type:'hls', manifest } 或 { type:'direct', videoUrl }
  const hlsManifestQuery = trpc.hlsStream.getManifest.useQuery(
    { videoId: videoId || 0 },
    { enabled: !!videoId && hlsEnabled, retry: false }
  );

  // Get ads for direct/overlay mode
  // videoDuration 参与 query key：duration 从 0 变为真实时长时会自动重新拉取，
  // 因为 mid-roll/post-roll 的插入点必须依赖总时长才能算出来。
  const videoAdsQuery = trpc.hlsStream.getVideoAds.useQuery(
    { videoId: videoId || 0, videoDuration: duration > 0 ? duration : undefined },
    { enabled: !!videoId && duration >= 0, retry: false }
  );
  const trackAdMutation = trpc.hlsStream.trackAdEvent.useMutation();

  /**
   * 把数据库里的 videoUrl 归一化成浏览器可直接播放的地址。
   *
   * 只处理 `multi-chunk:` 哨兵值（分片上传产物，字节散落多个 S3 对象，
   * 必须由服务端 /api/video-stream/:id 按 Range 请求虚拟拼接）；其余原样返回。
   *
   * 纯函数，无副作用。依赖 videoId —— 缺少 videoId 时无法定位分片，只能原样返回。
   */
  // Resolve a video URL: convert multi-chunk: prefix to streaming endpoint
  const resolvePlayableUrl = useCallback((url: string): string => {
    if (url.startsWith('multi-chunk:') && videoId) {
      return `/api/video-stream/${videoId}`;
    }
    return url;
  }, [videoId]);

  // ==========================================================================
  // 播放源初始化：hls.js → Safari 原生 HLS → 直链 MP4 的三级降级
  // ==========================================================================
  // 该 effect 在 manifest 查询结果到达 / hlsEnabled / videoUrl 变化时重跑。
  // 注意 manifest 未就绪时（query 还在 loading）会先落到最后一个分支用 videoUrl
  // 直接起播，等 manifest 返回后再切换到 HLS —— 这是"先能播，再变好"的取舍。
  // Initialize HLS.js
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const hlsData = hlsManifestQuery.data;
    // 服务端把 m3u8 **文本内容**放在 manifest 字段里（pseudo-HLS，不是一个 URL）。
    // hls.js 的 loadSource 也接受 data:/blob: 形式的清单，这里直接透传。
    const manifestUrl = hlsData?.type === 'hls' ? hlsData.manifest : null;
    // For direct mode, resolve the URL (handle multi-chunk: prefix)
    // direct 模式优先用服务端返回的 videoUrl（可能已被后端修正过），否则退回 props
    const rawDirectUrl = hlsData?.type === 'direct' ? (hlsData.videoUrl || videoUrl) : videoUrl;
    const directUrl = resolvePlayableUrl(rawDirectUrl);

    // If HLS is enabled and we have a manifest URL, use hls.js
    if (hlsEnabled && manifestUrl && Hls.isSupported()) {
      const hls = new Hls({
        // enableWorker: 把 demux/remux 放到 Web Worker，避免长视频解析卡住主线程动画
        enableWorker: true,
        // 点播场景不需要 LL-HLS 的分片预加载，关掉可减少无谓请求
        lowLatencyMode: false,
        // 缓冲窗口：常态最多预缓冲 30 秒；网络好时允许自适应放大到 60 秒。
        // 这两个值是带宽成本与卡顿率的折中 —— 成人长视频体积大，缓冲过多会白白
        // 消耗 S3/CDN 流量（用户常常看几十秒就换片）。
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        startLevel: -1, // Auto quality selection
      });

      hls.loadSource(manifestUrl);
      hls.attachMedia(video);

      // 清单解析完成 → 把可选清晰度档位同步到 state，供右下角画质菜单渲染
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        const levels = data.levels.map((level, index) => ({
          height: level.height,
          bitrate: level.bitrate,
          index,
        }));
        setHlsLevels(levels);
      });

      // ABR 自动切档或用户手动切档后，回填当前实际生效的档位（用于菜单高亮）
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        setCurrentLevel(data.level);
      });

      // ===== SSAI 广告边界检测 =====
      // 服务端拼接模式下广告片段和正片片段混在同一条 m3u8 里，播放器无法从
      // URL 区分。约定用标准 HLS 广告标记来划分区间：
      //   EXT-X-CUE-OUT / EXT-X-DATERANGE → 进入广告区间
      //   EXT-X-CUE-IN                     → 离开广告区间
      // 每次切换到新分片时读它携带的 tagList 来翻转 isAdPlaying，
      // 从而点亮「広告」角标并禁掉进度条（防止用户拖过广告）。
      // Detect ad segments via custom metadata (DATERANGE or CUE)
      hls.on(Hls.Events.FRAG_CHANGED, (_event, data) => {
        const frag = data.frag;
        // Check if this fragment is an ad segment (tagged via programDateTime or custom tag)
        if (frag.tagList && frag.tagList.some((tag: string[]) => tag[0] === "EXT-X-CUE-OUT" || tag[0] === "EXT-X-DATERANGE")) {
          setIsAdPlaying(true);
        } else if (frag.tagList && frag.tagList.some((tag: string[]) => tag[0] === "EXT-X-CUE-IN")) {
          setIsAdPlaying(false);
          setAdRemainingTime(0);
        }
      });

      // ===== 致命错误恢复策略（hls.js 官方推荐的三段式）=====
      // 只处理 fatal 错误；非致命错误 hls.js 会自行重试，不必干预。
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              // 网络中断（含域名被封切换期间）：重新拉取清单/分片即可自愈
              console.warn("HLS network error, attempting recovery...");
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              // 解码/缓冲区异常：让 hls.js 刷新 MSE SourceBuffer 重新解码
              console.warn("HLS media error, attempting recovery...");
              hls.recoverMediaError();
              break;
            default:
              // 其它致命错误无法恢复：销毁实例并整体降级为 MP4 直链，
              // 宁可丢掉清晰度切换与广告插播，也要保证视频能播出来
              console.error("Fatal HLS error:", data);
              // Fallback to direct MP4
              hls.destroy();
              video.src = resolvePlayableUrl(videoUrl);
              break;
          }
        }
      });

      hlsRef.current = hls;

      // 仅 hls.js 分支需要清理：destroy() 会解绑 MSE、终止 worker 与所有在途请求。
      // 漏掉它会导致切换视频时旧实例继续下载分片（内存泄漏 + 流量浪费）。
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (hlsEnabled && manifestUrl && video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS support (Safari)
      // Safari / iOS 原生支持 HLS，直接把清单交给 <video>。
      // 代价：拿不到 hlsLevels，画质菜单不会出现，也无法监听 FRAG_CHANGED，
      // 因此 Safari 下 SSAI 广告角标不会显示（广告本身仍会正常播出）。
      video.src = manifestUrl;
    } else {
      // Fallback: direct MP4 playback
      video.src = directUrl;
    }
  }, [hlsManifestQuery.data, hlsEnabled, videoUrl, resolvePlayableUrl]);

  // 续播定位：仅在 resumePlayback.get 查询结果到达时执行一次。
  // 依赖数组只有 getResumeQuery.data，因此后续播放过程中的 currentTime 变化不会再次触发，
  // 不会出现"看着看着被拽回起点"的问题。
  // Load resume position on mount
  useEffect(() => {
    if (videoRef.current && getResumeQuery.data) {
      // as any：resumePlayback.get 的返回类型未在前端收窄，此处按运行时结构取字段
      const position = (getResumeQuery.data as any).position || 0;
      videoRef.current.currentTime = position;
      setCurrentTime(position);
    }
  }, [getResumeQuery.data]);

  // ==========================================================================
  // 广告状态机（overlay / direct 模式）
  // ==========================================================================
  // 状态转移：
  //   [无广告] --isPlaying 且存在 pre-roll--> [播前贴片] --倒计时归零/onEnded--> [正片]
  //   [正片]   --currentTime 落入某条 mid-roll 的触发窗口--> [播中插] --> [正片]
  //
  // 触发靠 currentTime 变化驱动（onTimeUpdate 约每 250ms 一次），所以这个 effect
  // 是高频重跑的，必须靠开头的三条早退保证幂等。
  //
  // 关键去重手段：shownAdIds 集合。用户拖动进度条来回经过同一插入点时，
  // 若不去重会导致同一条广告反复弹出。
  // Direct-mode ad trigger: check if we should show an ad based on current time
  useEffect(() => {
    if (!videoAdsQuery.data?.ads || videoAdsQuery.data.ads.length === 0) return;
    if (activeAd) return; // Already showing an ad
    if (hlsManifestQuery.data?.type === 'hls') return; // HLS mode handles ads via manifest

    const ads = videoAdsQuery.data.ads;

    // ---- 阶段 1：前贴片 ----
    // 等到用户真正点了播放（isPlaying）才插，而不是一进页面就插 ——
    // 页面加载即自动播放广告会被浏览器的自动播放策略拦截，且体验极差。
    // Pre-roll: show before playback starts (triggerAt=0)
    if (!preRollDone && isPlaying) {
      const preRollAd = ads.find(a => a.position === 'pre-roll');
      if (preRollAd && !shownAdIds.has(`pre-${preRollAd.adId}`)) {
        videoRef.current?.pause();
        setActiveAd(preRollAd);
        setIsAdPlaying(true);
        setAdRemainingTime(preRollAd.duration);
        setShownAdIds(prev => new Set(prev).add(`pre-${preRollAd.adId}`));
        setPreRollDone(true);
        // VAST 事件模型：impression（曝光）与 start（开播）分开上报，
        // 两者在漏斗分析里含义不同（前者可能只是加载出来，未必真的播了）
        trackAdMutation.mutate({ adId: preRollAd.adId, videoId, event: 'impression' });
        trackAdMutation.mutate({ adId: preRollAd.adId, videoId, event: 'start' });
        return;
      }
      // 没有前贴片（或已播过）也要把闸门置为 done，否则中插永远不会进入判定
      setPreRollDone(true);
    }

    // ---- 阶段 2：中插 ----
    // 触发窗口设计成 [triggerAt, triggerAt + 5)，而不是精确等于 triggerAt：
    // onTimeUpdate 的采样间隔不固定（约 250ms，倍速播放时跨度更大），
    // 精确相等几乎必然错过。5 秒宽容窗口保证正常顺序播放一定能命中。
    // 副作用：用户若一次拖拽跨过整个窗口，这条广告就被跳过了（有意为之的取舍）。
    // Mid-roll: trigger based on currentTime
    if (preRollDone && isPlaying && duration > 0) {
      for (const ad of ads) {
        if (ad.position !== 'mid-roll') continue;
        // key 里带上 triggerAt：同一素材可被投放在多个时间点，需要分别去重
        const key = `mid-${ad.adId}-${ad.triggerAt}`;
        if (shownAdIds.has(key)) continue;
        if (currentTime >= ad.triggerAt && currentTime < ad.triggerAt + 5) {
          videoRef.current?.pause();
          setActiveAd(ad);
          setIsAdPlaying(true);
          setAdRemainingTime(ad.duration);
          setShownAdIds(prev => new Set(prev).add(key));
          trackAdMutation.mutate({ adId: ad.adId, videoId, event: 'impression' });
          trackAdMutation.mutate({ adId: ad.adId, videoId, event: 'start' });
          return;
        }
      }
    }
  }, [currentTime, isPlaying, videoAdsQuery.data, activeAd, preRollDone, duration, shownAdIds, hlsManifestQuery.data]);

  // 广告倒计时：每秒递减 adRemainingTime，用于角标文案和「跳过」按钮的出现时机。
  //
  // 依赖数组第二项刻意写成布尔表达式 `adRemainingTime > 0` 而不是 adRemainingTime 本身：
  // 若直接依赖数值，每递减一次就会销毁并重建 interval，倒计时会被无限推迟。
  // 写成布尔值后，只在「有/无剩余时间」翻转时才重建定时器。
  //
  // 兜底职责：广告 <video> 的 onEnded 是主要的结束信号，本定时器负责处理
  // 广告素材加载失败 / 卡住 / onEnded 不触发的情况，保证正片一定能恢复。
  // Ad countdown timer
  useEffect(() => {
    if (!activeAd || adRemainingTime <= 0) return;
    const timer = setInterval(() => {
      setAdRemainingTime(prev => {
        if (prev <= 1) {
          // Ad finished
          clearInterval(timer);
          trackAdMutation.mutate({ adId: activeAd.adId, videoId, event: 'complete' });
          setActiveAd(null);
          setIsAdPlaying(false);
          // Resume main video
          // 延迟 200ms 再恢复：给 React 卸载广告覆盖层 DOM 留出一帧，
          // 否则 play() 可能在主 <video> 仍被遮挡/未就绪时被浏览器拒绝
          setTimeout(() => videoRef.current?.play(), 200);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [activeAd, adRemainingTime > 0]);

  // 续播位置定时落库：每 5 秒写一次。
  // 三个前置条件缺一不可 —— 正在播放、时长已知、当前不在放广告
  // （广告时间不该被记进正片进度，否则下次续播会跳到错误位置）。
  // Auto-save playback position every 5 seconds
  useEffect(() => {
    if (!videoId) return;

    saveIntervalRef.current = setInterval(() => {
      if (isPlaying && duration > 0 && !isAdPlaying) {
        updateResumeMutation.mutate({
          videoId,
          position: currentTime,
          duration,
        });
      }
    }, 5000);

    return () => {
      if (saveIntervalRef.current !== null) {
        clearInterval(saveIntervalRef.current);
      }
    };
  }, [videoId, isPlaying, currentTime, duration, updateResumeMutation, isAdPlaying]);

  // 关闭/刷新页面前抢救一次进度。
  // 这里不判断 isPlaying —— 暂停状态下关页面同样需要保存当前位置。
  // 注意 beforeunload 中的异步请求不保证送达（浏览器可能直接杀掉页面），
  // 因此它只是尽力而为的补充，主力仍是上面的定时保存与 onPause 保存。
  // Save on before unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (videoId && duration > 0) {
        updateResumeMutation.mutate({
          videoId,
          position: currentTime,
          duration,
        });
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [videoId, currentTime, duration, updateResumeMutation]);

  // 全屏状态同步。
  // 两个监听各司其职：
  //   fullscreenchange —— 用户按 F11/ESC 或通过浏览器 UI 退出真全屏时，把 state 拉回一致；
  //   keydown(Escape)  —— 处理"伪全屏"（Fullscreen API 被拒绝时的 fixed 定位方案）。
  //     伪全屏下浏览器不会派发 fullscreenchange，ESC 也不会自动退出，只能手动接管。
  //     条件里的 `!document.fullscreenElement` 正是用来区分「伪全屏」与「真全屏」。
  // Handle fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen && !document.fullscreenElement) {
        setIsFullscreen(false);
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  // 控制条自动隐藏。
  // 只有「播放中 + 全屏」两个条件同时满足才隐藏 —— 窗口模式下页面本来就有其它内容，
  // 藏起控制条没有收益反而增加误操作；3000ms 是与主流播放器（YouTube 约 3s）对齐的经验值。
  // Auto-hide controls
  useEffect(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }

    if (isPlaying && isFullscreen) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    } else {
      // 暂停或退出全屏时立即恢复显示
      setShowControls(true);
    }

    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, [isPlaying, isFullscreen]);

  /** 鼠标在播放器上移动：立即显形控制条并重置 3 秒隐藏倒计时（与上面的 effect 同逻辑）。 */
  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }

    if (isPlaying && isFullscreen) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  };

  /**
   * 播放/暂停切换。
   *
   * 关键在于对 play() 返回的 Promise 做失败处理：
   * 现代浏览器的**自动播放策略**会以 `NotAllowedError` 拒绝带声音的播放请求
   * （常见于用户尚未与页面交互、或从其它页面自动跳转进来时）。
   * 兜底方案是静音后重试 —— 静音播放不受该策略限制，用户随后可手动开声音。
   * 若二次尝试仍失败则彻底放弃，把 isPlaying 复位以显示中央播放按钮。
   *
   * 副作用：可能修改 DOM 的 muted 属性并同步 isMuted state。
   */
  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
        setIsPlaying(false);
      } else {
        const playPromise = videoRef.current.play();
        // 老浏览器的 play() 返回 undefined（非 Promise），需要判空
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              setIsPlaying(true);
            })
            .catch((err) => {
              if (err.name === "NotAllowedError" && videoRef.current) {
                // 自动播放被拦截 → 降级为静音播放
                videoRef.current.muted = true;
                setIsMuted(true);
                videoRef.current.play().then(() => {
                  setIsPlaying(true);
                }).catch(() => {
                  setIsPlaying(false);
                });
              } else {
                // 其它错误（源不可达、解码失败等）只记日志，不打断 UI
                console.warn("Video play failed:", err.message);
                setIsPlaying(false);
              }
            });
        }
      }
    }
  };

  /** 静音切换。直接改 DOM 的 muted 属性（非受控），再同步 state 用于图标渲染。 */
  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  /**
   * 全屏切换（四级降级）。
   *
   * 进入全屏的尝试顺序：
   *   1. 标准 `Element.requestFullscreen()`（成功后由 fullscreenchange 事件回填 state）
   *   2. `webkitRequestFullscreen()`（旧 Safari / 部分 WebKit 内核）
   *   3. `video.webkitEnterFullscreen()`（iOS Safari 只允许 <video> 元素自身全屏，
   *      不支持容器全屏 —— 代价是自定义控制条会被系统原生控制条取代）
   *   4. 「伪全屏」：以上全被拒（常见于被 iframe 嵌套且缺少 allow="fullscreen" 时），
   *      只把 isFullscreen 置 true，由 JSX 用 `fixed inset-0 z-[9999]` 铺满视口。
   *
   * 退出时同样区分两种情况：真全屏调 exitFullscreen()，伪全屏直接改 state。
   *
   * 三处 catch 都刻意吞掉异常 —— 全屏失败不应该让整个播放器崩掉。
   */
  const toggleFullscreen = async () => {
    if (!containerRef.current) return;

    if (!isFullscreen) {
      try {
        if (containerRef.current.requestFullscreen) {
          await containerRef.current.requestFullscreen();
          return;
        } else if ((containerRef.current as any).webkitRequestFullscreen) {
          await (containerRef.current as any).webkitRequestFullscreen();
          return;
        }
      } catch {
        // 容器全屏被拒 → 退而求其次让 <video> 自身进入 iOS 原生全屏
        try {
          if (videoRef.current && (videoRef.current as any).webkitEnterFullscreen) {
            (videoRef.current as any).webkitEnterFullscreen();
            return;
          }
        } catch {
          // Also blocked
        }
      }
      // 走到这里说明原生全屏完全不可用，启用 CSS 伪全屏
      setIsFullscreen(true);
    } else {
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          // ignore
        }
      } else {
        // 伪全屏没有对应的 exit API，直接复位 state 即可
        setIsFullscreen(false);
      }
    }
  };

  /** 音量滑块回调。range 值域 0~1，与 HTMLMediaElement.volume 语义直接对应。 */
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
    }
  };

  /** 倍速切换。可选档位在 JSX 中写死为 [0.5, 1, 1.5, 2]。 */
  const handlePlaybackRateChange = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
  };

  /**
   * 清晰度切换。
   * @param levelIndex hlsLevels 中的下标；传 -1 表示交还给 hls.js 的 ABR 自动选档。
   * 仅在 hls.js 分支下有效（Safari 原生 HLS 与 MP4 直链下 hlsLevels 为空，菜单不会渲染）。
   */
  const handleQualityChange = (levelIndex: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex; // -1 = auto
      setCurrentLevel(levelIndex);
    }
    setShowQualityMenu(false);
  };

  /** 秒数 → `H:MM:SS` 或 `M:SS`。NaN/0 统一返回 "0:00"（metadata 未加载完时会出现 NaN）。 */
  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return "0:00";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
        .toString()
        .padStart(2, "0")}`;
    }
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  };

  /**
   * 分辨率高度 → 展示用档位名。
   * 用 `>=` 区间而非精确相等：转码产物的实际高度常有偏差（如 1088、718），
   * 直接显示会很难看，就近归档到标准档位。
   */
  const getQualityLabel = (height: number) => {
    if (height >= 1080) return "1080p";
    if (height >= 720) return "720p";
    if (height >= 480) return "480p";
    if (height >= 360) return "360p";
    return `${height}p`;
  };

  /**
   * 把鼠标事件的横坐标换算成视频时间点。
   *
   * `getBoundingClientRect()` 每次实时读取而非缓存：进度条在 hover 时会从 h-2 变 h-3，
   * 全屏切换也会改变宽度，缓存 rect 会导致定位偏移。
   * Math.max/min 把坐标钳制在轨道内 —— 拖拽时鼠标经常被拖出元素范围。
   */
  // Calculate seek position from mouse event
  const getSeekTime = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!seekBarRef.current || duration <= 0) return 0;
    const rect = seekBarRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    return (x / rect.width) * duration;
  }, [duration]);

  /**
   * 按下进度条：进入拖拽态。
   *
   * 先记下 wasPlayingRef 再暂停 —— 拖拽期间保持播放会让 currentTime 与鼠标位置打架；
   * 松手时（全局 mouseup）再根据这个标记决定是否恢复播放。
   * `e.preventDefault()` 阻止浏览器把拖拽解释成文本选中/图片拖动。
   * 广告播放期间直接早退，实现「广告不可跳过」。
   */
  // Seekbar mouse events
  const handleSeekMouseDown = useCallback((e: React.MouseEvent) => {
    if (isAdPlaying) return; // Disable seeking during ads
    e.preventDefault();
    const time = getSeekTime(e);
    setIsDragging(true);
    setDragTime(time);
    wasPlayingRef.current = isPlaying;

    if (videoRef.current && isPlaying) {
      videoRef.current.pause();
    }
  }, [getSeekTime, isPlaying, isAdPlaying]);

  /**
   * 在进度条上移动鼠标：更新悬停时间气泡；若正在拖拽，同时做实时 seek 预览。
   * 这里重复了 getSeekTime 的换算逻辑，是因为还需要拿到像素值 x 来定位气泡。
   */
  const handleSeekMouseMove = useCallback((e: React.MouseEvent) => {
    if (!seekBarRef.current) return;
    const rect = seekBarRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const time = (x / rect.width) * duration;
    setHoverTime(time);
    setHoverX(x);

    if (isDragging) {
      setDragTime(time);
      if (videoRef.current) {
        videoRef.current.currentTime = time;
      }
    }
  }, [isDragging, duration]);

  /** 鼠标离开进度条：隐藏悬停时间气泡（拖拽态的气泡由 isDragging 单独控制，不受影响）。 */
  const handleSeekMouseLeave = useCallback(() => {
    setHoverTime(null);
  }, []);

  // ==========================================================================
  // 拖拽期间的全局鼠标监听
  // ==========================================================================
  // 为什么必须挂在 window 而不是进度条元素上：用户拖拽时鼠标经常滑出进度条
  // （甚至滑出播放器），此时元素级的 mousemove/mouseup 收不到事件，会导致
  // 进度条「粘」在拖拽态无法松手。挂 window 才能捕获全屏范围内的抬起动作。
  //
  // 只在 isDragging 为 true 时注册，拖拽结束即注销 —— 避免常驻全局监听。
  // Global mouse up for drag end
  useEffect(() => {
    if (!isDragging) return;

    // 松手：定稿最终时间点，并按拖拽前的播放状态决定是否续播
    const handleMouseUp = (e: MouseEvent) => {
      const time = getSeekTime(e);
      setIsDragging(false);
      setCurrentTime(time);
      if (videoRef.current) {
        videoRef.current.currentTime = time;
        if (wasPlayingRef.current) {
          // 吞掉 play() 的 rejection：seek 后立刻播放偶尔会被自动播放策略拒绝，
          // 此时保持暂停即可，不必打扰用户
          videoRef.current.play().catch(() => {});
        }
      }
    };

    // 与元素级 handleSeekMouseMove 职责重叠，但这里负责鼠标已移出进度条的场景
    const handleMouseMove = (e: MouseEvent) => {
      if (!seekBarRef.current) return;
      const rect = seekBarRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const time = (x / rect.width) * duration;
      setDragTime(time);
      if (videoRef.current) {
        videoRef.current.currentTime = time;
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, duration, getSeekTime]);

  /**
   * 单击进度条跳转（区别于拖拽）。
   * isDragging 早退是为了避免与 mouseup 的定稿逻辑重复 seek —— 一次拖拽结束时
   * 浏览器同样会派发 click 事件。
   */
  // Click on seekbar (not drag)
  const handleSeekClick = useCallback((e: React.MouseEvent) => {
    if (isDragging || isAdPlaying) return;
    const time = getSeekTime(e);
    setCurrentTime(time);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  }, [isDragging, getSeekTime, isAdPlaying]);

  // ===== 渲染派生值 =====
  // 拖拽时用 dragTime 覆盖 currentTime：<video> 的 timeupdate 有延迟，
  // 直接渲染 currentTime 会让进度条追不上鼠标、产生"橡皮筋"回弹感。
  const displayTime = isDragging ? dragTime : currentTime;
  const progressPercent = duration > 0 ? (displayTime / duration) * 100 : 0;
  // 缓冲条只取最后一个 buffered range 的末端（见 onTimeUpdate），
  // seek 造成的多段不连续缓冲区在此被简化为单条，属于可接受的视觉近似
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    // 容器同时承担「真全屏容器」与「伪全屏铺满层」两个角色：
    // `isFullscreen && !document.fullscreenElement` 恰好等价于「伪全屏」，
    // 此时用 fixed 铺满视口并去掉 16:9 约束；其余情况维持 16:9 的响应式卡片。
    <div
      ref={containerRef}
      className={`bg-black overflow-hidden group ${
        isFullscreen && !document.fullscreenElement
          ? "fixed inset-0 z-[9999] w-screen h-screen rounded-none"
          : "w-full rounded-lg"
      }`}
      style={isFullscreen && !document.fullscreenElement ? {} : { aspectRatio: "16 / 9" }}
      onMouseMove={handleMouseMove}
    >
      <div className="relative w-full h-full bg-black">
        {/* 主视频元素。src 不通过 JSX 设置，而由上面的 HLS 初始化 effect 直接写 DOM，
            因为 hls.js 需要接管 MSE，React 受控的 src 会与之冲突。 */}
        <video
          ref={videoRef}
          poster={thumbnailUrl}
          className="w-full h-full object-contain"
          onPlay={() => setIsPlaying(true)}
          onPause={() => {
            setIsPlaying(false);
            // 暂停时补存一次续播位置（覆盖 5 秒定时器的空窗期）。
            // 延迟 100ms 是为了读到 pause 完成后稳定的 currentTime；
            // 优先读 DOM 实时值而非 state，后者可能还没被 timeupdate 刷新。
            if (videoId && duration > 0 && !isAdPlaying) {
              setTimeout(() => {
                updateResumeMutation.mutate({
                  videoId,
                  position: videoRef.current?.currentTime || currentTime,
                  duration,
                });
              }, 100);
            }
          }}
          onTimeUpdate={(e) => {
            // 拖拽期间不回写 currentTime，否则会与 dragTime 互相覆盖导致抖动
            if (!isDragging) {
              setCurrentTime(e.currentTarget.currentTime);
            }
            const video = e.currentTarget;
            // buffered 是一组不连续区间（seek 会产生多段）。这里只取最后一段的末端，
            // 用单条灰色进度近似表达"已缓冲到哪"，实现简单且视觉上够用。
            if (video.buffered.length > 0) {
              setBuffered(video.buffered.end(video.buffered.length - 1));
            }
          }}
          // 时长要等 metadata 就绪才可用；它同时是广告插入点计算的前置条件
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        />

        {/* Ad Overlay - Direct Mode */}
        {/* 覆盖层广告（仅 direct 模式）：z-40 盖住主视频与中央播放按钮，
            但低于画质菜单的 z-50。整块 DOM 随 activeAd 挂载/卸载。 */}
        {isAdPlaying && activeAd && (
          <div className="absolute inset-0 z-40 bg-black flex flex-col">
            {/* Ad Video */}
            <div className="flex-1 relative">
              <video
                ref={(el) => { adVideoRef.current = el; }}
                src={activeAd.videoUrl}
                className="w-full h-full object-contain"
                autoPlay
                // 沿用主视频的静音状态：若主视频因自动播放策略被迫静音，
                // 广告也必须静音，否则同样会被浏览器拦截而放不出来
                muted={isMuted}
                // playsInline 必需：否则 iOS Safari 会强制把广告拉到系统全屏播放器
                playsInline
                // 广告自然播完 —— 这是正常路径；倒计时 effect 只是兜底
                onEnded={() => {
                  trackAdMutation.mutate({ adId: activeAd.adId, videoId, event: 'complete' });
                  setActiveAd(null);
                  setIsAdPlaying(false);
                  setAdRemainingTime(0);
                  // 同上：等覆盖层卸载后再恢复主视频（200ms 经验值）
                  setTimeout(() => videoRef.current?.play(), 200);
                }}
              />
              {/* Ad Badge */}
              <div className="absolute top-4 right-4 bg-yellow-500/90 text-black text-xs font-bold px-3 py-1.5 rounded-md">
                広告 {adRemainingTime > 0 ? `(${Math.ceil(adRemainingTime)}秒)` : ""}
              </div>
              {/* Ad Click URL */}
              {activeAd.clickUrl && (
                <a
                  href={activeAd.clickUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="absolute bottom-16 left-4 bg-purple-600/90 hover:bg-purple-500 text-white text-sm px-4 py-2 rounded-md flex items-center gap-2 transition-colors"
                  onClick={() => trackAdMutation.mutate({ adId: activeAd.adId, videoId, event: 'click' })}
                >
                  <ExternalLink className="w-4 h-4" />
                  詳細を見る
                </a>
              )}
              {/* Skip button (after 5 seconds) */}
              {/* 「跳过广告」按钮的出现时机：剩余时间 <= 总时长 - 5，
                  即已播满 5 秒。5 秒是行业惯例（YouTube 亦为 5s）的免跳过保护期，
                  保证广告主至少拿到一次有效曝光。
                  注意：跳过与完播上报的都是 complete 事件，两者在统计上无法区分。 */}
              {adRemainingTime > 0 && adRemainingTime <= (activeAd.duration - 5) && (
                <button
                  className="absolute bottom-16 right-4 bg-white/20 hover:bg-white/30 text-white text-sm px-4 py-2 rounded-md transition-colors"
                  onClick={() => {
                    trackAdMutation.mutate({ adId: activeAd.adId, videoId, event: 'complete' });
                    setActiveAd(null);
                    setIsAdPlaying(false);
                    setAdRemainingTime(0);
                    setTimeout(() => videoRef.current?.play(), 200);
                  }}
                >
                  広告をスキップ
                </button>
              )}
            </div>
          </div>
        )}

        {/* HLS-mode Ad Badge (when no activeAd overlay) */}
        {/* SSAI 模式下广告已被拼进正片流，没有覆盖层可挂，只能单独渲染一个角标提示用户。
            此时 isAdPlaying 来自 FRAG_CHANGED 里读到的 EXT-X-CUE-OUT 标记。 */}
        {isAdPlaying && !activeAd && (
          <div className="absolute top-4 right-4 bg-yellow-500/90 text-black text-xs font-bold px-3 py-1.5 rounded-md z-30">
            広告 {adRemainingTime > 0 ? `(${Math.ceil(adRemainingTime)}秒)` : ""}
          </div>
        )}

        {/* Center Play Button */}
        {/* 中央大播放按钮：暂停时铺满整个播放区域充当点击热区。
            广告播放期间必须隐藏，否则用户点它会让主视频在广告背后偷偷开播。 */}
        {!isPlaying && !isAdPlaying && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/50 transition-colors cursor-pointer group/play"
            onClick={togglePlay}
          >
            <Play className="w-20 h-20 text-white opacity-80 group-hover/play:opacity-100 transition-opacity" />
          </div>
        )}

        {/* Controls Overlay */}
        <div
          className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-4 pb-4 pt-8 transition-opacity ${
            showControls ? "opacity-100" : "opacity-0"
          }`}
        >
          {/* Custom Seekbar */}
          {/* 自绘进度条由四层叠加而成（从下到上）：
              轨道底色 → 缓冲进度(灰) → 播放进度(紫/广告时黄) → 拖拽 thumb。
              后三层都加了 pointer-events-none，确保鼠标事件全部落到轨道容器上，
              否则拖拽经过它们时会丢事件。 */}
          <div className="mb-3 relative">
            {/* Hover Time Tooltip */}
            {hoverTime !== null && !isDragging && (
              <div
                className="absolute -top-8 bg-black/90 text-white text-xs px-2 py-1 rounded pointer-events-none transform -translate-x-1/2 z-20"
                style={{ left: hoverX }}
              >
                {formatTime(hoverTime)}
              </div>
            )}
            {/* Drag Time Tooltip */}
            {isDragging && seekBarRef.current && (
              <div
                className="absolute -top-8 bg-purple-600 text-white text-xs px-2 py-1 rounded pointer-events-none transform -translate-x-1/2 z-20"
                style={{
                  left: `${progressPercent}%`,
                }}
              >
                {formatTime(dragTime)}
              </div>
            )}

            {/* Seekbar Track */}
            <div
              ref={seekBarRef}
              className={`relative w-full h-2 bg-slate-600/60 rounded-full group/seek hover:h-3 transition-all duration-150 ${
                isAdPlaying ? "cursor-not-allowed opacity-50" : "cursor-pointer"
              }`}
              onMouseDown={handleSeekMouseDown}
              onMouseMove={handleSeekMouseMove}
              onMouseLeave={handleSeekMouseLeave}
              onClick={handleSeekClick}
              style={{ userSelect: "none" }}
            >
              {/* Buffered Progress */}
              {/* 缓冲层：hoverTime 气泡用像素定位(hoverX)，而进度层用百分比定位，
                  因为前者要贴合鼠标、后者要随容器宽度自适应 */}
              <div
                className="absolute top-0 left-0 h-full bg-slate-400/40 rounded-full pointer-events-none"
                style={{ width: `${bufferedPercent}%` }}
              />

              {/* Played Progress */}
              {/* transition-none：进度条每秒更新数次，加过渡动画会永远追不上真实进度 */}
              <div
                className={`absolute top-0 left-0 h-full rounded-full pointer-events-none transition-none ${
                  isAdPlaying ? "bg-yellow-500" : "bg-purple-500"
                }`}
                style={{ width: `${progressPercent}%` }}
              />

              {/* Thumb */}
              <div
                className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full shadow-md pointer-events-none transition-opacity ${
                  isAdPlaying ? "bg-yellow-400" : "bg-purple-400"
                } ${
                  isDragging || hoverTime !== null ? "opacity-100" : "opacity-0 group-hover/seek:opacity-100"
                }`}
                style={{
                  left: `${progressPercent}%`,
                  transform: "translateX(-50%) translateY(-50%)",
                }}
              />
            </div>

            {/* Time Labels */}
            <div className="flex justify-between text-xs text-slate-300 mt-1.5">
              <span>{formatTime(displayTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Control Buttons */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* Play/Pause */}
              <Button
                onClick={togglePlay}
                variant="ghost"
                size="sm"
                className="text-white hover:bg-white/20"
              >
                {isPlaying ? (
                  <Pause className="w-5 h-5" />
                ) : (
                  <Play className="w-5 h-5" />
                )}
              </Button>

              {/* Volume */}
              <div className="flex items-center gap-2">
                <Button
                  onClick={toggleMute}
                  variant="ghost"
                  size="sm"
                  className="text-white hover:bg-white/20"
                >
                  {isMuted ? (
                    <VolumeX className="w-5 h-5" />
                  ) : (
                    <Volume2 className="w-5 h-5" />
                  )}
                </Button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={volume}
                  onChange={handleVolumeChange}
                  className="w-20 h-1 bg-slate-600 rounded cursor-pointer accent-purple-600"
                />
              </div>

              {/* Playback Speed */}
              <div className="flex gap-1">
                {[0.5, 1, 1.5, 2].map((rate) => (
                  <Button
                    key={rate}
                    onClick={() => handlePlaybackRateChange(rate)}
                    variant={playbackRate === rate ? "default" : "ghost"}
                    size="sm"
                    className={
                      playbackRate === rate
                        ? "bg-purple-600 text-white text-xs"
                        : "text-white hover:bg-white/20 text-xs"
                    }
                  >
                    {rate}x
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Quality Selector */}
              {/* 只有 hls.js 分支才会填充 hlsLevels，因此该菜单在
                  Safari 原生 HLS / MP4 直链下自动消失 */}
              {hlsLevels.length > 0 && (
                <div className="relative">
                  <Button
                    onClick={() => setShowQualityMenu(!showQualityMenu)}
                    variant="ghost"
                    size="sm"
                    className="text-white hover:bg-white/20 text-xs gap-1"
                  >
                    <Settings className="w-4 h-4" />
                    {currentLevel === -1 ? "自動" : getQualityLabel(hlsLevels[currentLevel]?.height || 0)}
                  </Button>

                  {showQualityMenu && (
                    <div className="absolute bottom-full right-0 mb-2 bg-black/95 border border-slate-700 rounded-lg py-1 min-w-[120px] z-50">
                      <button
                        onClick={() => handleQualityChange(-1)}
                        className={`w-full text-left px-4 py-2 text-sm hover:bg-white/10 ${
                          currentLevel === -1 ? "text-purple-400" : "text-white"
                        }`}
                      >
                        自動
                      </button>
                      {hlsLevels.map((level) => (
                        <button
                          key={level.index}
                          onClick={() => handleQualityChange(level.index)}
                          className={`w-full text-left px-4 py-2 text-sm hover:bg-white/10 ${
                            currentLevel === level.index ? "text-purple-400" : "text-white"
                          }`}
                        >
                          {getQualityLabel(level.height)}
                          <span className="text-xs text-slate-400 ml-2">
                            {Math.round(level.bitrate / 1000)}kbps
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Fullscreen */}
              <Button
                onClick={toggleFullscreen}
                variant="ghost"
                size="sm"
                className="text-white hover:bg-white/20"
              >
                {isFullscreen ? (
                  <Minimize className="w-5 h-5" />
                ) : (
                  <Maximize className="w-5 h-5" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
