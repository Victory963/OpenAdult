/**
 * ============================================================================
 * client/src/components/VideoActressLinker.tsx — 视频×女优关联编辑器 (UI 层 / 组件)
 * ============================================================================
 *
 * 架构角色：
 *   单一职责的管理面板子组件：只负责维护 `video_actresses` 这张多对多关联表，
 *   不涉及视频本身的任何其它字段。相比 VideoManagementUI 的大表单，
 *   它是"给某个视频快速补齐出演女优"的轻量入口。
 *
 * 主要导出物：
 *   - default VideoActressLinker(props: VideoActressLinkerProps)
 *
 * 上下游依赖：
 *   ← 管理面板中需要为单个视频挂女优的场景
 *   → trpc.videos.getActresses  取全量女优列表（**V1 路由**，注意不是 actressManagementV2）
 *   → trpc.videos.update        提交 { videoId, actressIds } 覆盖式更新关联
 *
 * 交互模型（全量覆盖，非增量）：
 *   本地维护 selectedActresses 数组 → 点保存时把整个数组提交给 videos.update，
 *   服务端按"先删后插"的方式重建该视频的关联。因此**必须一次性提交完整名单**，
 *   漏选等于删除。
 *
 * ⚠️ 已知偏差（不在本次注释任务的修改范围内，仅记录）：
 *   - `handleAISearch` 名为「AI 检索」，实际只做本地 `String.includes` 子串匹配，
 *     没有调用任何 LLM 或 faceSearch 接口。UI 文案「AI検索で女優を追加」与实现不符。
 *   - 组件挂载时不会拉取该视频**已有的**女优关联，selectedActresses 始终从空开始。
 *     若用户只想追加一人就保存，原有关联会被覆盖清空。
 */

