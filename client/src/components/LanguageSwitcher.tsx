/**
 * LanguageSwitcher —— 语言切换下拉菜单（UI 组件层）
 *
 * ## 在架构中的位置
 * 属于**前端可复用组件层** (`client/src/components/`)，是 i18n 方案的「视图层」：
 *   - 状态层：`client/src/contexts/LanguageContext.tsx`（持有 language + 写 localStorage）
 *   - 文案表：`client/src/locales/translations.ts`（三语静态对象）
 *   - 视图层：**本文件**（唯一让用户主动切换语言的入口）
 *
 * ## 主要导出
 * - `default LanguageSwitcher`：无 props 的纯展示型组件，全部状态取自 Context。
 *
 * ## 上下游依赖
 * - 上游调用方：需要在导航栏放语言按钮的页面（通过 `useLanguage()` 间接依赖
 *   `LanguageProvider`，因此**必须**渲染在 App.tsx 的 Provider 之内，否则
 *   `useLanguage()` 会抛错）。
 * - 下游依赖：`@/contexts/LanguageContext`、shadcn 的 DropdownMenu / Button、lucide Globe 图标。
 *
 * ## 关键设计决策
 * 1. **语言清单在本文件内硬编码**而非从 translations.ts 推导。原因是 translations 的键
 *    只有语言代码（ja/zh/en），没有「日本語 / 中文 / English」这种**用母语书写的显示名**，
 *    这里必须额外维护一张映射表。代价：新增语言要同时改两个文件（见 observations）。
 * 2. 显示名刻意用**各语言自己的写法**（日本語 / 中文 / English），而不是当前界面语言的
 *    译名 —— 这样即使用户误切到看不懂的语言，也能凭母语名字切回来。
 * 3. 样式写死了深色主题配色（`text-slate-400 hover:text-white`），因为本站默认且
 *    主要使用暗色主题；在亮色主题下对比度会偏低（见 observations）。
 */
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Globe } from "lucide-react";

/**
 * 渲染一个「地球图标 + 当前语言名」的按钮，点击后展开三语选项。
 *
 * 本组件**无内部 state**：当前选中语言完全来自 `LanguageContext`，
 * 点击选项后由 Context 的 `setLanguage` 统一更新并持久化到 localStorage，
 * 整棵树随之重渲染。
 *
 * @副作用 通过 Context 间接写入 `localStorage["language"]`。
 * @throws 若未被 `LanguageProvider` 包裹，`useLanguage()` 会抛出运行时错误。
 */
export default function LanguageSwitcher() {
  const { language, setLanguage } = useLanguage();

  // `as const` 让 lang.code 的类型收窄为字面量联合 "ja"|"zh"|"en"，
  // 从而可以直接传给形参类型为 Language 的 setLanguage，无需类型断言。
  // 该数组每次渲染都会重建，但只有 3 项且不参与 memo 依赖，无需 useMemo。
  const languages = [
    { code: "ja", name: "日本語" },
    { code: "zh", name: "中文" },
    { code: "en", name: "English" },
  ] as const;

  return (
    <DropdownMenu>
      {/* asChild：让 Radix 把触发器语义(aria-expanded/焦点管理)附加到 Button 上，
          而不是再套一层 <button>，避免嵌套按钮导致的无效 HTML */}
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="text-slate-400 hover:text-white">
          <Globe className="w-4 h-4 mr-2" />
          {/* 反查当前语言的显示名；理论上必然命中，`?.` 只是防御 Context 里出现未知代码 */}
          {languages.find(l => l.code === language)?.name}
        </Button>
      </DropdownMenuTrigger>
      {/* align="end"：菜单右对齐触发器，因为该按钮通常位于导航栏最右侧，
          左对齐会让菜单溢出到视口外 */}
      <DropdownMenuContent align="end">
        {languages.map(lang => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => setLanguage(lang.code)}
            // 当前选中项用半透明紫色底高亮（品牌主色 purple-600 @ 20% 不透明度），
            // 这是纯视觉标记，未附加 aria-checked 等无障碍语义（见 observations）
            className={language === lang.code ? "bg-purple-600/20" : ""}
          >
            {lang.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
