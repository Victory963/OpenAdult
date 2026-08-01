/**
 * ============================================================================
 * client/src/components/ActressManagementUI.tsx — 女优管理 CRUD 面板（UI 组件层）
 * ============================================================================
 *
 * ## 架构定位
 * 属于**前端组件层**（client/src/components/）。是管理面板
 * `client/src/pages/ActressManagementPage.tsx` 中 `actresses` Tab 的全部内容。
 * 自包含状态、自己发请求，父组件只负责挂载。
 *
 * ## 主要导出
 * - `default ActressManagementUI` — 无 props 的女优增删改查界面（表单 + 卡片列表）
 * - （内部）`ActressFormData` — 表单字段的本地形状，字段全为 string，便于直接绑定 input
 *
 * ## 上下游依赖
 * - 上游调用方：`client/src/pages/ActressManagementPage.tsx`
 * - 下游依赖（4 个 tRPC 命名空间，跨了 V1/V2 两代路由）：
 *   - `trpc.actressManagementV2.list/create/update/delete` → server/routers/actress-management-v2.ts
 *   - `trpc.actressManagement.uploadActressFaceImage`      → server/routers/actressManagement.ts（V1）
 *   - `trpc.fileUpload.uploadFile`                          → server/file-upload.ts（写 S3）
 *
 * ## ⚠️ 关键设计决策与坑
 * 1. **人脸底库自动同步**：新建/更新女优成功后，只要有头像 URL，就**额外**调用 V1 的
 *    `uploadActressFaceImage`，让后端用 LLM 分析头像并写入 `actress_face_embeddings`，
 *    供 FaceSearchPage 的相似度检索使用。这一步是「尽力而为」的：失败只 console.warn，
 *    不回滚、不提示用户 —— 因为女优档案本身已经保存成功，不应因附属功能失败而报错。
 *    代价：**用户不知道人脸底库注册失败了**（见 observations）。
 * 2. **刻意混用 V1 与 V2 路由**：CRUD 用 V2（有 adminProcedure 中间件），
 *    人脸注册用 V1（V2 没有对应 procedure）。改动时注意两边权限模型不同。
 * 3. **图片上传走 base64 over tRPC**，不是 multipart —— 项目约定「前端不直接 fetch」，
 *    所以文件被转成 base64 塞进 JSON 请求体。这也是限制 5MB 的原因（详见 handleImageSelect）。
 * 4. **UI 文案全为日语**，面向日本站点运营者，勿改。
 */
"use client";

import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Plus, Edit2, Trash2, X, Upload, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";

/**
 * 女优表单的本地数据形状。
 *
 * 注意所有字段都是 `string`（含 `birthDate`）：便于直接双向绑定到受控 input，
 * 提交时才做转换 —— 空串转 `undefined`（表示"不设置该字段"），
 * 日期串转 `Date` 对象（superjson 会在 tRPC 传输中正确序列化 Date）。
 */
interface ActressFormData {
  name: string;
  japaneseName: string;
  chineseName: string;
  bio: string;
  profileImageUrl: string;
  birthDate: string;
}

/**
 * 女优管理面板：创建 / 编辑 / 删除女优档案，并自动同步人脸检索底库。
 *
 * 内部状态职责：
 * - `isCreating`      表单是否展开（新建与编辑共用同一张表单）
 * - `editingId`       null = 新建模式；数字 = 正在编辑该 ID 的女优。**它是区分两种模式的唯一开关**
 * - `formData`        表单各字段的受控值
 * - `imagePreview`    头像预览的 data URL（本地 FileReader 结果）或已有的远程 URL
 * - `isUploadingImage` 图片上传中标志，用于禁用按钮防止重复选择
 * - `fileInputRef`    指向隐藏的 `<input type="file">`，由自定义按钮代为触发点击
 *
 * @副作用 写数据库（女优表）、写 S3（头像文件）、触发后端 LLM 调用（人脸特征分析）
 * @权限 admin —— 写操作由 V2 路由的 `adminProcedure` 中间件拦截
 * @returns 表单卡片 + 女优卡片网格
 */
