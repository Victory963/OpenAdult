/**
 * ============================================================================
 * client/src/components/AdManagementUI.tsx — 广告素材与投放位管理面板（UI 组件层）
 * ============================================================================
 *
 * ## 架构定位
 * 属于**前端组件层**（client/src/components/）。是管理面板
 * `client/src/pages/ActressManagementPage.tsx` 中 `ads` Tab 的全部内容。
 * 自包含状态、自己发请求，父组件只负责挂载。
 *
 * 它是 SSAI 广告体系的**配置入口**（写入端）：这里配好的 ads / ad_placements
 * 最终会被 `server/routers/hls-stream.ts` 与 OpenResty 的 Lua 脚本读取，
 * 在 CDN 层把广告片段拼进 HLS manifest。也就是说，**本页面的每次保存都会直接影响线上播放**。
 *
 * ## 主要导出
 * - `default AdManagementUI` — 无 props 的三 Tab 管理界面
 * - （内部）`AdType` — 广告插入位置的联合类型，与后端 zod enum 一一对应
 *
 * ## 数据模型（两层，容易混淆）
 * - **广告素材 (ad)**        —— 「一支广告片」：名称、MP4 地址、时长、点击落地页、优先级
 * - **投放位 (placement)**   —— 「这支片子在哪儿播」：绑定到某个视频（或全站）+ 位置 + 时间点
 * 一支素材可以被多个投放位复用；删除素材会级联删掉它的投放位（后端行为）。
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/pages/ActressManagementPage.tsx`
 * - 下游依赖：`trpc.adManagement.*` → `server/routers/ad-management.ts`
 *   （该路由的鉴权走 admin-auth 的 `admin_session_id` cookie，非 OAuth 角色）
 *
 * ## ⚠️ 关键设计决策与坑
 * 1. **Select 不能有空字符串 value**（Radix 限制），因此「全站投放」用哨兵值
 *    `"global"` 表示，提交前再转成 `null`。所有 videoId 相关的 state 都是 string 而非 number。
 * 2. **mid-roll 专属字段**：`insertAtSeconds` / `midRollInterval` 只在位置为 mid-roll 时有意义，
 *    其余位置一律提交 `null`，避免脏数据影响后端拼接逻辑。
 * 3. **编辑态用「内联展开」而非弹窗**：`editingAd` / `editingPlacement` 存的是正在编辑的行 ID，
 *    同一时刻只能编辑一行。代价是需要一整套平行的 `editXxx` state（见下方状态区）。
 * 4. **UI 文案全为日语**，面向日本站点运营者，勿改。
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Trash2,
  Plus,
  BarChart3,
  Video,
  Link as LinkIcon,
  Clock,
  ToggleLeft,
  ToggleRight,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";

/**
 * 广告插入位置。与后端 `ad-management.ts` 中的 zod enum 完全一致，值不可随意改动：
 * - `pre-roll`  正片播放前
 * - `mid-roll`  正片播放中（唯一需要额外时间参数的类型）
 * - `post-roll` 正片播放后
 */
type AdType = "pre-roll" | "mid-roll" | "post-roll";

/**
 * 广告管理面板：素材 CRUD、投放位 CRUD、效果分析三合一。
 *
 * 状态量较多，按用途分四组（见下方分组注释）：
 * 1. 新建素材表单（`ad*`）
 * 2. 新建投放位表单（`placement*`）
 * 3. 内联编辑态（`editing*` + `editAd*` / `editPlacement*`）
 * 4. 当前子 Tab（`activeSubTab`）
 *
 * @副作用 全部写操作都会改数据库中的 ads / ad_placements 表，并**立即影响线上视频的广告拼接**
 * @权限 admin —— 后端每个 procedure 内部手工校验 `admin_session_id` cookie
 * @returns 三 Tab 切换 + 对应内容区
 */
