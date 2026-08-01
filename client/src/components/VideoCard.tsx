/**
 * ============================================================================
 * client/src/components/VideoCard.tsx — 视频列表卡片 (UI 层 / 展示组件)
 * ============================================================================
 *
 * 架构角色：
 *   纯展示组件，列表页的最小渲染单元。不发起任何 tRPC 请求，全部数据由父级
 *   通过 props 注入 —— 因为列表页一次可能渲染上百张卡片，卡片内自取数据会引发
 *   请求风暴。
 *
 * 主要导出物：
 *   - default VideoCard(props: VideoCardProps)
 *
 * 上下游依赖：
 *   ← VideosPage / VideosPageV2 / SearchResultsPage / Home 等列表型页面
 *   → @/lib/videoUrl 的 resolvePreviewUrl（把 multi-chunk: 哨兵值转成可播放地址）
 *   → wouter 的 <Link>，整张卡片是一个跳转到 /video/:id 的链接
 *
 * 两项针对「列表页大量卡片」的性能设计（本文件的核心复杂度来源）：
 *   1. **IntersectionObserver 懒加载**：卡片进入视口（含 200px 预读边距）前
 *      不渲染任何 <img>/<video>，避免首屏并发几百个媒体请求打爆浏览器连接池。
 *      触发一次后立即 unobserve —— 只需要"是否曾经可见"，无需持续追踪。
 *   2. **悬停预览的双 <video> 结构**：
 *      - 静态层：preload="metadata"，仅用于抓首帧当封面（thumbnailUrl 缺失时的兜底）
 *      - 播放层：preload="none"，只有真正 hover 时才赋 src 并加载
 *      两层用 opacity 交叉淡入淡出，避免切换时闪黑屏。
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Film, Play, Loader2 } from 'lucide-react';
import { Link } from 'wouter';
import { resolvePreviewUrl } from '@/lib/videoUrl';

/**
 * VideoCard 的 props 契约。所有字段均由列表接口（videos.list / videosV2.list）直出。
 *
 * @property id           videos 表主键。既是跳转路由参数，也是 resolvePreviewUrl 解析
 *                        multi-chunk 分片视频所必需的。
 * @property title        标题，最多显示两行（line-clamp-2）。
 * @property thumbnailUrl 封面图 URL。为空时退化为「用预览视频首帧当封面」。
 * @property previewUrl   预览视频地址，可能是 `multi-chunk:` 哨兵值。为空则无悬停预览。
 * @property duration     时长（秒）。<=0 时不渲染时长角标。
 * @property category     分类名，渲染为右上角紫色角标。
 * @property actresses    出演女优，仅取 name 逗号拼接，单行截断。
 * @property rating       评分。注意上游可能传来 **字符串**（MySQL DECIMAL 经序列化后
 *                        常为 string），渲染处做了 typeof 判断兼容两种类型。
 * @property views        播放次数，千分位显示；<=0 时不渲染。
 */
interface VideoCardProps {
  id: number;
  title: string;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
  duration?: number;
  category?: string;
  actresses?: Array<{ id: number; name: string }>;
  rating?: number;
  views?: number;
}

/**
 * 视频卡片组件。
 *
 * 内部状态职责：
 *   isVisible     —— 是否已进入视口（IntersectionObserver 置位，单向不可逆）。
 *                    控制媒体元素是否挂载，是懒加载的总闸门。
 *   isHovering    —— 是否处于「悬停已满 400ms」状态，控制预览播放。
 *   videoLoading  —— 预览视频请求已发出但尚未 canplay，用于显示 spinner。
 *   videoCanPlay  —— 预览视频已可播放，控制两层 <video> 的透明度交叉。
 *   videoError    —— 预览加载失败，之后永久不再尝试（防止反复 hover 反复失败刷请求）。
 */
