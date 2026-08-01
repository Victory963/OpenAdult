/**
 * ============================================================================
 * client/src/components/VideoManagementUI.tsx — 视频 CRUD 管理面板 (UI 层 / 组件)
 * ============================================================================
 *
 * 架构角色：
 *   管理后台的视频管理页签。与 VideoUploadForm 是互补关系：
 *     - VideoUploadForm    负责「把文件搬上来」（分片上传 + 服务端 LLM 自动生成元数据）
 *     - VideoManagementUI  负责「维护已有记录的元数据」，以及**手工登记外链视频**
 *       （直接填 videoUrl，不经过上传流程）
 *
 * 主要导出物：
 *   - default VideoManagementUI() — 无 props
 *
 * 上下游依赖：
 *   ← client/src/pages/ActressManagementPage.tsx（管理面板入口）等
 *   → trpc.videosV2.list / create / update / delete  （V2 路由，全部为 protectedProcedure）
 *   → trpc.actressManagementV2.list                   （拉女优列表供勾选关联）
 *
 * 设计说明：
 *   1. 新建与编辑**复用同一套表单**，靠 editingId 是否为 null 区分模式，
 *      提交时再分派到 create / update 两个 mutation。
 *   2. 未做分页 —— 两个列表都写死 limit: 100。这是"管理后台数据量可控"的假设，
 *      视频超过 100 条后列表会静默截断。
 *   3. 变更后用 videosQuery.refetch() 手动刷新，而非依赖 react-query 的
 *      invalidateQueries（项目里没有统一的缓存失效约定）。
 */

"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Plus, Edit2, Trash2, X, Play } from "lucide-react";
import { toast } from "sonner";

/**
 * 表单数据模型。字段与 videosV2.create/update 的 zod 输入基本一一对应，
 * 差别在于这里用**空字符串/0 代替 undefined**（受控组件不能接受 undefined），
 * 提交时再由 `|| undefined` 转回可选值。
 *
 * @property actressIds 勾选的女优 ID 数组，为空时提交 undefined（表示"不改动关联"）
 */
interface VideoFormData {
  title: string;
  description: string;
  videoUrl: string;
  thumbnailUrl: string;
  category: string;
  duration: number;
  actressIds: number[];
}

/**
 * 视频管理组件。
 *
 * 内部状态职责：
 *   isCreating —— 表单面板是否展开（新建与编辑共用，故名字略有误导）
 *   editingId  —— null = 新建模式；非 null = 编辑该 id 的视频
 *   formData   —— 受控表单的全部字段
 */
