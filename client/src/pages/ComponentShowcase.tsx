/**
 * ============================================================================
 * client/src/pages/ComponentShowcase.tsx — shadcn/ui 组件总览页（UI 页面层 / 开发工具）
 * ============================================================================
 *
 * ## 在架构中的位置
 * 属于**页面层** (`client/src/pages/`)，但**不是业务页面**：它是一份「活的样式指南」
 * (living styleguide)，把 `@/components/ui/*` 下 40+ 个 shadcn 组件、主题色板、
 * 以及自研的 `AIChatBox` 全部渲染到一页上，供开发时对照挑选与验证暗/亮色主题效果。
 *
 * ## 主要导出
 * - `default ComponentsShowcase`：无 props 的单页组件。
 *   ⚠️ 注意函数名是 **ComponentsShowcase**（复数 Components），与文件名
 *   ComponentShowcase（单数）不一致，grep 时容易漏（见 observations）。
 *
 * ## 上下游依赖
 * - 上游调用方：**当前 `App.tsx` 的路由表中没有注册本页**，因此线上无法访问，
 *   属于「只在开发时临时挂路由查看」的死代码（见 observations）。
 * - 下游依赖：
 *   - `@/components/ui/*`（几乎全量 shadcn 组件）
 *   - `@/contexts/ThemeContext` 的 `useTheme()` —— 右上角主题切换按钮
 *   - `@/components/AIChatBox` —— 项目自研的聊天框组件
 *   - `date-fns` + `date-fns/locale` 的 `zhCN` —— 日期格式化与中文 locale
 *   - `sonner` —— toast 演示
 *
 * ## 关键设计决策与坑
 * 1. **全部为静态演示数据**，没有任何 tRPC 调用 —— 这页必须能在后端不可用时照常打开。
 * 2. **AI 聊天演示是假的**：用 `setTimeout` 模拟 1.5s 延迟后返回一段固定的 markdown，
 *    里面顺便把「真实场景该怎么接 tRPC mutation」写成了代码示例，兼作文档。
 * 3. **纯展示无副作用**：除了 toast 与主题切换（写 localStorage），本页不写任何数据。
 * 4. 页面结构统一为 `<section>` + `<h3>` + `<Card>` 的三层嵌套，每个 section
 *    对应一组组件，靠形如「xxx Section」的 JSX 注释分隔，便于快速跳转。
 */
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
} from "@/components/ui/menubar";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTheme } from "@/contexts/ThemeContext";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import {
  AlertCircle,
  CalendarIcon,
  Check,
  Clock,
  Moon,
  Sun,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast as sonnerToast } from "sonner";
import { AIChatBox, type Message } from "@/components/AIChatBox";

/**
 * 渲染整个组件总览页。
 *
 * 内部状态一览（每个都只服务于对应的某一个演示区块，彼此完全独立）：
 * | state              | 服务的演示区块        | 初值 / 说明                          |
 * |--------------------|-----------------------|--------------------------------------|
 * | `date`             | Calendar 区块         | 今天；单纯的日历选中项                |
 * | `datePickerDate`   | Date Time Picker      | undefined，表示"尚未选择"             |
 * | `selectedFruits`   | （无）—— **未被使用** | 空数组；Toggle 区块最终写成了非受控，这个 state 成了死代码（见 observations） |
 * | `progress`         | Progress 进度条       | 33 —— 随手取的非 0 非满值，好看清样式  |
 * | `currentPage`      | Pagination 分页       | 2 —— 故意不选第 1 页，这样「上一页/下一页」两个箭头都处于可用态 |
 * | `openCombobox`     | Searchable Dropdown   | Popover 开关                          |
 * | `selectedFramework`| Searchable Dropdown   | 选中的框架 value                      |
 * | `selectedMonth/Year`| 月/年双 Select 演示  | 空串表示未选                          |
 * | `dialogInput`      | Dialog 输入框演示     | 受控输入值                            |
 * | `dialogOpen`       | Dialog 演示           | 受控开关（因为要在提交后用代码关闭）   |
 * | `chatMessages`     | AIChatBox 演示        | 预置一条 system 消息                  |
 * | `isChatLoading`    | AIChatBox 演示        | 驱动"正在输入"态                      |
 *
 * @副作用 仅 toast 弹窗与主题切换（后者由 ThemeContext 写 localStorage）。
 */