export default function VideoCard({
  id,
  title,
  thumbnailUrl,
  previewUrl,
  duration,
  category,
  actresses,
  rating,
  views,
}: VideoCardProps) {
  const [isHovering, setIsHovering] = useState(false);
  const [videoCanPlay, setVideoCanPlay] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState(false);
  // IntersectionObserver: カードが画面内に入ったときのみ画像を読み込む
  const [isVisible, setIsVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // 悬停 400ms 后才开始预览的延迟定时器（防误触）
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 预览播满 10 秒自动停止的定时器（限流，见下方 effect）
  const previewStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolve the preview URL using the helper
  // 每次渲染都重算，但它是纯字符串运算，成本远低于 useMemo 的心智负担
  const resolvedPreviewUrl = previewUrl ? resolvePreviewUrl(previewUrl, id) : null;

  // 懒加载观察器。空依赖数组 → 只在挂载时建立一次。
  // rootMargin '200px 0px' 表示纵向提前 200px 触发：用户快速滚动时，
  // 卡片进入视口前媒体请求就已经发出，视觉上感受不到加载延迟；
  // 横向留 0 是因为列表是纵向滚动的网格，横向预读没有意义。
  // threshold: 0 → 只要有 1px 相交就算可见（配合 rootMargin 已足够激进）。
  // IntersectionObserver: カードが画面内に入ったら isVisible = true
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            // 单向状态：媒体一旦加载就没必要再卸载，继续观察纯属浪费
            observer.unobserve(el); // 一度表示されたら監視解除
          }
        });
      },
      {
        rootMargin: '200px 0px', // 画面外200pxから先読み
        threshold: 0,
      }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** 秒数 → `H:MM:SS` 或 `M:SS`；无效/零时长返回空串（调用处据此不渲染角标）。 */
  // Format duration to HH:MM:SS or MM:SS
  const formatDuration = (seconds?: number) => {
    if (!seconds || seconds <= 0) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  /**
   * 鼠标进入：延迟 400ms 再进入预览态。
   *
   * 为什么要延迟：用户在网格里移动鼠标会瞬间划过一整行卡片，若立即触发，
   * 一次移动就会同时发起十几个视频请求并立刻取消，既浪费带宽也拖慢真正想看的那张。
   * 400ms 大致是「有意停留」与「顺路划过」的分界经验值。
   */
  // Handle hover start with delay
  const handleMouseEnter = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovering(true);
    }, 400); // 400ms delay before starting preview
  }, []);

  /**
   * 鼠标离开：撤销两个待执行定时器并把预览相关状态全部复位。
   * 注意 videoError 刻意不复位 —— 失败过一次的预览源不再重试。
   */
  // Handle hover end
  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (previewStopTimeoutRef.current) {
      clearTimeout(previewStopTimeoutRef.current);
      previewStopTimeoutRef.current = null;
    }
    setIsHovering(false);
    setVideoCanPlay(false);
    setVideoLoading(false);
  }, []);

  // ==========================================================================
  // 悬停预览的播放/卸载
  // ==========================================================================
  // 这里直接操作 DOM 而非用受控的 src 属性，是为了能显式调用 load()：
  //   - 进入：赋 src → load() 触发真正的网络请求 → play()
  //   - 离开：removeAttribute('src') + load() 是**中断在途下载**的标准手法。
  //     只 pause() 的话浏览器仍会把整段预览下完，列表页会持续吃带宽。
  //
  // play() 的 rejection 一律记为 videoError（源不可达、编解码不支持、
  // 自动播放策略拦截等），之后该卡片不再尝试预览。
  // Handle video preview on hover
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isHovering && resolvedPreviewUrl && !videoError) {
      setVideoLoading(true);
      video.src = resolvedPreviewUrl;
      video.currentTime = 0;
      video.load();
      video.play().catch(() => {
        setVideoError(true);
        setVideoLoading(false);
      });

      // 10 秒硬上限：预览只是"看个大概"，长时间悬停不该把整部片子拉下来。
      // 到点后暂停并归零，同时把 videoCanPlay 置 false 让封面淡回来。
      // Stop preview after 10 seconds
      previewStopTimeoutRef.current = setTimeout(() => {
        if (video && !video.paused) {
          video.pause();
          video.currentTime = 0;
          setVideoCanPlay(false);
        }
      }, 10000);
    } else {
      video.pause();
      video.removeAttribute('src');
      video.load();
      setVideoLoading(false);
    }
  }, [isHovering, resolvedPreviewUrl, videoError]);

  // 卸载清理：列表页滚动/翻页会大量卸载卡片，若不清定时器，
  // 已销毁组件的 setState 回调会在几百毫秒后集中触发 React 警告。
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      if (previewStopTimeoutRef.current) clearTimeout(previewStopTimeoutRef.current);
    };
  }, []);

  return (
    <Link href={`/video/${id}`}>
      <div
        ref={cardRef}
        className="group cursor-pointer rounded-lg overflow-hidden bg-slate-900/50 border border-slate-800 hover:border-purple-600/70 transition-all duration-300 hover:shadow-lg hover:shadow-purple-600/10 hover:scale-[1.02]"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Video Thumbnail / Preview Container */}
        {/* 固定 16:9 容器：所有绝对定位的媒体层与角标都以它为参照，
            也保证图片未加载时不会发生布局抖动（CLS）。 */}
        <div className="relative w-full aspect-video bg-slate-800 overflow-hidden">

          {/* Thumbnail Image - IntersectionObserver遅延読み込み */}
          {/* 封面三选一（优先级从高到低）：
              1) 有封面图 → <img>
              2) 无封面图但有预览视频 → 用 <video> 抓首帧当封面
              3) 都没有（或尚未进入视口）→ 占位图标
              前两种在 hover 且预览可播时淡出，把画面让给下面的播放层。 */}
          {isVisible && thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={title}
              className={`w-full h-full object-cover absolute inset-0 transition-opacity duration-300 ${
                isHovering && videoCanPlay ? 'opacity-0' : 'opacity-100'
              }`}
              loading="lazy"
            />
          ) : isVisible && resolvedPreviewUrl ? (
            // Use a separate video element to show first frame as poster
            <video
              className={`w-full h-full object-cover absolute inset-0 transition-opacity duration-300 ${
                isHovering && videoCanPlay ? 'opacity-0' : 'opacity-100'
              }`}
              src={resolvedPreviewUrl}
              // preload="metadata" 只拉容器头部信息，不下载媒体数据，成本远低于 auto
              preload="metadata"
              muted
              playsInline
              onLoadedData={(e) => {
                // 跳到第 1 秒再取帧：绝大多数视频的第 0 帧是黑场或台标，
                // 直接当封面会让整个列表看起来一片漆黑
                const v = e.currentTarget;
                v.currentTime = 1;
              }}
            />
          ) : (
            // Fallback icon (非表示時 or サムネイルなし)
            <div className="absolute inset-0 flex items-center justify-center">
              <Film className="w-12 h-12 text-slate-600" />
            </div>
          )}

          {/* Preview Video (plays on hover) */}
          {/* 播放层。注意这里**不设 src 属性** —— src 由上面的 effect 在 hover 时
              手动写入，preload="none" 保证在此之前零网络开销。
              duration-500 的淡入比封面层的 duration-300 更慢，形成先隐后显的层叠感。 */}
          {isVisible && resolvedPreviewUrl && (
            <video
              ref={videoRef}
              className={`w-full h-full object-cover absolute inset-0 transition-opacity duration-500 ${
                isHovering && videoCanPlay ? 'opacity-100' : 'opacity-0'
              }`}
              // muted 是硬性要求：非静音的自动播放会被浏览器策略直接拒绝
              muted
              // 不循环：配合 onEnded 让画面自然淡回封面，避免无限循环持续占用解码资源
              loop={false}
              playsInline
              preload="none"
              onCanPlay={() => {
                setVideoCanPlay(true);
                setVideoLoading(false);
              }}
              onError={() => {
                setVideoError(true);
                setVideoLoading(false);
              }}
              onEnded={() => {
                setVideoCanPlay(false);
              }}
            />
          )}

          {/* Loading Indicator */}
          {isHovering && videoLoading && !videoCanPlay && !videoError && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-20">
              <Loader2 className="w-8 h-8 text-white animate-spin" />
            </div>
          )}

          {/* Duration Badge - Left Bottom */}
          {duration !== undefined && duration > 0 && (
            <div className="absolute bottom-2 left-2 bg-black/80 px-2 py-0.5 rounded text-xs font-semibold text-white z-10">
              {formatDuration(duration)}
            </div>
          )}

          {/* Category Badge - Right Top */}
          {category && (
            <div className="absolute top-2 right-2 bg-purple-600/90 px-2 py-0.5 rounded text-xs font-semibold text-white z-10">
              {category}
            </div>
          )}

          {/* Play Button Overlay - Center (shown on hover when no preview) */}
          {/* 中央播放按钮的显示条件：未悬停（此时靠 group-hover 的 opacity 控制实际可见性），
              或悬停了但预览既没在放也没在加载（即无预览源 / 预览失败）。
              目的是「预览一旦跑起来就让位给画面」。 */}
          {(!isHovering || (!videoCanPlay && !videoLoading)) && (
            <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition-all duration-300 flex items-center justify-center opacity-0 group-hover:opacity-100 z-10">
              <div className="w-12 h-12 bg-purple-600/90 rounded-full flex items-center justify-center shadow-lg">
                <Play className="w-6 h-6 text-white fill-white ml-0.5" />
              </div>
            </div>
          )}

          {/* Rating Badge - Bottom Right */}
          {/* rating 可能是 number 也可能是 string：MySQL 的 DECIMAL 列经 driver/superjson
              往返后常常变成字符串，故这里用 Number()/typeof 双重兜底再 toFixed(1)。
              直接对字符串调 .toFixed 会抛 TypeError。 */}
          {rating !== undefined && Number(rating) > 0 && (
            <div className="absolute bottom-2 right-2 bg-yellow-500/90 px-2 py-0.5 rounded text-xs font-bold text-black z-10">
              ★ {typeof rating === 'string' ? parseFloat(rating).toFixed(1) : Number(rating).toFixed(1)}
            </div>
          )}
        </div>

        {/* Video Info Section */}
        <div className="p-3 bg-slate-900/80">
          {/* Title */}
          <h4 className="text-sm font-semibold text-white line-clamp-2 mb-1 leading-tight">
            {title}
          </h4>

          {/* Actresses */}
          {actresses && actresses.length > 0 && (
            <p className="text-xs text-purple-300 truncate mb-1">
              {actresses.map((a) => a.name).join(', ')}
            </p>
          )}

          {/* Views Count */}
          {views !== undefined && views > 0 && (
            <p className="text-xs text-slate-500">
              {views.toLocaleString()} 再生
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}