export default function AdManagementUI() {
  // 用于各 mutation 成功后手动失效对应的 query 缓存
  const utils = trpc.useUtils();

  // ── 组 1：新建广告素材表单 ──────────────────────────────────────────────
  // State for new ad form
  const [showAdForm, setShowAdForm] = useState(false);
  const [adName, setAdName] = useState("");
  const [adType, setAdType] = useState<AdType>("pre-roll");
  /** 广告 MP4 地址。约定填站内代理路径（如 /manus-storage/xxx.mp4），而非外链 */
  const [adVideoUrl, setAdVideoUrl] = useState("");
  /** 点击落地页，可选；留空表示该广告不可点击 */
  const [adClickUrl, setAdClickUrl] = useState("");
  /** 广告时长（秒），默认 15 —— 行业最常见的贴片时长 */
  const [adDuration, setAdDuration] = useState(15);
  /** 优先级，数值越大越优先被选中投放；默认 0 表示普通 */
  const [adPriority, setAdPriority] = useState(0);

  // ── 组 2：新建投放位表单 ────────────────────────────────────────────────
  // State for placement form
  const [showPlacementForm, setShowPlacementForm] = useState(false);
  /** 目标视频 ID 的字符串形式；哨兵值 "global" 表示全站投放（提交时转为 null） */
  const [placementVideoId, setPlacementVideoId] = useState<string>("global");
  /** 选中的广告素材 ID（字符串，因为 Radix Select 的 value 必须是 string） */
  const [placementAdId, setPlacementAdId] = useState<string>("");
  const [placementPosition, setPlacementPosition] = useState<AdType>("pre-roll");
  /** mid-roll 专用：从视频第几秒开始插入。0 表示"只按间隔重复，不指定固定点" */
  const [placementInsertAt, setPlacementInsertAt] = useState(0);
  /** mid-roll 专用：重复间隔（秒），默认 300 = 每 5 分钟插一次；0 表示只插一次 */
  const [placementInterval, setPlacementInterval] = useState(300);

  // ── 组 3：内联编辑态 ────────────────────────────────────────────────────
  // 设计上同一时刻只允许编辑一行：editingXxx 存正在编辑的行 ID，null 表示无
  // Edit ad state
  const [editingAd, setEditingAd] = useState<number | null>(null);

  // Edit placement state
  const [editingPlacement, setEditingPlacement] = useState<number | null>(null);
  const [editPlacementPosition, setEditPlacementPosition] = useState<AdType>("pre-roll");
  const [editPlacementInsertAt, setEditPlacementInsertAt] = useState(0);
  const [editPlacementInterval, setEditPlacementInterval] = useState(0);
  const [editPlacementVideoId, setEditPlacementVideoId] = useState<string>("global");
  const [editAdName, setEditAdName] = useState("");
  const [editAdType, setEditAdType] = useState<AdType>("pre-roll");
  const [editAdVideoUrl, setEditAdVideoUrl] = useState("");
  const [editAdClickUrl, setEditAdClickUrl] = useState("");
  const [editAdDuration, setEditAdDuration] = useState(15);
  const [editAdPriority, setEditAdPriority] = useState(0);

  // ── 组 4：当前子 Tab ────────────────────────────────────────────────────
  // Active tab
  const [activeSubTab, setActiveSubTab] = useState<"ads" | "placements" | "analytics">("ads");

  // Queries
  // 四个 query 在组件挂载时全部并行发起（未按 Tab 懒加载）：
  // 数据量小，且切 Tab 时可以零等待展示，属于有意的取舍
  const adsQuery = trpc.adManagement.listAds.useQuery();
  const placementsQuery = trpc.adManagement.listPlacements.useQuery();
  const analyticsQuery = trpc.adManagement.getAnalytics.useQuery();
  /** 视频下拉列表数据源，仅用于投放位表单里选「对象动画」 */
  const videosQuery = trpc.adManagement.listVideos.useQuery();

  // Mutations
  // 统一模式：成功 → invalidate 相关 query + 关闭/重置表单 + toast 提示
  const createAdMutation = trpc.adManagement.createAd.useMutation({
    onSuccess: () => {
      utils.adManagement.listAds.invalidate();
      setShowAdForm(false);
      resetAdForm();
      toast.success("広告を作成しました");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  // 删素材要同时失效 placements：后端会级联删除引用该素材的投放位，
  // 只刷新素材列表会让投放位 Tab 显示已不存在的"幽灵配置"
  const deleteAdMutation = trpc.adManagement.deleteAd.useMutation({
    onSuccess: () => {
      utils.adManagement.listAds.invalidate();
      utils.adManagement.listPlacements.invalidate();
      toast.success("広告を削除しました");
    },
  });

  // 该 mutation 被两处复用：内联编辑表单的「更新」按钮，以及列表里的启用/停用开关
  // （开关只传 { id, isActive }，属于部分更新）
  const updateAdMutation = trpc.adManagement.updateAd.useMutation({
    onSuccess: () => {
      utils.adManagement.listAds.invalidate();
      toast.success("広告を更新しました");
    },
  });

  const createPlacementMutation = trpc.adManagement.createPlacement.useMutation({
    onSuccess: () => {
      utils.adManagement.listPlacements.invalidate();
      setShowPlacementForm(false);
      resetPlacementForm();
      toast.success("配置を作成しました");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const deletePlacementMutation = trpc.adManagement.deletePlacement.useMutation({
    onSuccess: () => {
      utils.adManagement.listPlacements.invalidate();
      toast.success("配置を削除しました");
    },
  });

  // 启用/停用开关：刻意不弹 toast —— 这是高频轻量操作，图标状态本身就是反馈
  const togglePlacementMutation = trpc.adManagement.togglePlacement.useMutation({
    onSuccess: () => {
      utils.adManagement.listPlacements.invalidate();
    },
  });

  const updatePlacementMutation = trpc.adManagement.updatePlacement.useMutation({
    onSuccess: () => {
      utils.adManagement.listPlacements.invalidate();
      setEditingPlacement(null);
      toast.success("配置を更新しました");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  /** 把新建素材表单恢复到默认值（时长回到 15 秒、优先级回到 0） */
  function resetAdForm() {
    setAdName("");
    setAdType("pre-roll");
    setAdVideoUrl("");
    setAdClickUrl("");
    setAdDuration(15);
    setAdPriority(0);
  }

  /**
   * 打开某一行的内联编辑表单，并把该行数据回填进平行的 `editAd*` state。
   *
   * @param ad 列表中的广告素材对象（any —— 前端未显式标注后端返回类型）
   * @remarks 可空字段（videoUrl/clickUrl）统一回填成空串，保证 input 始终是受控的
   */
  function startEditAd(ad: any) {
    setEditingAd(ad.id);
    setEditAdName(ad.name);
    setEditAdType(ad.type);
    setEditAdVideoUrl(ad.videoUrl || "");
    setEditAdClickUrl(ad.clickUrl || "");
    setEditAdDuration(ad.duration);
    setEditAdPriority(ad.priority);
  }

  /**
   * 提交内联编辑的广告素材。
   *
   * @副作用 写数据库（ads 表）；成功后关闭内联表单
   * @remarks 这里传了第二个参数（局部 onSuccess），会与 mutation 定义处的全局 onSuccess
   *          **同时执行**，因此成功 toast 会弹两次（见 observations，未做修改）
   */
  function handleUpdateAd() {
    if (editingAd === null) return;
    // 三个必填项：名称、素材地址、时长必须为正数（0 秒广告在拼接时会产生空片段）
    if (!editAdName || !editAdVideoUrl || editAdDuration <= 0) {
      toast.error("名前、動画URL、再生時間は必須です");
      return;
    }
    updateAdMutation.mutate({
      id: editingAd,
      name: editAdName,
      type: editAdType,
      videoUrl: editAdVideoUrl,
      clickUrl: editAdClickUrl || undefined,
      duration: editAdDuration,
      priority: editAdPriority,
    }, {
      onSuccess: () => {
        setEditingAd(null);
        toast.success("広告を更新しました");
      },
    });
  }

  /** 把新建投放位表单恢复到默认值（全站投放 / pre-roll / 5 分钟间隔） */
  function resetPlacementForm() {
    setPlacementVideoId("global");
    setPlacementAdId("");
    setPlacementPosition("pre-roll");
    setPlacementInsertAt(0);
    setPlacementInterval(300);
  }

  /**
   * 创建广告素材。
   *
   * @副作用 写数据库（ads 表）；成功后由 mutation 的 onSuccess 关闭并重置表单
   * @remarks `clickUrl` 空串转 `undefined`，让后端把它当作"未设置"而非"空链接"
   */
  function handleCreateAd() {
    if (!adName || !adVideoUrl || adDuration <= 0) {
      toast.error("名前、動画URL、再生時間は必須です");
      return;
    }
    createAdMutation.mutate({
      name: adName,
      type: adType,
      videoUrl: adVideoUrl,
      clickUrl: adClickUrl || undefined,
      duration: adDuration,
      priority: adPriority,
    });
  }

  /**
   * 创建投放位（把某支素材绑定到某个视频的某个播放位置）。
   *
   * 两处关键转换：
   * 1. `"global"` 哨兵 → `null`：后端用 videoId 为 null 表示"对全站所有视频生效"。
   *    之所以用哨兵而不是空串，是因为 Radix Select 不允许 value 为空字符串。
   * 2. 非 mid-roll 时把两个时间字段强制置 `null`：pre/post-roll 天然没有"插入时点"概念，
   *    若把表单里的残留数值一并写库，会给后端的拼接逻辑留下歧义数据。
   *
   * @副作用 写数据库（ad_placements 表），**立即影响线上 HLS 的广告拼接结果**
   */
  function handleCreatePlacement() {
    if (!placementAdId) {
      toast.error("広告を選択してください");
      return;
    }
    createPlacementMutation.mutate({
      videoId: placementVideoId === "global" ? null : parseInt(placementVideoId),
      adId: parseInt(placementAdId),
      position: placementPosition,
      insertAtSeconds: placementPosition === "mid-roll" ? placementInsertAt : null,
      midRollInterval: placementPosition === "mid-roll" ? placementInterval : null,
    });
  }

  /**
   * 把内部的 AdType 值映射成日语展示文案。
   * 传入未知值时原样返回，保证新增类型时 UI 不会显示空白。
   */
  const typeLabel = (type: string) => {
    switch (type) {
      case "pre-roll": return "プリロール";
      case "mid-roll": return "ミッドロール";
      case "post-roll": return "ポストロール";
      default: return type;
    }
  };

  return (
    <div className="space-y-6">
      {/* Sub-tabs —— 手写的 Tab 条（未用 shadcn Tabs 组件），靠 activeSubTab 控制高亮与内容 */}
      <div className="flex gap-2">
        <Button
          variant={activeSubTab === "ads" ? "default" : "outline"}
          onClick={() => setActiveSubTab("ads")}
          className={activeSubTab === "ads" ? "bg-purple-600" : ""}
          size="sm"
        >
          <Video className="w-4 h-4 mr-1" />
          広告クリエイティブ
        </Button>
        <Button
          variant={activeSubTab === "placements" ? "default" : "outline"}
          onClick={() => setActiveSubTab("placements")}
          className={activeSubTab === "placements" ? "bg-purple-600" : ""}
          size="sm"
        >
          <Clock className="w-4 h-4 mr-1" />
          配置設定
        </Button>
        <Button
          variant={activeSubTab === "analytics" ? "default" : "outline"}
          onClick={() => setActiveSubTab("analytics")}
          className={activeSubTab === "analytics" ? "bg-purple-600" : ""}
          size="sm"
        >
          <BarChart3 className="w-4 h-4 mr-1" />
          分析
        </Button>
      </div>

      {/* ══ Tab 1：广告素材（ads）—— 管理"广告片"本身 ══ */}
      {/* Ads Tab */}
      {activeSubTab === "ads" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-white">広告クリエイティブ一覧</h3>
            <Button
              onClick={() => setShowAdForm(!showAdForm)}
              size="sm"
              className="bg-purple-600 hover:bg-purple-700"
            >
              <Plus className="w-4 h-4 mr-1" />
              新規広告
            </Button>
          </div>

          {/* New Ad Form */}
          {showAdForm && (
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle className="text-white text-base">新規広告作成</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-slate-300">広告名</Label>
                    <Input
                      value={adName}
                      onChange={(e) => setAdName(e.target.value)}
                      placeholder="例: サンプル広告A"
                      className="bg-slate-700 border-slate-600 text-white"
                    />
                  </div>
                  <div>
                    <Label className="text-slate-300">タイプ</Label>
                    <Select value={adType} onValueChange={(v) => setAdType(v as AdType)}>
                      <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pre-roll">プリロール（動画前）</SelectItem>
                        <SelectItem value="mid-roll">ミッドロール（動画中）</SelectItem>
                        <SelectItem value="post-roll">ポストロール（動画後）</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-slate-300">動画URL（MP4）</Label>
                    <Input
                      value={adVideoUrl}
                      onChange={(e) => setAdVideoUrl(e.target.value)}
                      placeholder="/manus-storage/ad-video.mp4"
                      className="bg-slate-700 border-slate-600 text-white"
                    />
                  </div>
                  <div>
                    <Label className="text-slate-300">クリックURL（任意）</Label>
                    <Input
                      value={adClickUrl}
                      onChange={(e) => setAdClickUrl(e.target.value)}
                      placeholder="https://example.com/landing"
                      className="bg-slate-700 border-slate-600 text-white"
                    />
                  </div>
                  <div>
                    <Label className="text-slate-300">再生時間（秒）</Label>
                    <Input
                      type="number"
                      value={adDuration}
                      onChange={(e) => setAdDuration(parseInt(e.target.value) || 0)}
                      min={1}
                      className="bg-slate-700 border-slate-600 text-white"
                    />
                  </div>
                  <div>
                    <Label className="text-slate-300">優先度（大きいほど優先）</Label>
                    <Input
                      type="number"
                      value={adPriority}
                      onChange={(e) => setAdPriority(parseInt(e.target.value) || 0)}
                      className="bg-slate-700 border-slate-600 text-white"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={handleCreateAd}
                    disabled={createAdMutation.isPending}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    {createAdMutation.isPending ? "作成中..." : "作成"}
                  </Button>
                  <Button variant="outline" onClick={() => { setShowAdForm(false); resetAdForm(); }}>
                    キャンセル
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Ads List —— 三态：加载中 / 空列表 / 卡片列表 */}
          {adsQuery.isLoading ? (
            <div className="text-slate-400 text-center py-8">読み込み中...</div>
          ) : adsQuery.data?.length === 0 ? (
            <div className="text-slate-400 text-center py-8">広告がまだありません</div>
          ) : (
            <div className="grid gap-3">
              {adsQuery.data?.map((ad) => (
                <Card key={ad.id} className="bg-slate-800 border-slate-700">
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div
                          className={`px-2 py-1 rounded text-xs font-medium ${
                            ad.isActive ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"
                          }`}
                        >
                          {ad.isActive ? "有効" : "無効"}
                        </div>
                        <div>
                          <div className="text-white font-medium">{ad.name}</div>
                          <div className="text-slate-400 text-sm flex items-center gap-3">
                            <span>{typeLabel(ad.type)}</span>
                            <span>{ad.duration}秒</span>
                            <span className="text-slate-500">優先度: {ad.priority}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEditAd(ad)}
                          className="text-slate-400 hover:text-blue-400"
                          title="編集"
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        {/* 启用/停用开关：复用 updateAd 做部分更新，只提交 isActive 取反 */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => updateAdMutation.mutate({ id: ad.id, isActive: !ad.isActive })}
                          className="text-slate-400 hover:text-white"
                        >
                          {ad.isActive ? <ToggleRight className="w-5 h-5 text-green-400" /> : <ToggleLeft className="w-5 h-5" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (confirm("この広告を削除しますか？")) {
                              deleteAdMutation.mutate({ id: ad.id });
                            }
                          }}
                          className="text-red-400 hover:text-red-300"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    {ad.clickUrl && (
                      <div className="mt-2 text-xs text-slate-500 flex items-center gap-1">
                        <LinkIcon className="w-3 h-3" />
                        {ad.clickUrl}
                      </div>
                    )}
                    {/* Inline Edit Form —— 在被编辑的那张卡片内部展开，同一时刻只会有一张展开 */}
                    {editingAd === ad.id && (
                      <div className="mt-4 pt-4 border-t border-slate-700 space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <Label className="text-slate-300 text-xs">広告名</Label>
                            <Input
                              value={editAdName}
                              onChange={(e) => setEditAdName(e.target.value)}
                              className="bg-slate-700 border-slate-600 text-white text-sm"
                            />
                          </div>
                          <div>
                            <Label className="text-slate-300 text-xs">タイプ</Label>
                            <Select value={editAdType} onValueChange={(v) => setEditAdType(v as AdType)}>
                              <SelectTrigger className="bg-slate-700 border-slate-600 text-white text-sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="pre-roll">プリロール（動画前）</SelectItem>
                                <SelectItem value="mid-roll">ミッドロール（動画中）</SelectItem>
                                <SelectItem value="post-roll">ポストロール（動画後）</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-slate-300 text-xs">動画URL（MP4）</Label>
                            <Input
                              value={editAdVideoUrl}
                              onChange={(e) => setEditAdVideoUrl(e.target.value)}
                              className="bg-slate-700 border-slate-600 text-white text-sm"
                            />
                          </div>
                          <div>
                            <Label className="text-slate-300 text-xs">クリックURL（任意）</Label>
                            <Input
                              value={editAdClickUrl}
                              onChange={(e) => setEditAdClickUrl(e.target.value)}
                              className="bg-slate-700 border-slate-600 text-white text-sm"
                            />
                          </div>
                          <div>
                            <Label className="text-slate-300 text-xs">再生時間（秒）</Label>
                            <Input
                              type="number"
                              value={editAdDuration}
                              onChange={(e) => setEditAdDuration(parseInt(e.target.value) || 0)}
                              className="bg-slate-700 border-slate-600 text-white text-sm"
                            />
                          </div>
                          <div>
                            <Label className="text-slate-300 text-xs">優先度</Label>
                            <Input
                              type="number"
                              value={editAdPriority}
                              onChange={(e) => setEditAdPriority(parseInt(e.target.value) || 0)}
                              className="bg-slate-700 border-slate-600 text-white text-sm"
                            />
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={handleUpdateAd}
                            className="bg-purple-600 hover:bg-purple-700"
                            disabled={updateAdMutation.isPending}
                          >
                            {updateAdMutation.isPending ? "更新中..." : "更新"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingAd(null)}
                            className="border-slate-600 text-slate-300"
                          >
                            キャンセル
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══ Tab 2：投放位（placements）—— 决定"哪支素材在哪个视频的什么位置播" ══ */}
      {/* Placements Tab */}
      {activeSubTab === "placements" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-white">広告配置設定</h3>
            <Button
              onClick={() => setShowPlacementForm(!showPlacementForm)}
              size="sm"
              className="bg-purple-600 hover:bg-purple-700"
            >
              <Plus className="w-4 h-4 mr-1" />
              新規配置
            </Button>
          </div>

          {/* New Placement Form */}
          {showPlacementForm && (
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle className="text-white text-base">新規配置作成</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-slate-300">対象動画</Label>
                    <Select value={placementVideoId} onValueChange={setPlacementVideoId}>
                      <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      {/* "global" 是哨兵值（提交时转 null）；其余项的 value 必须是字符串化的视频 ID。
                          下拉里附带显示时长（秒 → 分钟取整），方便配 mid-roll 时判断插入点是否超出片长 */}
                      <SelectContent>
                        <SelectItem value="global">全動画（グローバル）</SelectItem>
                        {videosQuery.data?.map((v) => (
                          <SelectItem key={v.id} value={String(v.id)}>
                            {v.title} ({v.duration ? `${Math.floor(v.duration / 60)}分` : "不明"})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-slate-300">広告</Label>
                    <Select value={placementAdId} onValueChange={setPlacementAdId}>
                      <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                        <SelectValue placeholder="広告を選択" />
                      </SelectTrigger>
                      {/* 只列出 isActive 的素材：给投放位绑定一支已停用的广告没有意义 */}
                      <SelectContent>
                        {adsQuery.data?.filter(a => a.isActive).map((a) => (
                          <SelectItem key={a.id} value={String(a.id)}>
                            {a.name} ({typeLabel(a.type)}, {a.duration}秒)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-slate-300">挿入位置</Label>
                    <Select value={placementPosition} onValueChange={(v) => setPlacementPosition(v as AdType)}>
                      <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pre-roll">プリロール（動画前）</SelectItem>
                        <SelectItem value="mid-roll">ミッドロール（動画中）</SelectItem>
                        <SelectItem value="post-roll">ポストロール（動画後）</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {/* 仅 mid-roll 才显示两个时间参数：
                      - 挿入タイミング：固定插入时点（0 = 不指定固定点，只按间隔重复）
                      - 繰り返し間隔：每隔 N 秒重复插一次（0 = 只插一次） */}
                  {placementPosition === "mid-roll" && (
                    <>
                      <div>
                        <Label className="text-slate-300">挿入タイミング（秒）</Label>
                        <Input
                          type="number"
                          value={placementInsertAt}
                          onChange={(e) => setPlacementInsertAt(parseInt(e.target.value) || 0)}
                          placeholder="0 = 間隔指定のみ"
                          className="bg-slate-700 border-slate-600 text-white"
                        />
                      </div>
                      <div>
                        <Label className="text-slate-300">繰り返し間隔（秒, 0=1回のみ）</Label>
                        <Input
                          type="number"
                          value={placementInterval}
                          onChange={(e) => setPlacementInterval(parseInt(e.target.value) || 0)}
                          placeholder="300 = 5分ごと"
                          className="bg-slate-700 border-slate-600 text-white"
                        />
                      </div>
                    </>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={handleCreatePlacement}
                    disabled={createPlacementMutation.isPending}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    {createPlacementMutation.isPending ? "作成中..." : "作成"}
                  </Button>
                  <Button variant="outline" onClick={() => { setShowPlacementForm(false); resetPlacementForm(); }}>
                    キャンセル
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Placements List —— 后端返回的是 { placement, adName } 组合结构（已 join 过素材名），
              因此这里访问字段要走 item.placement.* 而不是 item.* */}
          {placementsQuery.isLoading ? (
            <div className="text-slate-400 text-center py-8">読み込み中...</div>
          ) : placementsQuery.data?.length === 0 ? (
            <div className="text-slate-400 text-center py-8">配置設定がまだありません</div>
          ) : (
            <div className="grid gap-3">
              {placementsQuery.data?.map((item) => (
                <Card key={item.placement.id} className="bg-slate-800 border-slate-700">
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div
                          className={`px-2 py-1 rounded text-xs font-medium ${
                            item.placement.isActive ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"
                          }`}
                        >
                          {item.placement.isActive ? "有効" : "無効"}
                        </div>
                        <div>
                          <div className="text-white font-medium">
                            {item.adName} - {typeLabel(item.placement.position)}
                          </div>
                          <div className="text-slate-400 text-sm">
                            対象: {item.placement.videoId ? `動画ID #${item.placement.videoId}` : "全動画"}
                            {item.placement.position === "mid-roll" && item.placement.midRollInterval
                              ? ` | ${item.placement.midRollInterval}秒ごと`
                              : ""}
                            {item.placement.position === "mid-roll" && item.placement.insertAtSeconds
                              ? ` | ${item.placement.insertAtSeconds}秒地点`
                              : ""}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {/* 打开内联编辑：把该行数据回填进 editPlacement* 系列 state。
                            null 的可空字段统一回填成 0 / "global"，保证 input 与 Select 始终受控 */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingPlacement(item.placement.id);
                            setEditPlacementPosition(item.placement.position as AdType);
                            setEditPlacementInsertAt(item.placement.insertAtSeconds || 0);
                            setEditPlacementInterval(item.placement.midRollInterval || 0);
                            setEditPlacementVideoId(item.placement.videoId ? String(item.placement.videoId) : "global");
                          }}
                          className="text-blue-400 hover:text-blue-300"
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            togglePlacementMutation.mutate({
                              id: item.placement.id,
                              isActive: !item.placement.isActive,
                            })
                          }
                          className="text-slate-400 hover:text-white"
                        >
                          {item.placement.isActive ? (
                            <ToggleRight className="w-5 h-5 text-green-400" />
                          ) : (
                            <ToggleLeft className="w-5 h-5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (confirm("この配置を削除しますか？")) {
                              deletePlacementMutation.mutate({ id: item.placement.id });
                            }
                          }}
                          className="text-red-400 hover:text-red-300"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    {/* Inline Placement Edit Form */}
                    {editingPlacement === item.placement.id && (
                      <div className="mt-4 pt-4 border-t border-slate-700 space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <Label className="text-slate-300 text-xs">ポジション</Label>
                            <Select value={editPlacementPosition} onValueChange={(v) => setEditPlacementPosition(v as AdType)}>
                              <SelectTrigger className="bg-slate-700 border-slate-600 text-white text-sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="pre-roll">プリロール（動画前）</SelectItem>
                                <SelectItem value="mid-roll">ミッドロール（動画中）</SelectItem>
                                <SelectItem value="post-roll">ポストロール（動画後）</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-slate-300 text-xs">対象動画</Label>
                            <Select value={editPlacementVideoId} onValueChange={setEditPlacementVideoId}>
                              <SelectTrigger className="bg-slate-700 border-slate-600 text-white text-sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="global">全動画（グローバル）</SelectItem>
                                {videosQuery.data?.map((v: any) => (
                                  <SelectItem key={v.id} value={String(v.id)}>{v.title}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {editPlacementPosition === "mid-roll" && (
                            <>
                              <div>
                                <Label className="text-slate-300 text-xs">挿入位置（秒）</Label>
                                <Input
                                  type="number"
                                  value={editPlacementInsertAt}
                                  onChange={(e) => setEditPlacementInsertAt(parseInt(e.target.value) || 0)}
                                  className="bg-slate-700 border-slate-600 text-white text-sm"
                                />
                              </div>
                              <div>
                                <Label className="text-slate-300 text-xs">繰り返し間隔（秒, 0=1回のみ）</Label>
                                <Input
                                  type="number"
                                  value={editPlacementInterval}
                                  onChange={(e) => setEditPlacementInterval(parseInt(e.target.value) || 0)}
                                  className="bg-slate-700 border-slate-600 text-white text-sm"
                                />
                              </div>
                            </>
                          )}
                        </div>
                        <div className="flex gap-2">
                          {/* 提交编辑：与 handleCreatePlacement 用同一套转换规则
                              （"global" → null；非 mid-roll → 两个时间字段置 null） */}
                          <Button
                            size="sm"
                            onClick={() => {
                              updatePlacementMutation.mutate({
                                id: item.placement.id,
                                position: editPlacementPosition,
                                videoId: editPlacementVideoId === "global" ? null : parseInt(editPlacementVideoId),
                                insertAtSeconds: editPlacementPosition === "mid-roll" ? editPlacementInsertAt : null,
                                midRollInterval: editPlacementPosition === "mid-roll" ? editPlacementInterval : null,
                              });
                            }}
                            className="bg-purple-600 hover:bg-purple-700"
                            disabled={updatePlacementMutation.isPending}
                          >
                            {updatePlacementMutation.isPending ? "更新中..." : "更新"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingPlacement(null)}
                            className="border-slate-600 text-slate-300"
                          >
                            キャンセル
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══ Tab 3：效果分析 —— 只读报表，数据来自 ad_impressions 的聚合 ══ */}
      {/* Analytics Tab */}
      {activeSubTab === "analytics" && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-white">広告パフォーマンス</h3>

          {analyticsQuery.isLoading ? (
            <div className="text-slate-400 text-center py-8">読み込み中...</div>
          ) : analyticsQuery.data?.length === 0 ? (
            <div className="text-slate-400 text-center py-8">データがありません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700">
                    <th className="text-left py-3 px-4 text-slate-400 font-medium">広告名</th>
                    <th className="text-left py-3 px-4 text-slate-400 font-medium">タイプ</th>
                    <th className="text-right py-3 px-4 text-slate-400 font-medium">表示回数</th>
                    <th className="text-right py-3 px-4 text-slate-400 font-medium">クリック</th>
                    <th className="text-right py-3 px-4 text-slate-400 font-medium">完了</th>
                    <th className="text-right py-3 px-4 text-slate-400 font-medium">CTR</th>
                    <th className="text-right py-3 px-4 text-slate-400 font-medium">完了率</th>
                    <th className="text-center py-3 px-4 text-slate-400 font-medium">状態</th>
                  </tr>
                </thead>
                <tbody>
                  {analyticsQuery.data?.map((ad) => {
                    // CTR（点击率）与完播率都在前端计算而非后端返回：
                    // 后端只给三个原始计数（impressions / clicks / completions），前端负责展示口径。
                    // 分母为 0 或 null 时直接给 "0.00"，避免出现 NaN%。
                    // 小数位不同是刻意的：CTR 通常是个位数百分比需要 2 位精度，完播率量级大 1 位足够。
                    const ctr = ad.impressions && ad.impressions > 0
                      ? ((ad.clicks || 0) / ad.impressions * 100).toFixed(2)
                      : "0.00";
                    const completionRate = ad.impressions && ad.impressions > 0
                      ? ((ad.completions || 0) / ad.impressions * 100).toFixed(1)
                      : "0.0";
                    return (
                      <tr key={ad.id} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                        <td className="py-3 px-4 text-white">{ad.name}</td>
                        <td className="py-3 px-4 text-slate-300">{typeLabel(ad.type)}</td>
                        <td className="py-3 px-4 text-right text-slate-300">{ad.impressions?.toLocaleString() || 0}</td>
                        <td className="py-3 px-4 text-right text-slate-300">{ad.clicks?.toLocaleString() || 0}</td>
                        <td className="py-3 px-4 text-right text-slate-300">{ad.completions?.toLocaleString() || 0}</td>
                        <td className="py-3 px-4 text-right text-purple-400">{ctr}%</td>
                        <td className="py-3 px-4 text-right text-green-400">{completionRate}%</td>
                        <td className="py-3 px-4 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs ${ad.isActive ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                            {ad.isActive ? "有効" : "無効"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