export default function ActressManagementUI() {
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState<ActressFormData>({
    name: "",
    japaneseName: "",
    chineseName: "",
    bio: "",
    profileImageUrl: "",
    birthDate: "",
  });
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Queries and mutations
  // limit: 100 —— 管理面板一次性拉全量，未做分页；女优数量超过 100 时列表会截断（见 observations）
  const actressesQuery = trpc.actressManagementV2.list.useQuery({ limit: 100 });
  const createMutation = trpc.actressManagementV2.create.useMutation();
  const updateMutation = trpc.actressManagementV2.update.useMutation();
  const deleteMutation = trpc.actressManagementV2.delete.useMutation();
  // ⚠️ 这一个来自 V1 路由：V2 没有人脸特征相关的 procedure。
  // 后端会用 LLM 分析图片并 upsert 到 actress_face_embeddings 表（有金钱与延迟成本）
  const uploadFaceImageMutation = trpc.actressManagement.uploadActressFaceImage.useMutation();

  const actresses = actressesQuery.data || [];

  // 通用文件上传 procedure（protected），负责把 base64 落到 S3 并返回可直接访问的 URL
  const uploadFileMutation = trpc.fileUpload.uploadFile.useMutation();

  /**
   * 选择头像文件后的处理：本地预览 + 上传到 S3。
   *
   * 流程分两条并行的线：
   * 1. FileReader → data URL → 立即显示预览（不等网络，体感更快）
   * 2. arrayBuffer → base64 → tRPC 上传 → 拿到远程 URL 回填进 formData
   *
   * @param e file input 的 change 事件
   * @副作用 写 S3；修改 imagePreview / formData.profileImageUrl / isUploadingImage
   */
  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file size (max 5MB)
    // 5MB 上限不是随意定的：文件要转成 base64 塞进 tRPC 的 JSON 请求体，
    // base64 会膨胀约 33%，5MB 原文件 ≈ 6.7MB 请求体，已接近 body parser 的实际承受范围。
    if (file.size > 5 * 1024 * 1024) {
      toast.error("ファイルサイズは5MB以下にしてください");
      return;
    }

    // Show preview
    // 先出预览：不等上传完成就把 data URL 显示出来，避免用户面对空白等待数秒
    const reader = new FileReader();
    reader.onload = (event) => {
      setImagePreview(event.target?.result as string);
    };
    reader.readAsDataURL(file);

    // Upload file via tRPC
    try {
      setIsUploadingImage(true);
      // Convert file to base64
      // 逐字节 reduce 拼字符串再 btoa：可读性优先的写法。
      // ⚠️ 大文件下这是 O(n) 次字符串拼接，性能较差；受上面的 5MB 限制保护才勉强可接受。
      // （另一种常见写法 String.fromCharCode(...arr) 会因参数过多而爆栈，故未采用）
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          ""
        )
      );

      const result = await uploadFileMutation.mutateAsync({
        filename: file.name,
        mimeType: file.type,
        fileData: base64,
        fileType: "image",
      });

      if (result.url) {
        setFormData((prev) => ({
          ...prev,
          profileImageUrl: result.url,
        }));
        toast.success("画像をアップロードしました");
      }
    } catch (error: any) {
      console.error("Image upload error:", error);
      toast.error(error.message || "画像のアップロードに失敗しました");
    } finally {
      setIsUploadingImage(false);
    }
  };

  /**
   * 表单提交：按 `editingId` 分派到「更新」或「创建」，随后尽力同步人脸底库。
   *
   * 校验规则：
   * - 名前（name）必填
   * - 头像**仅新建时必填**（`!editingId`）：编辑已有女优时允许保留原图不动
   *
   * 成功后统一重置表单、收起面板并 refetch 列表。
   *
   * @副作用 写数据库；可能触发后端 LLM 人脸分析（有费用）
   */
  const handleSubmit = async () => {
    if (!formData.name.trim()) {
      toast.error("名前を入力してください");
      return;
    }

    // 只在新建模式下强制要求头像；编辑时留空表示"沿用原有图片"
    if (!formData.profileImageUrl && !editingId) {
      toast.error("プロフィール画像をアップロードしてください");
      return;
    }

    try {
      if (editingId) {
        await updateMutation.mutateAsync({
          id: editingId,
          name: formData.name,
          japaneseName: formData.japaneseName || undefined,
          chineseName: formData.chineseName || undefined,
          bio: formData.bio || undefined,
          profileImageUrl: formData.profileImageUrl || undefined,
          birthDate: formData.birthDate ? new Date(formData.birthDate) : undefined,
        });
        // Auto-register face embedding if profile image exists
        // 「尽力而为」的附属步骤：档案已保存成功，人脸底库同步失败不应让整个操作报错。
        // 因此 catch 里只 warn，不 rethrow、不弹 toast（代价见文件头注释与 observations）
        if (formData.profileImageUrl) {
          try {
            await uploadFaceImageMutation.mutateAsync({
              actressId: editingId,
              imageUrl: formData.profileImageUrl,
              actressName: formData.name,
            });
          } catch (e) {
            // Face embedding registration is optional, don't block the flow
            console.warn("Face embedding update failed:", e);
          }
        }
        toast.success("女優を更新しました");
      } else {
        const result = await createMutation.mutateAsync({
          name: formData.name,
          japaneseName: formData.japaneseName || undefined,
          chineseName: formData.chineseName || undefined,
          bio: formData.bio || undefined,
          profileImageUrl: formData.profileImageUrl || undefined,
          birthDate: formData.birthDate ? new Date(formData.birthDate) : undefined,
        });
        // Auto-register face embedding for new actress
        // 与编辑分支同理，但这里必须等 create 返回后才拿得到 result.actressId，
        // 所以无法与创建请求并行发出
        if (formData.profileImageUrl && result.actressId) {
          try {
            await uploadFaceImageMutation.mutateAsync({
              actressId: result.actressId,
              imageUrl: formData.profileImageUrl,
              actressName: formData.name,
            });
          } catch (e) {
            // Face embedding registration is optional, don't block the flow
            console.warn("Face embedding creation failed:", e);
          }
        }
        toast.success("女優を作成しました");
      }

      // 成功后清空并收起表单，回到「新建模式」的初始态
      setFormData({
        name: "",
        japaneseName: "",
        chineseName: "",
        bio: "",
        profileImageUrl: "",
        birthDate: "",
      });
      setImagePreview(null);
      setEditingId(null);
      setIsCreating(false);
      // 手工 refetch 而非 utils.invalidate：本组件持有 query 句柄，直接重取更直观
      actressesQuery.refetch();
    } catch (error: any) {
      toast.error(error.message || "エラーが発生しました");
    }
  };

  /**
   * 进入编辑模式：把选中女优的数据回填进表单。
   *
   * @param actress 列表中的女优对象（此处为 any —— V2 的 list 返回类型未在前端显式标注）
   * @remarks `birthDate` 需从 Date/ISO 串裁成 `YYYY-MM-DD`，
   *          因为 `<input type="date">` 只接受这一种格式，带时间部分会导致显示为空
   */
  const handleEdit = (actress: any) => {
    setFormData({
      name: actress.name,
      japaneseName: actress.japaneseName || "",
      chineseName: actress.chineseName || "",
      bio: actress.bio || "",
      profileImageUrl: actress.profileImageUrl || "",
      birthDate: actress.birthDate ? new Date(actress.birthDate).toISOString().split("T")[0] : "",
    });
    setImagePreview(actress.profileImageUrl || null);
    setEditingId(actress.id);
    setIsCreating(true);
  };

  /**
   * 删除女优。用原生 `confirm()` 做二次确认（未使用 shadcn 的 AlertDialog，保持实现简单）。
   *
   * @param id 女优主键
   * @副作用 写数据库（删除记录，级联行为由后端决定）；成功后 refetch 列表
   */
  const handleDelete = async (id: number) => {
    if (!confirm("この女優を削除してもよろしいですか？")) return;

    try {
      await deleteMutation.mutateAsync({ id });
      toast.success("女優を削除しました");
      actressesQuery.refetch();
    } catch (error: any) {
      toast.error(error.message || "削除に失敗しました");
    }
  };

  return (
    <div className="space-y-6">
      {/* Create/Edit Form —— 新建与编辑复用同一张表单，靠 editingId 区分标题与提交行为 */}
      {isCreating && (
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-white">
              {editingId ? "女優を編集" : "新しい女優を追加"}
            </CardTitle>
            <button
              onClick={() => {
                setIsCreating(false);
                setEditingId(null);
                setFormData({
                  name: "",
                  japaneseName: "",
                  chineseName: "",
                  bio: "",
                  profileImageUrl: "",
                  birthDate: "",
                });
                setImagePreview(null);
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
                  名前 *
                </label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="例：女優A"
                  className="bg-slate-700 border-slate-600 text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  日本語名
                </label>
                <Input
                  value={formData.japaneseName}
                  onChange={(e) => setFormData({ ...formData, japaneseName: e.target.value })}
                  placeholder="例：女優A"
                  className="bg-slate-700 border-slate-600 text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  中国語名
                </label>
                <Input
                  value={formData.chineseName}
                  onChange={(e) => setFormData({ ...formData, chineseName: e.target.value })}
                  placeholder="例：女优A"
                  className="bg-slate-700 border-slate-600 text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  生年月日
                </label>
                <Input
                  type="date"
                  value={formData.birthDate}
                  onChange={(e) => setFormData({ ...formData, birthDate: e.target.value })}
                  className="bg-slate-700 border-slate-600 text-white"
                />
              </div>
            </div>

            {/* Image Upload —— 隐藏原生 file input，用 Button 代理点击以保持视觉统一 */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                プロフィール画像 *
              </label>
              <div className="space-y-2">
                {imagePreview && (
                  <div className="relative w-24 h-24 rounded-lg overflow-hidden border border-slate-600">
                    <img src={imagePreview} alt="Preview" className="w-full h-full object-cover" />
                  </div>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploadingImage}
                  className="w-full"
                >
                  {isUploadingImage ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      アップロード中...
                    </>
                  ) : (
                    <>
                      <ImageIcon className="w-4 h-4 mr-2" />
                      画像を選択
                    </>
                  )}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageSelect}
                  className="hidden"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                プロフィール
              </label>
              <textarea
                value={formData.bio}
                onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                placeholder="女優についての説明"
                rows={4}
                className="w-full bg-slate-700 border border-slate-600 text-white rounded-md p-2"
              />
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleSubmit}
                disabled={createMutation.isPending || updateMutation.isPending || isUploadingImage}
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
              {/* ⚠️ 注意：此「キャンセル」与右上角的 X 按钮行为**不一致** ——
                  这里没有重置 formData，因此再次打开表单会看到上次的残留输入
                  （见 observations，未做修改） */}
              <Button
                onClick={() => {
                  setIsCreating(false);
                  setEditingId(null);
                  setImagePreview(null);
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
          新しい女優を追加
        </Button>
      )}

      {/* Actresses List —— 三态渲染：加载中转圈 / 空列表提示 / 响应式卡片网格 */}
      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-white">女優一覧</h3>
        {actressesQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
          </div>
        ) : actresses.length === 0 ? (
          <p className="text-slate-400">女優がまだ登録されていません</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {actresses.map((actress: any) => (
              <Card key={actress.id} className="bg-slate-800 border-slate-700 overflow-hidden">
                <div className="flex">
                  {/* Image */}
                  {actress.profileImageUrl && (
                    <img
                      src={actress.profileImageUrl}
                      alt={actress.name}
                      className="w-24 h-24 object-cover"
                    />
                  )}

                  {/* Info */}
                  <div className="flex-1 p-4">
                    <h4 className="font-semibold text-white">{actress.name}</h4>
                    {actress.japaneseName && (
                      <p className="text-sm text-slate-300">{actress.japaneseName}</p>
                    )}
                    {actress.chineseName && (
                      <p className="text-sm text-slate-300">{actress.chineseName}</p>
                    )}
                    {actress.bio && (
                      <p className="text-xs text-slate-400 mt-2 line-clamp-2">{actress.bio}</p>
                    )}

                    {/* Actions */}
                    <div className="flex gap-2 mt-3">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEdit(actress)}
                        className="flex-1"
                      >
                        <Edit2 className="w-3 h-3 mr-1" />
                        編集
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDelete(actress.id)}
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