import React, { useState, useEffect } from "react";
import { Search, Plus, X, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/**
 * @property videoId    目标视频 ID，直接作为 videos.update 的入参
 * @property videoTitle 仅用于标题展示，不参与任何逻辑
 * @property onComplete 保存成功后的回调，通常由父组件用来关闭弹窗 / 刷新列表
 */
interface VideoActressLinkerProps {
  videoId: number;
  videoTitle: string;
  onComplete?: () => void;
}

/**
 * 视频-女优关联编辑器。
 *
 * 内部状态职责：
 *   searchQuery        —— 搜索框输入，同时驱动下方「利用可能な女優」列表的实时过滤
 *   selectedActresses  —— 已选女优 ID 数组，即待提交的完整名单
 *   isSaving           —— 提交中标志，用于禁用按钮并显示 spinner
 *                         （未直接用 mutation.isPending，两者语义等价）
 */
export default function VideoActressLinker({
  videoId,
  videoTitle,
  onComplete,
}: VideoActressLinkerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedActresses, setSelectedActresses] = useState<number[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Get actresses list
  // 一次性拉全量女优（该接口无分页参数），后续的搜索与过滤全部在**前端内存**完成，
  // 因此输入时无网络请求、响应即时；代价是女优表变大后首屏 payload 会线性增长。
  const actressesQuery = trpc.videos.getActresses.useQuery();



  // Update video with actress links
  const updateVideoMutation = trpc.videos.update.useMutation();

  // Filter actresses based on search
  // 注意：这里只匹配 name，而 handleAISearch 还额外匹配 japaneseName —— 两处口径不一致，
  // 输入日文名时"検索"按钮能选中人，下方列表却可能是空的。
  const filteredActresses = actressesQuery.data?.filter((actress: any) =>
    actress.name.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  /** 加入选中名单（幂等：已存在则不重复添加）。 */
  const handleAddActress = (actressId: number) => {
    if (!selectedActresses.includes(actressId)) {
      setSelectedActresses([...selectedActresses, actressId]);
    }
  };

  /** 从选中名单移除。 */
  const handleRemoveActress = (actressId: number) => {
    setSelectedActresses(selectedActresses.filter((id) => id !== actressId));
  };

  /**
   * 「検索」按钮 / 回车触发的快捷添加。
   *
   * 实现上是**纯本地子串匹配**（名字或日文名任一命中即可），
   * 命中后自动把**排在第一位**的结果加入名单 —— 这里的"第一"只是
   * getActresses 返回顺序下的第一个匹配项，没有任何相关性排序。
   *
   * 函数声明为 async 但内部无 await，是历史遗留（原本可能规划过调 LLM）。
   * @副作用 修改 selectedActresses、弹 toast；不发起任何网络请求
   */
  const handleAISearch = async () => {
    if (!searchQuery.trim()) {
      toast.error("検索キーワードを入力してください");
      return;
    }

    // Filter actresses by name from available list
    const matchingActresses = actressesQuery.data?.filter((actress: any) =>
      actress.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      actress.japaneseName?.toLowerCase().includes(searchQuery.toLowerCase())
    ) || [];

    if (matchingActresses.length > 0) {
      // Auto-select top result
      const topActress = matchingActresses[0];
      if (topActress.id && !selectedActresses.includes(topActress.id)) {
        handleAddActress(topActress.id);
        toast.success(`${topActress.name}を追加しました`);
      }
    } else {
      toast.info("該当する女優が見つかりません");
    }
  };

  /**
   * 提交关联名单。
   *
   * @副作用 调 videos.update 重建 video_actresses 关联；成功后触发 onComplete
   * @throws 不外抛 —— 异常被捕获并转为 toast 提示
   * @remarks 前置校验要求至少选中 1 人，因此本组件**无法用于清空**某视频的全部女优关联。
   */
  const handleSave = async () => {
    if (selectedActresses.length === 0) {
      toast.error("少なくとも1人の女優を選択してください");
      return;
    }

    setIsSaving(true);
    try {
      await updateVideoMutation.mutateAsync({
        videoId,
        actressIds: selectedActresses,
      });
      toast.success("女優情報を保存しました");
      onComplete?.();
    } catch (error: any) {
      toast.error(error.message || "保存に失敗しました");
    } finally {
      // finally 保证无论成功失败都解除按钮禁用，避免面板卡死
      setIsSaving(false);
    }
  };

  return (
    <Card className="bg-slate-800 border-slate-700">
      <CardHeader>
        <CardTitle className="text-white">
          ビデオ「{videoTitle}」に女優を関連付け
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* AI Search Section */}
        {/* 搜索框一物两用：输入内容既驱动「快捷添加」按钮，
            也实时过滤下方「利用可能な女優」列表（见 filteredActresses）。 */}
        <div className="space-y-3">
          <label className="block text-sm font-medium text-slate-300">
            AI検索で女優を追加
          </label>
          <div className="flex gap-2">
            <Input
              placeholder="女優名またはキーワードを入力..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              // onKeyPress 是已废弃的 React 事件（React 17+ 起标记 deprecated），
              // 现代写法应为 onKeyDown；此处保持原状不动。
              onKeyPress={(e) => e.key === "Enter" && handleAISearch()}
              className="bg-slate-700 border-slate-600 text-white"
            />
            <Button
              onClick={handleAISearch}
              className="bg-purple-600 hover:bg-purple-700 whitespace-nowrap"
            >
              <Search className="w-4 h-4 mr-2" />
              検索
            </Button>
          </div>
        </div>

        {/* Selected Actresses */}
        <div className="space-y-3">
          <label className="block text-sm font-medium text-slate-300">
            選択済み女優 ({selectedActresses.length})
          </label>
          {selectedActresses.length === 0 ? (
            <p className="text-slate-400 text-sm">女優がまだ選択されていません</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {selectedActresses.map((actressId) => {
                // 只存 ID，渲染时再回查完整对象拿名字。
                // 这是 O(n×m) 的线性查找，但两个集合规模都很小（选中数 × 女优总数），
                // 建 Map 的收益不足以抵消复杂度。
                // 若女优列表尚未加载完，actress 为 undefined，标签会显示为空。
                const actress = actressesQuery.data?.find(
                  (a: any) => a.id === actressId
                );
                return (
                  <div
                    key={actressId}
                    className="bg-purple-600/20 border border-purple-500 rounded-full px-3 py-1 flex items-center gap-2"
                  >
                    <span className="text-white text-sm">{actress?.name}</span>
                    <button
                      onClick={() => handleRemoveActress(actressId)}
                      className="text-purple-300 hover:text-purple-100 transition"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Available Actresses List */}
        <div className="space-y-3">
          <label className="block text-sm font-medium text-slate-300">
            利用可能な女優
          </label>
          {actressesQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
            </div>
          ) : filteredActresses.length === 0 ? (
            <p className="text-slate-400 text-sm">該当する女優がありません</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-64 overflow-y-auto">
              {filteredActresses.map((actress: any) => (
                <div
                  key={actress.id}
                  className="bg-slate-700 rounded-lg p-3 flex items-center justify-between hover:bg-slate-600 transition"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">
                      {actress.name}
                    </p>
                    {actress.japaneseName && (
                      <p className="text-slate-400 text-xs truncate">
                        {actress.japaneseName}
                      </p>
                    )}
                  </div>
                  {/* 已选中的条目把「+」换成不可点击的绿色对勾 ——
                      移除操作统一收敛到上方的已选标签区，避免两处入口造成误操作 */}
                  {selectedActresses.includes(actress.id) ? (
                    <div className="ml-2 p-1 bg-green-600/20 rounded">
                      <Check className="w-4 h-4 text-green-400" />
                    </div>
                  ) : (
                    <button
                      onClick={() => handleAddActress(actress.id)}
                      className="ml-2 p-1 hover:bg-slate-500 rounded transition"
                    >
                      <Plus className="w-4 h-4 text-slate-300 hover:text-white" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 pt-4 border-t border-slate-700">
          <Button
            onClick={handleSave}
            disabled={isSaving || selectedActresses.length === 0}
            className="flex-1 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                保存中...
              </>
            ) : (
              <>
                <Check className="w-4 h-4 mr-2" />
                保存
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