export default function ComponentsShowcase() {
  const { theme, toggleTheme } = useTheme();
  const [date, setDate] = useState<Date | undefined>(new Date());
  const [datePickerDate, setDatePickerDate] = useState<Date>();
  const [selectedFruits, setSelectedFruits] = useState<string[]>([]);
  const [progress, setProgress] = useState(33);
  const [currentPage, setCurrentPage] = useState(2);
  const [openCombobox, setOpenCombobox] = useState(false);
  const [selectedFramework, setSelectedFramework] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [selectedYear, setSelectedYear] = useState("");
  const [dialogInput, setDialogInput] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  // AI ChatBox demo state
  // 预置一条 system 消息：AIChatBox 约定消息数组的第一条是系统提示词，
  // 它不会被渲染到聊天气泡里，只用于告诉 LLM 扮演什么角色。
  const [chatMessages, setChatMessages] = useState<Message[]>([
    { role: "system", content: "You are a helpful assistant." },
  ]);
  const [isChatLoading, setIsChatLoading] = useState(false);

  /**
   * Dialog 演示的提交处理：打日志 → 弹成功 toast → 清空输入 → 关闭弹窗。
   * 这里演示的是「受控 Dialog」的典型用法 —— 提交后需要用代码主动关窗，
   * 因此 open 必须由外部 state 持有，不能用 Radix 的非受控模式。
   */
  const handleDialogSubmit = () => {
    console.log("Dialog submitted with value:", dialogInput);
    sonnerToast.success("Submitted successfully", {
      description: `Input: ${dialogInput}`,
    });
    setDialogInput("");
    setDialogOpen(false);
  };

  /**
   * 回车提交的按键处理，重点在于 **IME（输入法）组合态判定**。
   *
   * 日文/中文用户用输入法打字时，按回车往往是「确认候选词」而非「提交表单」。
   * 若不加判断，用户刚打完假名按回车确认，表单就被提交了。
   * `e.nativeEvent.isComposing` 为 true 表示当前处于组合输入中，此时必须放行。
   * 这与项目里的 `useComposition` hook 是同一套思路的轻量版。
   */
  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleDialogSubmit();
    }
  };

  /**
   * AIChatBox 演示的发送处理：**完全是假的**，不调用任何后端。
   *
   * 流程：把用户消息追加进数组 → 置 loading → 1500ms 后追加一条固定的
   * markdown 回复 → 取消 loading。
   * 1500ms 是随手取的"像那么回事"的思考时长，无技术含义。
   *
   * 注意 `setChatMessages([...newMessages, aiResponse])` 用的是 newMessages 这个
   * 局部快照而非函数式更新，因此若用户在这 1.5 秒内又发一条消息，后到的定时器会用
   * 过期快照覆盖，丢掉中间那条（演示页无所谓，真实实现别照抄，见 observations）。
   *
   * @param content 用户输入的文本
   */
  const handleChatSend = (content: string) => {
    // Add user message
    const newMessages: Message[] = [...chatMessages, { role: "user", content }];
    setChatMessages(newMessages);

    // Simulate AI response with delay
    setIsChatLoading(true);
    setTimeout(() => {
      // 这段回复内容本身就是一份"该怎么接真实 tRPC mutation"的示例文档，
      // 同时也用来验证 AIChatBox 的 markdown + 代码块高亮渲染是否正常。
      const aiResponse: Message = {
        role: "assistant",
        content: `This is a **demo response**. In a real app, you would call a tRPC mutation here:\n\n\`\`\`typescript\nconst chatMutation = trpc.ai.chat.useMutation({\n  onSuccess: (response) => {\n    setChatMessages(prev => [...prev, {\n      role: "assistant",\n      content: response.choices[0].message.content\n    }]);\n  }\n});\n\nchatMutation.mutate({ messages: newMessages });\n\`\`\`\n\nYour message was: "${content}"`,
      };
      setChatMessages([...newMessages, aiResponse]);
      setIsChatLoading(false);
    }, 1500);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="container max-w-6xl mx-auto">
        <div className="space-y-2 justify-between flex">
          <h2 className="text-3xl font-bold tracking-tight mb-6">
            Shadcn/ui Component Library
          </h2>
          {/* 主题切换按钮：图标显示的是"点击后会切到的目标主题"
              （当前 light → 显示月亮，暗示点它变暗色），而非当前主题 */}
          <Button variant="outline" size="icon" onClick={toggleTheme}>
            {theme === "light" ? (
              <Moon className="h-5 w-5" />
            ) : (
              <Sun className="h-5 w-5" />
            )}
          </Button>
        </div>

        <div className="space-y-12">
          {/* Text Colors Section */}
          {/* 文字色板：把 index.css 里定义的所有 --foreground 类语义色变量列出来，
              切换主题时可一眼看出哪个变量在暗色下对比度不足 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Text Colors</h3>
            <Card>
              <CardContent className="pt-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">
                        Foreground (Default)
                      </p>
                      <p className="text-foreground text-lg">
                        Default text color for main content
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">
                        Muted Foreground
                      </p>
                      <p className="text-muted-foreground text-lg">
                        Muted text for secondary information
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">
                        Primary
                      </p>
                      <p className="text-primary text-lg font-medium">
                        Primary brand color text
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">
                        Secondary Foreground
                      </p>
                      <p className="text-secondary-foreground text-lg">
                        Secondary action text color
                      </p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">
                        Accent Foreground
                      </p>
                      <p className="text-accent-foreground text-lg">
                        Accent text for emphasis
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">
                        Destructive
                      </p>
                      <p className="text-destructive text-lg font-medium">
                        Error or destructive action text
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">
                        Card Foreground
                      </p>
                      <p className="text-card-foreground text-lg">
                        Text color on card backgrounds
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">
                        Popover Foreground
                      </p>
                      <p className="text-popover-foreground text-lg">
                        Text color in popovers
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Color Combinations Section */}
          {/* 背景/前景**配对**演示：Tailwind 主题约定 bg-X 必须搭配 text-X-foreground，
              这一栏就是用来验证每一对组合的对比度都可读 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Color Combinations</h3>
            <Card>
              <CardContent className="pt-6">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div className="bg-primary text-primary-foreground rounded-lg p-4">
                    <p className="font-medium mb-1">Primary</p>
                    <p className="text-sm opacity-90">
                      Primary background with foreground text
                    </p>
                  </div>
                  <div className="bg-secondary text-secondary-foreground rounded-lg p-4">
                    <p className="font-medium mb-1">Secondary</p>
                    <p className="text-sm opacity-90">
                      Secondary background with foreground text
                    </p>
                  </div>
                  <div className="bg-muted text-muted-foreground rounded-lg p-4">
                    <p className="font-medium mb-1">Muted</p>
                    <p className="text-sm opacity-90">
                      Muted background with foreground text
                    </p>
                  </div>
                  <div className="bg-accent text-accent-foreground rounded-lg p-4">
                    <p className="font-medium mb-1">Accent</p>
                    <p className="text-sm opacity-90">
                      Accent background with foreground text
                    </p>
                  </div>
                  <div className="bg-destructive text-destructive-foreground rounded-lg p-4">
                    <p className="font-medium mb-1">Destructive</p>
                    <p className="text-sm opacity-90">
                      Destructive background with foreground text
                    </p>
                  </div>
                  <div className="bg-card text-card-foreground rounded-lg p-4 border">
                    <p className="font-medium mb-1">Card</p>
                    <p className="text-sm opacity-90">
                      Card background with foreground text
                    </p>
                  </div>
                  <div className="bg-popover text-popover-foreground rounded-lg p-4 border">
                    <p className="font-medium mb-1">Popover</p>
                    <p className="text-sm opacity-90">
                      Popover background with foreground text
                    </p>
                  </div>
                  <div className="bg-background text-foreground rounded-lg p-4 border">
                    <p className="font-medium mb-1">Background</p>
                    <p className="text-sm opacity-90">
                      Default background with foreground text
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Buttons Section */}
          {/* Button 的全部 variant（6 种）与 size（default/sm/lg/icon）矩阵 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Buttons</h3>
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-wrap gap-4">
                  <Button>Default</Button>
                  <Button variant="secondary">Secondary</Button>
                  <Button variant="destructive">Destructive</Button>
                  <Button variant="outline">Outline</Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button variant="link">Link</Button>
                  <Button size="sm">Small</Button>
                  <Button size="lg">Large</Button>
                  <Button size="icon">
                    <Check className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Form Inputs Section */}
          {/* 表单控件大杂烩。前半段（Input/Textarea/Select/Checkbox/Switch/Radio/
              Slider/InputOTP）是纯 shadcn 原件；后半段三个是**组合出来的复合控件**：
              日期时间选择器、可搜索下拉、月/年双选，shadcn 本身不提供，需要自己拼。 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Form Inputs</h3>
            <Card>
              <CardContent className="pt-6 space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" placeholder="Email" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="message">Message</Label>
                  <Textarea
                    id="message"
                    placeholder="Type your message here."
                  />
                </div>
                <div className="space-y-2">
                  <Label>Select</Label>
                  <Select>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a fruit" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="apple">Apple</SelectItem>
                      <SelectItem value="banana">Banana</SelectItem>
                      <SelectItem value="orange">Orange</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="terms" />
                  <Label htmlFor="terms">Accept terms and conditions</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Switch id="airplane-mode" />
                  <Label htmlFor="airplane-mode">Airplane Mode</Label>
                </div>
                <div className="space-y-2">
                  <Label>Radio Group</Label>
                  <RadioGroup defaultValue="option-one">
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="option-one" id="option-one" />
                      <Label htmlFor="option-one">Option One</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="option-two" id="option-two" />
                      <Label htmlFor="option-two">Option Two</Label>
                    </div>
                  </RadioGroup>
                </div>
                <div className="space-y-2">
                  <Label>Slider</Label>
                  <Slider defaultValue={[50]} max={100} step={1} />
                </div>
                <div className="space-y-2">
                  <Label>Input OTP</Label>
                  <InputOTP maxLength={6}>
                    <InputOTPGroup>
                      <InputOTPSlot index={0} />
                      <InputOTPSlot index={1} />
                      <InputOTPSlot index={2} />
                      <InputOTPSlot index={3} />
                      <InputOTPSlot index={4} />
                      <InputOTPSlot index={5} />
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                <div className="space-y-2">
                  {/* 复合控件 1：日期 + 时间选择器。
                      shadcn 的 Calendar 只管日期，时间部分靠一个 <input type="time"> 补齐，
                      两者共用同一个 Date 对象作为真值来源。
                      `format(..., { locale: zhCN })` 让 "PPP" 这种本地化格式输出中文日期。 */}
                  <Label>Date Time Picker</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={`w-full justify-start text-left font-normal ${
                          !datePickerDate && "text-muted-foreground"
                        }`}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {datePickerDate ? (
                          format(datePickerDate, "PPP HH:mm", { locale: zhCN })
                        ) : (
                          <span>Select date and time</span>
                        )}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <div className="p-3 space-y-3">
                        <Calendar
                          mode="single"
                          selected={datePickerDate}
                          onSelect={setDatePickerDate}
                        />
                        <div className="border-t pt-3 space-y-2">
                          <Label className="flex items-center gap-2">
                            <Clock className="h-4 w-4" />
                            Time
                          </Label>
                          <div className="flex gap-2">
                            <Input
                              type="time"
                              value={
                                datePickerDate
                                  ? format(datePickerDate, "HH:mm")
                                  : "00:00"
                              }
                              // 时间输入的合并逻辑：把 "HH:mm" 拆成时/分，覆盖到
                              // **现有日期**上。关键点是 `new Date(datePickerDate)`
                              // 先做一份拷贝 —— 直接 setHours 会原地修改同一个对象，
                              // React 比较引用时发现没变，就不会重新渲染。
                              // 尚未选日期时以"今天"为基准。
                              onChange={e => {
                                const [hours, minutes] =
                                  e.target.value.split(":");
                                const newDate = datePickerDate
                                  ? new Date(datePickerDate)
                                  : new Date();
                                newDate.setHours(parseInt(hours));
                                newDate.setMinutes(parseInt(minutes));
                                setDatePickerDate(newDate);
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                  {datePickerDate && (
                    <p className="text-sm text-muted-foreground">
                      Selected:{" "}
                      {format(datePickerDate, "yyyy/MM/dd  HH:mm", {
                        locale: zhCN,
                      })}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  {/* 复合控件 2：可搜索下拉（combobox）= Popover + Command。
                      shadcn 官方推荐的写法，因为原生 Select 不支持输入过滤。
                      ⚠️ 那个 7 项框架列表在本区块里被**内联重复写了三遍**
                      （触发器回显、列表渲染、选中结果回显），改一处必须改三处，
                      是很典型的可提取常量（见 observations）。 */}
                  <Label>Searchable Dropdown</Label>
                  <Popover open={openCombobox} onOpenChange={setOpenCombobox}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={openCombobox}
                        className="w-full justify-between"
                      >
                        {selectedFramework
                          ? [
                              { value: "react", label: "React" },
                              { value: "vue", label: "Vue" },
                              { value: "angular", label: "Angular" },
                              { value: "svelte", label: "Svelte" },
                              { value: "nextjs", label: "Next.js" },
                              { value: "nuxt", label: "Nuxt" },
                              { value: "remix", label: "Remix" },
                            ].find(fw => fw.value === selectedFramework)?.label
                          : "Select framework..."}
                        <CalendarIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-full p-0">
                      <Command>
                        <CommandInput placeholder="Search frameworks..." />
                        <CommandList>
                          <CommandEmpty>No framework found</CommandEmpty>
                          <CommandGroup>
                            {[
                              { value: "react", label: "React" },
                              { value: "vue", label: "Vue" },
                              { value: "angular", label: "Angular" },
                              { value: "svelte", label: "Svelte" },
                              { value: "nextjs", label: "Next.js" },
                              { value: "nuxt", label: "Nuxt" },
                              { value: "remix", label: "Remix" },
                            ].map(framework => (
                              <CommandItem
                                key={framework.value}
                                value={framework.value}
                                // 「再点一次已选项 = 取消选择」的切换语义：
                                // 相同值则置空，不同值则替换。选完立即关闭浮层。
                                onSelect={currentValue => {
                                  setSelectedFramework(
                                    currentValue === selectedFramework
                                      ? ""
                                      : currentValue
                                  );
                                  setOpenCombobox(false);
                                }}
                              >
                                <Check
                                  className={`mr-2 h-4 w-4 ${
                                    selectedFramework === framework.value
                                      ? "opacity-100"
                                      : "opacity-0"
                                  }`}
                                />
                                {framework.label}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  {selectedFramework && (
                    <p className="text-sm text-muted-foreground">
                      Selected:{" "}
                      {
                        [
                          { value: "react", label: "React" },
                          { value: "vue", label: "Vue" },
                          { value: "angular", label: "Angular" },
                          { value: "svelte", label: "Svelte" },
                          { value: "nextjs", label: "Next.js" },
                          { value: "nuxt", label: "Nuxt" },
                          { value: "remix", label: "Remix" },
                        ].find(fw => fw.value === selectedFramework)?.label
                      }
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="month" className="text-sm font-medium">
                        Month
                      </Label>
                      <Select
                        value={selectedMonth}
                        onValueChange={setSelectedMonth}
                      >
                        <SelectTrigger id="month">
                          <SelectValue placeholder="MM" />
                        </SelectTrigger>
                        <SelectContent>
                          {/* 复合控件 3：月/年双 Select。
                              12 = 一年的月份数；`padStart(2,"0")` 把 1 补成 "01"，
                              保证 value 与显示都是两位数格式。 */}
                          {Array.from({ length: 12 }, (_, i) => i + 1).map(
                            month => (
                              <SelectItem
                                key={month}
                                value={month.toString().padStart(2, "0")}
                              >
                                {month.toString().padStart(2, "0")}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="year" className="text-sm font-medium">
                        Year
                      </Label>
                      <Select
                        value={selectedYear}
                        onValueChange={setSelectedYear}
                      >
                        <SelectTrigger id="year">
                          <SelectValue placeholder="YYYY" />
                        </SelectTrigger>
                        <SelectContent>
                          {/* 年份窗口：以今年为中心的 10 年跨度 —— 前 5 年到后 4 年
                              （length=10，起点 -5，故范围是 [今年-5, 今年+4]）。
                              这样过去与未来的日期都能选，适合生日/有效期两类场景。 */}
                          {Array.from(
                            { length: 10 },
                            (_, i) => new Date().getFullYear() - 5 + i
                          ).map(year => (
                            <SelectItem key={year} value={year.toString()}>
                              {year}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {selectedMonth && selectedYear && (
                    <p className="text-sm text-muted-foreground">
                      Selected: {selectedYear}/{selectedMonth}/
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Data Display Section */}
          {/* 数据展示类组件：Badge / Avatar / Progress / Skeleton / Pagination / Table，
              各子块之间用 <Separator /> 分隔 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Data Display</h3>
            <Card>
              <CardContent className="pt-6 space-y-6">
                <div className="space-y-2">
                  <Label>Badges</Label>
                  <div className="flex flex-wrap gap-2">
                    <Badge>Default</Badge>
                    <Badge variant="secondary">Secondary</Badge>
                    <Badge variant="destructive">Destructive</Badge>
                    <Badge variant="outline">Outline</Badge>
                  </div>
                </div>
                <Separator />
                <div className="space-y-2">
                  <Label>Avatar</Label>
                  <div className="flex gap-4">
                    <Avatar>
                      <AvatarImage src="https://github.com/shadcn.png" />
                      <AvatarFallback>CN</AvatarFallback>
                    </Avatar>
                    <Avatar>
                      <AvatarFallback>AB</AvatarFallback>
                    </Avatar>
                  </div>
                </div>
                <Separator />
                <div className="space-y-2">
                  {/* ±10 按钮用 Math.max/min 把进度钳制在 [0,100]，
                      否则连点会溢出成负值或 >100，导致进度条宽度异常 */}
                  <Label>Progress</Label>
                  <Progress value={progress} />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => setProgress(Math.max(0, progress - 10))}
                    >
                      -10
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setProgress(Math.min(100, progress + 10))}
                    >
                      +10
                    </Button>
                  </div>
                </div>
                <Separator />
                <div className="space-y-2">
                  <Label>Skeleton</Label>
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                </div>
                <Separator />
                <div className="space-y-2">
                  {/* 分页演示。shadcn 的 Pagination 渲染的是 <a href="#">，
                      因此每个 onClick 都必须 `e.preventDefault()`，
                      否则点击会在 URL 后追加 "#" 并把页面滚到顶部。
                      页码固定 1~5，边界同样用 Math.max/min 钳制。 */}
                  <Label>Pagination</Label>
                  <Pagination>
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          href="#"
                          onClick={e => {
                            e.preventDefault();
                            setCurrentPage(Math.max(1, currentPage - 1));
                          }}
                        />
                      </PaginationItem>
                      {[1, 2, 3, 4, 5].map(page => (
                        <PaginationItem key={page}>
                          <PaginationLink
                            href="#"
                            isActive={currentPage === page}
                            onClick={e => {
                              e.preventDefault();
                              setCurrentPage(page);
                            }}
                          >
                            {page}
                          </PaginationLink>
                        </PaginationItem>
                      ))}
                      <PaginationItem>
                        <PaginationNext
                          href="#"
                          onClick={e => {
                            e.preventDefault();
                            setCurrentPage(Math.min(5, currentPage + 1));
                          }}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                  <p className="text-sm text-muted-foreground text-center">
                    Current page: {currentPage}
                  </p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <Label>Table</Label>
                  <Table>
                    <TableCaption>A list of your recent invoices.</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[100px]">Invoice</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Method</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="font-medium">INV001</TableCell>
                        <TableCell>Paid</TableCell>
                        <TableCell>Credit Card</TableCell>
                        <TableCell className="text-right">$250.00</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">INV002</TableCell>
                        <TableCell>Pending</TableCell>
                        <TableCell>PayPal</TableCell>
                        <TableCell className="text-right">$150.00</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">INV003</TableCell>
                        <TableCell>Unpaid</TableCell>
                        <TableCell>Bank Transfer</TableCell>
                        <TableCell className="text-right">$350.00</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
                <Separator />
                <div className="space-y-2">
                  <Label>Menubar</Label>
                  <Menubar>
                    <MenubarMenu>
                      <MenubarTrigger>File</MenubarTrigger>
                      <MenubarContent>
                        <MenubarItem>New Tab</MenubarItem>
                        <MenubarItem>New Window</MenubarItem>
                        <MenubarSeparator />
                        <MenubarItem>Share</MenubarItem>
                        <MenubarSeparator />
                        <MenubarItem>Print</MenubarItem>
                      </MenubarContent>
                    </MenubarMenu>
                    <MenubarMenu>
                      <MenubarTrigger>Edit</MenubarTrigger>
                      <MenubarContent>
                        <MenubarItem>Undo</MenubarItem>
                        <MenubarItem>Redo</MenubarItem>
                      </MenubarContent>
                    </MenubarMenu>
                    <MenubarMenu>
                      <MenubarTrigger>View</MenubarTrigger>
                      <MenubarContent>
                        <MenubarItem>Reload</MenubarItem>
                        <MenubarItem>Force Reload</MenubarItem>
                      </MenubarContent>
                    </MenubarMenu>
                  </Menubar>
                </div>
                <Separator />
                <div className="space-y-2">
                  <Label>Breadcrumb</Label>
                  <Breadcrumb>
                    <BreadcrumbList>
                      <BreadcrumbItem>
                        <BreadcrumbLink href="/">Home</BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbLink href="/components">
                          Components
                        </BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbPage>Breadcrumb</BreadcrumbPage>
                      </BreadcrumbItem>
                    </BreadcrumbList>
                  </Breadcrumb>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Alerts Section */}
          {/* Alert 的两个 variant：default（提示）与 destructive（错误）。
              注意这里不像其他区块那样外套 <Card> —— Alert 自带边框，再套会双层边框 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Alerts</h3>
            <div className="space-y-4">
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Heads up!</AlertTitle>
                <AlertDescription>
                  You can add components to your app using the cli.
                </AlertDescription>
              </Alert>
              <Alert variant="destructive">
                <X className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>
                  Your session has expired. Please log in again.
                </AlertDescription>
              </Alert>
            </div>
          </section>

          {/* Tabs Section */}
          {/* 非受控 Tabs（用 defaultValue 而非 value）。
              TabsList 用 `grid grid-cols-3` 让三个页签等宽平分整行 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Tabs</h3>
            <Tabs defaultValue="account" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="account">Account</TabsTrigger>
                <TabsTrigger value="password">Password</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
              <TabsContent value="account">
                <Card>
                  <CardHeader>
                    <CardTitle>Account</CardTitle>
                    <CardDescription>
                      Make changes to your account here.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="space-y-1">
                      <Label htmlFor="name">Name</Label>
                      <Input id="name" defaultValue="Pedro Duarte" />
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button>Save changes</Button>
                  </CardFooter>
                </Card>
              </TabsContent>
              <TabsContent value="password">
                <Card>
                  <CardHeader>
                    <CardTitle>Password</CardTitle>
                    <CardDescription>
                      Change your password here.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="space-y-1">
                      <Label htmlFor="current">Current password</Label>
                      <Input id="current" type="password" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="new">New password</Label>
                      <Input id="new" type="password" />
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button>Save password</Button>
                  </CardFooter>
                </Card>
              </TabsContent>
              <TabsContent value="settings">
                <Card>
                  <CardHeader>
                    <CardTitle>Settings</CardTitle>
                    <CardDescription>
                      Manage your settings here.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      Settings content goes here.
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </section>

          {/* Accordion Section */}
          {/* 手风琴：type="single" 表示同一时刻只能展开一项（对应 "multiple" 可多开） */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Accordion</h3>
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="item-1">
                <AccordionTrigger>Is it accessible?</AccordionTrigger>
                <AccordionContent>
                  Yes. It adheres to the WAI-ARIA design pattern.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="item-2">
                <AccordionTrigger>Is it styled?</AccordionTrigger>
                <AccordionContent>
                  Yes. It comes with default styles that matches the other
                  components' aesthetic.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="item-3">
                <AccordionTrigger>Is it animated?</AccordionTrigger>
                <AccordionContent>
                  Yes. It's animated by default, but you can disable it if you
                  prefer.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>

          {/* Collapsible Section */}
          {/* Collapsible 与 Accordion 的区别：前者是单个独立的展开/收起块，
              不存在"同组互斥"的概念 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Collapsible</h3>
            <Collapsible>
              <Card>
                <CardHeader>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" className="w-full justify-between">
                      <CardTitle>@peduarte starred 3 repositories</CardTitle>
                    </Button>
                  </CollapsibleTrigger>
                </CardHeader>
                <CollapsibleContent>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="rounded-md border px-4 py-3 font-mono text-sm">
                        @radix-ui/primitives
                      </div>
                      <div className="rounded-md border px-4 py-3 font-mono text-sm">
                        @radix-ui/colors
                      </div>
                      <div className="rounded-md border px-4 py-3 font-mono text-sm">
                        @stitches/react
                      </div>
                    </div>
                  </CardContent>
                </CollapsibleContent>
              </Card>
            </Collapsible>
          </section>

          {/* Dialog, Sheet, Drawer Section */}
          {/* 五种浮层的区别：
              - Dialog  居中模态框（此处为**受控**用法，因为提交后要用代码关窗）
              - Sheet   从屏幕边缘滑出的抽屉（桌面端侧栏）
              - Drawer  从底部拉起的抽屉（vaul 实现，移动端手感）
              - Popover 轻量气泡，点外部即关，不锁滚动
              - Tooltip 悬停提示，不可交互
              除 Dialog 外其余四个都用非受控模式（Trigger + Content 自成闭环） */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Overlays</h3>
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-wrap gap-4">
                  <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline">Open Dialog</Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Test Input</DialogTitle>
                        <DialogDescription>
                          Enter some text below. Press Enter to submit (IME composition supported).
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label htmlFor="dialog-input">Input</Label>
                          <Input
                            id="dialog-input"
                            placeholder="Type something..."
                            value={dialogInput}
                            onChange={(e) => setDialogInput(e.target.value)}
                            onKeyDown={handleDialogKeyDown}
                            autoFocus
                          />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          onClick={() => setDialogOpen(false)}
                        >
                          Cancel
                        </Button>
                        <Button onClick={handleDialogSubmit}>Submit</Button>
                      </div>
                    </DialogContent>
                  </Dialog>

                  <Sheet>
                    <SheetTrigger asChild>
                      <Button variant="outline">Open Sheet</Button>
                    </SheetTrigger>
                    <SheetContent>
                      <SheetHeader>
                        <SheetTitle>Edit profile</SheetTitle>
                        <SheetDescription>
                          Make changes to your profile here. Click save when
                          you're done.
                        </SheetDescription>
                      </SheetHeader>
                    </SheetContent>
                  </Sheet>

                  <Drawer>
                    <DrawerTrigger asChild>
                      <Button variant="outline">Open Drawer</Button>
                    </DrawerTrigger>
                    <DrawerContent>
                      <DrawerHeader>
                        <DrawerTitle>Are you absolutely sure?</DrawerTitle>
                        <DrawerDescription>
                          This action cannot be undone.
                        </DrawerDescription>
                      </DrawerHeader>
                      <DrawerFooter>
                        <Button>Submit</Button>
                        <DrawerClose asChild>
                          <Button variant="outline">Cancel</Button>
                        </DrawerClose>
                      </DrawerFooter>
                    </DrawerContent>
                  </Drawer>

                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline">Open Popover</Button>
                    </PopoverTrigger>
                    <PopoverContent>
                      <div className="space-y-2">
                        <h4 className="font-medium leading-none">Dimensions</h4>
                        <p className="text-sm text-muted-foreground">
                          Set the dimensions for the layer.
                        </p>
                      </div>
                    </PopoverContent>
                  </Popover>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline">Hover me</Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Add to library</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Menus Section */}
          {/* 三类菜单：DropdownMenu（点击触发）、ContextMenu（右键触发）、
              HoverCard（悬停展开的富内容卡片，区别于纯文本的 Tooltip） */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Menus</h3>
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-wrap gap-4">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline">Dropdown Menu</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuLabel>My Account</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem>Profile</DropdownMenuItem>
                      <DropdownMenuItem>Billing</DropdownMenuItem>
                      <DropdownMenuItem>Team</DropdownMenuItem>
                      <DropdownMenuItem>Subscription</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <Button variant="outline">Right Click Me</Button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem>Profile</ContextMenuItem>
                      <ContextMenuItem>Billing</ContextMenuItem>
                      <ContextMenuItem>Team</ContextMenuItem>
                      <ContextMenuItem>Subscription</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>

                  <HoverCard>
                    <HoverCardTrigger asChild>
                      <Button variant="outline">Hover Card</Button>
                    </HoverCardTrigger>
                    <HoverCardContent>
                      <div className="space-y-2">
                        <h4 className="text-sm font-semibold">@nextjs</h4>
                        <p className="text-sm">
                          The React Framework – created and maintained by
                          @vercel.
                        </p>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Calendar Section */}
          {/* 独立的日历组件（react-day-picker 封装），
              与前面 Form Inputs 里那个"日期时间选择器"用的是同一个 Calendar，
              区别只在于这里直接平铺、没有包在 Popover 里 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Calendar</h3>
            <Card>
              <CardContent className="pt-6 flex justify-center">
                <Calendar
                  mode="single"
                  selected={date}
                  onSelect={setDate}
                  className="rounded-md border"
                />
              </CardContent>
            </Card>
          </section>

          {/* Carousel Section */}
          {/* 走马灯（embla-carousel 封装）。5 张卡片用 Array.from 生成占位。
              CarouselPrevious/Next 必须是 Carousel 的直接后代 —— 它们靠 Context
              拿到 embla 实例，放到外面会失效 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Carousel</h3>
            <Card>
              <CardContent className="pt-6">
                <Carousel className="w-full max-w-xs mx-auto">
                  <CarouselContent>
                    {Array.from({ length: 5 }).map((_, index) => (
                      <CarouselItem key={index}>
                        <div className="p-1">
                          <Card>
                            <CardContent className="flex aspect-square items-center justify-center p-6">
                              <span className="text-4xl font-semibold">
                                {index + 1}
                              </span>
                            </CardContent>
                          </Card>
                        </div>
                      </CarouselItem>
                    ))}
                  </CarouselContent>
                  <CarouselPrevious />
                  <CarouselNext />
                </Carousel>
              </CardContent>
            </Card>
          </section>

          {/* Toggle Section */}
          {/* 开关按钮。单个 Toggle 各自独立；ToggleGroup type="multiple" 表示组内可多选
              （对应 "single" 为单选，语义等同 RadioGroup 的按钮版）。
              这里全部是非受控用法，页面顶部的 selectedFruits state 与本区块无关。
              每个按钮都标了 aria-label —— 图标/单字母按钮必须补文字标签才可读屏。 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Toggle</h3>
            <Card>
              <CardContent className="pt-6 space-y-4">
                <div className="space-y-2">
                  <Label>Toggle</Label>
                  <div className="flex gap-2">
                    <Toggle aria-label="Toggle italic">
                      <span className="font-bold">B</span>
                    </Toggle>
                    <Toggle aria-label="Toggle italic">
                      <span className="italic">I</span>
                    </Toggle>
                    <Toggle aria-label="Toggle underline">
                      <span className="underline">U</span>
                    </Toggle>
                  </div>
                </div>
                <Separator />
                <div className="space-y-2">
                  <Label>Toggle Group</Label>
                  <ToggleGroup type="multiple">
                    <ToggleGroupItem value="bold" aria-label="Toggle bold">
                      <span className="font-bold">B</span>
                    </ToggleGroupItem>
                    <ToggleGroupItem value="italic" aria-label="Toggle italic">
                      <span className="italic">I</span>
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="underline"
                      aria-label="Toggle underline"
                    >
                      <span className="underline">U</span>
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Aspect Ratio & Scroll Area Section */}
          {/* 布局类组件：
              - AspectRatio 用 padding-bottom 百分比技巧锁定宽高比，
                本项目的视频封面（VideoCard）就依赖 16/9；
              - ScrollArea 是自绘滚动条的容器，必须给定固定高度（这里 200px）
                才会出现滚动，内容用 20 条假数据撑满。 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Layout Components</h3>
            <Card>
              <CardContent className="pt-6 space-y-6">
                <div className="space-y-2">
                  <Label>Aspect Ratio (16/9)</Label>
                  <AspectRatio ratio={16 / 9} className="bg-muted">
                    <div className="flex h-full items-center justify-center">
                      <p className="text-muted-foreground">16:9 Aspect Ratio</p>
                    </div>
                  </AspectRatio>
                </div>
                <Separator />
                <div className="space-y-2">
                  <Label>Scroll Area</Label>
                  <ScrollArea className="h-[200px] w-full rounded-md border overflow-hidden">
                    <div className="p-4">
                      <div className="space-y-4">
                        {Array.from({ length: 20 }).map((_, i) => (
                          <div key={i} className="text-sm">
                            Item {i + 1}: This is a scrollable content area
                          </div>
                        ))}
                      </div>
                    </div>
                  </ScrollArea>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Resizable Section */}
          {/* 可拖拽调整宽度的分栏。defaultSize 是**百分比**（50 + 50 = 100），
              不是像素；min-h 必须显式给，否则面板高度塌成 0 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Resizable Panels</h3>
            <Card>
              <CardContent className="pt-6">
                <ResizablePanelGroup
                  direction="horizontal"
                  className="min-h-[200px] rounded-lg border"
                >
                  <ResizablePanel defaultSize={50}>
                    <div className="flex h-full items-center justify-center p-6">
                      <span className="font-semibold">Panel One</span>
                    </div>
                  </ResizablePanel>
                  <ResizableHandle />
                  <ResizablePanel defaultSize={50}>
                    <div className="flex h-full items-center justify-center p-6">
                      <span className="font-semibold">Panel Two</span>
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
              </CardContent>
            </Card>
          </section>

          {/* Toast Section */}
          {/* sonner 的 6 种 toast 形态。全站统一用 sonner（而非 shadcn 自带的 useToast），
              Toaster 容器在 App.tsx 中全局挂载一次。
              最后一个 `toast.promise` 最实用：传入 Promise 后自动在
              loading → success/error 之间切换，适合包裹 tRPC mutation；
              这里的 2000ms 只是演示用的假延迟。 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">Toast</h3>
            <Card>
              <CardContent className="pt-6 space-y-4">
                <div className="space-y-2">
                  <Label>Sonner Toast</Label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        sonnerToast.success("Operation successful", {
                          description: "Your changes have been saved",
                        });
                      }}
                    >
                      Success
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        sonnerToast.error("Operation failed", {
                          description:
                            "Cannot complete operation, please try again",
                        });
                      }}
                    >
                      Error
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        sonnerToast.info("Information", {
                          description: "This is an information message",
                        });
                      }}
                    >
                      Info
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        sonnerToast.warning("Warning", {
                          description:
                            "Please note the impact of this operation",
                        });
                      }}
                    >
                      Warning
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        sonnerToast.loading("Loading", {
                          description: "Please wait",
                        });
                      }}
                    >
                      Loading
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        const promise = new Promise(resolve =>
                          setTimeout(resolve, 2000)
                        );
                        sonnerToast.promise(promise, {
                          loading: "Processing...",
                          success: "Processing complete!",
                          error: "Processing failed",
                        });
                      }}
                    >
                      Promise
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* AI ChatBox Section */}
          {/* 全页唯一的**非 shadcn** 组件：项目自研的 AIChatBox
              （ChatPage 用的就是它）。此处用假回复演示它的完整 props 面：
              messages / onSendMessage / isLoading / placeholder / height /
              emptyStateMessage / suggestedPrompts。
              height 必须是 CSS 长度字符串（"500px"）而非数字。 */}
          <section className="space-y-4">
            <h3 className="text-2xl font-semibold">AI ChatBox</h3>
            <Card>
              <CardContent className="pt-6">
                <div className="space-y-4">
                  <div className="text-sm text-muted-foreground">
                    <p>
                      A ready-to-use chat interface component that integrates with the LLM system.
                      Features markdown rendering, auto-scrolling, and loading states.
                    </p>
                    <p className="mt-2">
                      This is a demo with simulated responses. In a real app, you'd connect it to a tRPC mutation.
                    </p>
                  </div>
                  <AIChatBox
                    messages={chatMessages}
                    onSendMessage={handleChatSend}
                    isLoading={isChatLoading}
                    placeholder="Try sending a message..."
                    height="500px"
                    emptyStateMessage="How can I help you today?"
                    suggestedPrompts={[
                      "What is React?",
                      "Explain TypeScript",
                      "How to use tRPC?",
                      "Best practices for web development",
                    ]}
                  />
                </div>
              </CardContent>
            </Card>
          </section>
        </div>
      </main>

      <footer className="border-t py-6 mt-12">
        <div className="container text-center text-sm text-muted-foreground">
          <p>Shadcn/ui Component Showcase</p>
        </div>
      </footer>
    </div>
  );
}