export default function VideoManagementUI() {
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState<VideoFormData>({
    title: "",
    description: "",
    videoUrl: "",
    thumbnailUrl: "",
    category: "",
    duration: 0,
    actressIds: [],
  });

  // Queries and mutations
  // limit: 100 是 videosV2.list 的 zod 上限（.max(100)），此处直接取满，
  // 意味着本面板不支持翻页，超过 100 条的视频不会显示。
  const videosQuery = trpc.videosV2.list.useQuery({ limit: 100 });
  const actressesQuery = trpc.actressManagementV2.list.useQuery({ limit: 100 });
  const createMutation = trpc.videosV2.create.useMutation();
  const updateMutation = trpc.videosV2.update.useMutation();
  const deleteMutation = trpc.videosV2.delete.useMutation();

  // 加载中 / 出错时统一退化为空数组，让渲染逻辑不必处处判空
  const videos = videosQuery.data || [];
  const actresses = actressesQuery.data || [];

  /**
   * 提交表单：按 editingId 分派到 update 或 create。
   *
   * 空字符串/0 一律转成 undefined —— 服务端 zod 的可选字段收到空串会当作
   * "要把该字段改成空"，转成 undefined 才是"不提供该字段"的语义。
   *
   * @副作用 写 videos 表（及 video_actresses 关联表）、弹 toast、重置表单、refetch 列表
   * @权限 依赖 videosV2 的 protectedProcedure —— 未登录会被服务端拒绝
   */
  const handleSubmit = async () => {
    if (!formData.title.trim() || !formData.videoUrl.trim()) {
      toast.error("タイトルとビデオURLを入力してください");
      return;
    }

    try {
      if (editingId) {
        await updateMutation.mutateAsync({
          id: editingId,
          title: formData.title,
          description: formData.description || undefined,
          videoUrl: formData.videoUrl,
          thumbnailUrl: formData.thumbnailUrl || undefined,
          category: formData.category || undefined,
          duration: formData.duration || undefined,
          actressIds: formData.actressIds.length > 0 ? formData.actressIds : undefined,
        });
        toast.success("ビデオを更新しました");
      } else {
        await createMutation.mutateAsync({
          title: formData.title,
          description: formData.description || undefined,
          videoUrl: formData.videoUrl,
          thumbnailUrl: formData.thumbnailUrl || undefined,
          category: formData.category || undefined,
          duration: formData.duration || undefined,
          actressIds: formData.actressIds.length > 0 ? formData.actressIds : undefined,
        });
        toast.success("ビデオを作成しました");
      }

      setFormData({
        title: "",
        description: "",
        videoUrl: "",
        thumbnailUrl: "",
        category: "",
        duration: 0,
        actressIds: [],
      });
      setEditingId(null);
      setIsCreating(false);
      // 手动重取列表以反映刚才的写入（未使用 react-query 的缓存失效机制）
      videosQuery.refetch();
    } catch (error: any) {
      toast.error(error.message || "エラーが発生しました");
    }
  };

  /**
   * 进入编辑模式：把列表行的数据回填进表单。
   *
   * 关键一步是 `video.actresses.map(a => a.id)` —— 列表接口返回的是女优对象数组
   * （含 name / profileImageUrl），而表单与提交接口只认 ID 数组，必须在此拍平。
   *
   * @param video videosV2.list 返回的单行（未定义强类型，故用 any）
   */
  const handleEdit = (video: any) => {
    setFormData({
      title: video.title,
      description: video.description || "",
      videoUrl: video.videoUrl,
      thumbnailUrl: video.thumbnailUrl || "",
      category: video.category || "",
      duration: video.duration || 0,
      actressIds: video.actresses?.map((a: any) => a.id) || [],
    });
    setEditingId(video.id);
    setIsCreating(true);
  };

  /**
   * 删除视频。用原生 confirm 做二次确认（管理后台，未引入确认弹窗组件）。
   * @副作用 删 videos 行及其关联；成功后 refetch 列表
   * @remarks 删除的是数据库记录，S3 上的视频对象是否一并清理由服务端决定。
   */
  const handleDelete = async (id: number) => {
    if (!confirm("このビデオを削除してもよろしいですか？")) return;

    try {
      await deleteMutation.mutateAsync({ id });
      toast.success("ビデオを削除しました");
      videosQuery.refetch();
    } catch (error: any) {
      toast.error(error.message || "削除に失敗しました");
    }
  };

  /** 女优勾选切换：已选则移除，未选则追加（不可变更新，保证 React 能感知变化）。 */
  const toggleActress = (actressId: number) => {
    setFormData((prev) => ({
      ...prev,
      actressIds: prev.actressIds.includes(actressId)
        ? prev.actressIds.filter((id) => id !== actressId)
        : [...prev.actressIds, actressId],
    }));
  };

  return (
    <div className="space-y-6">
      {/* Create/Edit Form */}
      {/* 新建与编辑共用同一份表单 DOM，标题与提交按钮文案由 editingId 决定 */}
      {isCreating && (
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-white">
              {editingId ? "ビデオを編集" : "新しいビデオを追加"}
            </CardTitle>
            <button
              onClick={() => {
                setIsCreating(false);
                setEditingId(null);
                setFormData({
                  title: "",
                  description: "",
                  videoUrl: "",
                  thumbnailUrl: "",
                  category: "",
                  duration: 0,
                  actressIds: [],
                });
              }}
              className="text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  タイトル *
                </label>
                <Input
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="ビデオのタイトル"
                  className="bg-slate-700 border-slate-600 text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  カテゴリ
                </label>
                {/* 分类选项在此**硬编码**，未与数据库中已有的 category 值联动。
                    新增分类需要同步改这里以及前台的分类筛选组件。 */}
                <select
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 text-white rounded px-3 py-2 focus:outline-none focus:border-purple-500"
                >
                  <option value="">選択してください</option>
                  <option value="中出し">中出し</option>
                  <option value="巨乳">巨乳</option>
                  <option value="人妻・主婦">人妻・主婦</option>
                  <option value="新作">新作</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  ビデオURL *
                </label>
                <Input
                  value={formData.videoUrl}
                  onChange={(e) => setFormData({ ...formData, videoUrl: e.target.value })}
                  placeholder="https://example.com/video.mp4"
                  className="bg-slate-700 border-slate-600 text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  サムネイルURL
                </label>
                <Input
                  value={formData.thumbnailUrl}
                  onChange={(e) => setFormData({ ...formData, thumbnailUrl: e.target.value })}
                  placeholder="https://example.com/thumbnail.jpg"
                  className="bg-slate-700 border-slate-600 text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  再生時間（秒）
                </label>
                {/* 时长直接影响 HLS 广告插入：hlsStream.getManifest 在 duration<=0 时
                    会降级为无广告的 direct 模式，因此这里填对值是有业务意义的。
                    `|| 0` 兜住输入框被清空时 parseInt 返回的 NaN。 */}
                <Input
                  type="number"
                  value={formData.duration}
                  onChange={(e) => setFormData({ ...formData, duration: parseInt(e.target.value) || 0 })}
                  placeholder="例：3600"
                  className="bg-slate-700 border-slate-600 text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                説明
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="ビデオについての説明"
                rows={4}
                className="w-full bg-slate-700 border border-slate-600 text-white rounded-md p-2"
              />
            </div>

            {/* Actress Selection */}
            {actresses.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  出演女優
                </label>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 max-h-48 overflow-y-auto">
                  {actresses.map((actress: any) => (
                    <label
                      key={actress.id}
                      className="flex items-center gap-2 p-2 bg-slate-700 rounded cursor-pointer hover:bg-slate-600"
                    >
                      <input
                        type="checkbox"
                        checked={formData.actressIds.includes(actress.id)}
                        onChange={() => toggleActress(actress.id)}
                        className="rounded"
                      />
                      <span className="text-sm text-slate-300">{actress.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleSubmit}
                disabled={createMutation.isPending || updateMutation.isPending}
                className="bg-purple-600 hover:bg-purple-700"
              >
                {createMutation.isPending || updateMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    保存中...
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4 mr-2" />
                    {editingId ? "更新" : "作成"}
                  </>
                )}
              </Button>
              {/* 底部「キャンセル」只关面板、清 editingId，**不重置 formData**
                  （与右上角 X 按钮的行为不同）。副作用是下次点"新しいビデオを追加"
                  会看到上一次编辑残留的内容。 */}
              <Button
                onClick={() => {
                  setIsCreating(false);
                  setEditingId(null);
                }}
                variant="outline"
              >
                キャンセル
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create Button */}
      {!isCreating && (
        <Button
          onClick={() => setIsCreating(true)}
          className="bg-purple-600 hover:bg-purple-700"
        >
          <Plus className="w-4 h-4 mr-2" />
          新しいビデオを追加
        </Button>
      )}

      {/* Videos List */}
      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-white">ビデオ一覧</h3>
        {videosQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
          </div>
        ) : videos.length === 0 ? (
          <p className="text-slate-400">ビデオがまだ登録されていません</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {videos.map((video: any) => (
              <Card key={video.id} className="bg-slate-800 border-slate-700 overflow-hidden">
                <div className="flex">
                  {/* Thumbnail */}
                  {video.thumbnailUrl && (
                    <div className="w-32 h-32 bg-slate-900 flex-shrink-0 relative">
                      <img
                        src={video.thumbnailUrl}
                        alt={video.title}
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                        <Play className="w-6 h-6 text-white" />
                      </div>
                    </div>
                  )}

                  {/* Info */}
                  <div className="flex-1 p-4 flex flex-col">
                    <h4 className="font-semibold text-white line-clamp-2">{video.title}</h4>
                    {video.category && (
                      <p className="text-xs text-slate-400 mt-1">{video.category}</p>
                    )}
                    {/* 女优标签最多展示 2 个，其余折叠成 "+N"，避免卡片高度参差不齐 */}
                    {video.actresses && video.actresses.length > 0 && (
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {video.actresses.slice(0, 2).map((actress: any) => (
                          <span key={actress.id} className="text-xs bg-purple-600/30 text-purple-300 px-2 py-1 rounded">
                            {actress.name}
                          </span>
                        ))}
                        {video.actresses.length > 2 && (
                          <span className="text-xs text-slate-400">+{video.actresses.length - 2}</span>
                        )}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-2 mt-auto pt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEdit(video)}
                        className="flex-1"
                      >
                        <Edit2 className="w-3 h-3 mr-1" />
                        編集
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDelete(video.id)}
                        className="flex-1"
                      >
                        <Trash2 className="w-3 h-3 mr-1" />
                        削除
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
