<p align="center"><img src="packages/web/public/icon.png" width="96" alt=""></p>

<h1 align="center">Favilla</h1>

<p align="center">开源通用智能体，提供终端界面和桌面应用。</p>

<p align="center"><a href="https://favilla.melodybounce.com/zh/">官网</a> · <a href="https://github.com/benelatuit/favilla/releases">下载</a> · <a href="README.md">English</a></p>

Favilla 能处理编程、文档、网页调研、邮件和电脑操作等任务，每一步都有记录。支持 OpenAI、Anthropic、Gemini、DeepSeek、Kimi、GLM、Qwen、OpenRouter、xAI，任何 OpenAI 兼容的服务，也支持在本机运行的模型。同一个引擎提供三种界面：终端界面、桌面应用和浏览器页面。

## 安装

Windows 10 或 11，在 PowerShell 里运行：

```powershell
irm https://favilla.melodybounce.com/install.ps1 | iex
```

该命令为当前用户安装桌面应用和 `favilla`、`fav` 两个命令，无需管理员权限，安装前会校验下载文件的 SHA-256。再次运行即可更新。安装包和便携版也可以在 [Releases 页面](https://github.com/benelatuit/favilla/releases) 下载。

然后在项目文件夹里：

```bash
fav                               # 终端界面
fav -p "修好失败的测试"           # 单次运行，不打开界面，适合脚本和 CI
git diff | fav -p "审一下这些改动" # 通过管道输入
fav web                           # 在浏览器里打开同样的界面
```

模型在应用的设置 > 供应商里添加，也可以设置供应商的密钥环境变量，见[模型](#模型)。

## 从源码运行

Linux 和 macOS，或参与 Favilla 本身的开发，需要 Node 22 或更新版本，以及 pnpm 9。

```bash
git clone https://github.com/benelatuit/favilla && cd favilla
pnpm install
export ANTHROPIC_API_KEY=...            # 也可以用其他供应商的密钥，见下文“模型”
pnpm fav                                # 在当前文件夹打开终端界面
pnpm fav -p "修好失败的测试"            # 单次运行，不打开界面
pnpm fav web                            # 在浏览器里打开同样的界面
pnpm --filter @favilla/desktop start    # 从源码启动桌面应用
pnpm --filter @favilla/desktop dist     # 生成 Windows 安装包和便携版，放在 packages/desktop/release
```

## 功能

### 代码工作

- **批量工具调用。** `read` 一次读多个文件和行段，文件夹、图片、笔记本和 PDF 也能读。`search` 同时搜内容和文件名，也可以直接问一句“失败的上传在哪里重试”，按功能查找代码。`edit` 一次做多处精确替换，未匹配的替换会单独列出。`shell` 运行命令，服务器和交互式程序交给 `job`。
- **修改匹配。** 先精确匹配，再容忍空白、缩进、转义和位置偏移，有歧义就拒绝并给出行号。每次修改后马上做语法检查，覆盖 TypeScript、JavaScript、Python、JSON 和 YAML，括号写错会在对应的修改旁报出。文件编码保持原样，GBK 文件改完仍是 GBK。
- **所有模型使用同一套工具。** 会话中途切换模型无需压缩上下文。如果想用模型训练时使用的工具，可以设置 `"tools": "auto"`：GPT 模型用 `shell_command` 和 `apply_patch`，Anthropic 的模型用 `Read / Edit / Bash / Grep`。
- **思考内容原样回传。** Anthropic 的思考块带着签名回传，OpenAI 的推理条目带着加密内容回传，Gemini 的思考签名回到原来的部件上，兼容接口的 `reasoning_content` 和 `<think>` 按各家的要求回传。
- **子智能体。** 会修改文件的子智能体只能改分配给它的文件，文件可能重叠的子智能体依次执行。报告末尾附有 Favilla 自己的记录：改了哪些文件，增删多少行，跑了哪些命令，退出码是多少。
- **分支和撤销。** 已发送的消息可以编辑后重新发送，形成新的分支，任何一条回答也可以作为分支起点。智能体改动的文件每一轮都有快照，可以用 `/undo` 或在桌面应用中撤销一整轮。

### 长会话

- **稳定的提示词前缀。** 系统提示词和工具在会话开始时生成一次，之后保持不变。前缀逐字节相同，便于各家供应商的提示词缓存命中，llama.cpp 的 KV 缓存也适用。
- **按模型窗口计算上下文。** 预算和压缩点由模型的实际窗口决定，从供应商或 [models.dev](https://models.dev) 读取，每个模型的窗口也能手动设置。
- **裁剪旧输出。** 窗口用到一半以后，被后续调用取代的工具输出裁成简短存根。全文留在磁盘上，可以用 `recall` 取回，也能在整段历史里搜索。
- **压缩。** 你发出的消息在多次摘要中逐字保留，最近几轮工具调用也原样保留。摘要会对照 Favilla 记录的读取信息核对，包括读过哪些文件的哪些行，使摘要与实际读取的内容一致。摘要在智能体工作期间于后台生成。
- **按模型提供思考档位。** 思考强度只列模型支持的档位，`max` 也在内。服务器不接受某一档时，Favilla 会从报错中读取可用档位并记住，然后用最接近的档位重新发送。
- **崩溃恢复。** Favilla 关闭时尚未返回结果的工具调用，会在重新打开会话时补上结果。按 Ctrl+C 或关闭应用时，当前一轮会正常结束，后台任务也会停止。

### 检查

- **网页检查。** 一轮改动涉及无需构建的网页时，Favilla 会在 headless 浏览器中按桌面和手机宽度打开它，并把以下问题报给模型：控制台错误、横向滚动、对比度低于 WCAG AA 的文字、过小的点击区域、加载失败的图片。
- **浏览器工具。** 每个页面返回可操作元素的清单和编号，例如 `[e7] button "Save"`，可按编号点击、填写和上传。支持跟随新标签页、处理弹窗、保存下载，并可按任意宽度渲染，390 像素对应手机。
- **网页搜索。** 通过 OpenAI API 使用的 GPT 模型调用 OpenAI 自带的搜索。其他模型使用内置搜索，查询 DuckDuckGo 和 Bing，无需密钥，也可以添加 Brave 和 SearXNG。网页按其原有编码读取为文字，GitHub、Stack Overflow 和软件包仓库通过各自的 API 读取。
- **图片读取。** 读取图片时会返回尺寸，指定区域读取会放大该区域，便于看清小字。`draw` 把 SVG 渲染成 PNG 并附一张检查图，`paint` 的画布在多次调用之间保留，可模拟真实画材作画。
- **回答前检查。** 改动代码后如果还没运行过检查，会提醒运行一次。一条消息包含多项要求时，会核对回答是否有遗漏。连续失败两次后，本轮剩余部分自动提高一档思考强度。
- **由另一家模型编写的 shadow tests。** 把 `shadowTests.model` 设为另一家的模型后，修复时它只根据需求，在项目副本中编写测试。测试在改动上失败时，测试输出会交回，再修改一次。

### 其他功能

- **MCP 服务器。** `mcpServers` 中的服务器只启动一次，其工具在每个会话中可用，支持本地命令以及使用 streamable HTTP 或 SSE 的网址。`favilla mcp` 可以列出这些服务器。
- **技能。** `.favilla/skills`、`~/.favilla/skills`、`~/.agents/skills` 和 `~/.claude/skills` 里的技能，每个带名称和说明的 `SKILL.md` 占一行列给模型，任务需要时模型会读取。
- **邮箱。** 在设置 > 邮箱里用应用专用密码添加 Gmail 等邮箱。智能体可以搜索、阅读、整理邮件和撰写草稿，每封要发送的邮件都会先给你确认。
- **SillyTavern 预设。** 对话补全预设里的提示词按原来的层级、角色和深度放进每次请求，支持宏和预填充。只读取提示词和预填充，预设中的模型、温度和代理设置会被忽略。
- **电脑控制，默认关闭。** 在 Windows 上，智能体可以截图、点击、输入文字和按组合键。把鼠标移到屏幕左上角即可让它停止。
- **手机远程控制。** 扫描二维码配对手机后，可以在手机上查看会话、发送消息和批准操作，连接经由你自己部署的中转服务。部署方法见[远程控制](#远程控制)。
- **磁盘和内存占用。** 图片、长输出和文件快照在压缩的块存储中只保存一份，闲置的会话会重新打包压缩，一个长会话从 36 MB 降到 0.3 MB。智能体使用的浏览器在最后一次使用几分钟后关闭。

## 安全

可能造成损失的命令需要确认：递归删除根目录、家目录、工作区本身或工作区外的文件夹，丢弃未提交的 git 改动，强制推送和改写历史，磁盘、引导和关机命令，按名称杀进程，发布软件包，删除数据库。这些操作需要你确认，无人值守运行时直接拒绝，其他命令直接运行。会耗尽内存的命令会被中止，智能体会改用范围更小的命令。

项目里的 `.favilla/config.json` 可以设置模型、说明、技能和工具风格，但不能设置供应商、密钥、MCP 服务器、shell 和审批。因此你打开的仓库无法改动你的密钥、运行程序或关闭审批。

## 模型

- **API 密钥。** 设置常用的环境变量：`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY`、`ZHIPU_API_KEY`、`DASHSCOPE_API_KEY`、`OPENROUTER_API_KEY`、`XAI_API_KEY`。Gemini 也可以用逗号分隔的 `GEMINI_API_KEYS`，限流时自动轮换。也可以直接在设置 > 供应商里粘贴密钥。
- **本地模型。** 支持任何 OpenAI 兼容的服务。`local` 供应商默认指向 llama.cpp 的默认端口，使用其他端口时修改 `providers.local.baseUrl`。
- **自己的服务。** 设置 > 供应商 > 添加供应商，接口格式可以是 OpenAI 兼容、OpenAI Responses、Anthropic 或 Gemini，填写名称、地址和密钥即可。
- **服务没列出的模型。** 在设置 > 供应商里，任何一个供应商下面都能用“添加模型”填它的 ID，窗口大小和是否支持图片在“模型”中设置。

`favilla models` 可以列出每个供应商提供的模型。

## 配置

应用里的设置都写进 `~/.favilla/config.json`，也可以手动编辑，文件中可以写注释。项目里的 `.favilla/config.json` 能覆盖[安全](#安全)一节里允许的那几项。

```jsonc
{
  "model": "anthropic/claude-sonnet-5-5",
  "effort": "medium",                 // off、minimal、low、medium、high、xhigh、max，以模型支持的为准
  "proxy": "http://127.0.0.1:7890",   // 远程供应商走代理，本地服务始终直连
  "providers": {
    "local": { "baseUrl": "http://127.0.0.1:8090/v1" },
    "gemini": { "keyFile": "/path/to/gemini.env" },
    "openai": { "models": { "gpt-6-luna": { "contextWindow": 400000 } } }   // 手动设置某个模型的窗口
  },
  "guard": { "mode": "confirm" },     // 或 "off"
  "webSearch": true,                  // false 关闭，"builtin" 或 "provider" 指定用哪种搜索
  "skills": true,                     // false 关闭，或填额外的技能目录列表
  "shell": "bash",                    // bash，Windows 上是 Git Bash，也可以填 pwsh、powershell、cmd 或程序路径
  "tools": "favilla",                 // Favilla 自己的工具，或 "auto"，按模型家族用训练时那套
  "computer": false,                  // true 允许智能体操作这台电脑的屏幕、鼠标和键盘，仅限 Windows
  "context": { "compactAt": 0.82 },   // 上下文用到这个比例时压缩
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } },
    "browser": { "command": "npx", "args": ["@playwright/mcp@latest"] }
  }
}
```

长期指示写在 `~/.favilla/AGENTS.md` 里，对所有项目生效。项目自己的指示写在项目的 `AGENTS.md` 或 `CLAUDE.md` 里。设置 > 规则可以直接编辑这些文件。

## 终端界面

在文件夹中运行 `fav` 或 `favilla` 即可打开终端界面。回复按段输出，每段完成后才打印，长回答不会重绘整个屏幕。差异、命令、检查和搜索结果各有独立的显示格式，每个运行中的子智能体都有一行实时进度。

| 按键 | |
|---|---|
| Enter / Shift+Enter、Alt+Enter、Ctrl+J | 发送 / 换行 |
| Esc / Esc Esc | 中断智能体 / 回到之前的消息，修改重发或从那里分支 |
| Shift+Tab | 打开或关闭规划模式 |
| Alt+V，Windows 以外是 Ctrl+V | 贴入剪贴板里的图片 |
| ↑ / Ctrl+R | 翻历史 / 搜历史 |
| Ctrl+G / Ctrl+T | 用 `$EDITOR` 编辑消息 / 在带搜索的阅读器里看完整对话 |
| `@路径`、`!命令` | 附加文件 / 运行命令，把输出交给智能体 |

命令：`/model`、`/effort`、`/plan`、`/rewind`、`/fork`、`/diff`、`/undo`、`/agents`、`/transcript`、`/context`、`/compact`、`/rules`、`/persona`、`/preset`、`/copy`、`/export`、`/review`、`/init`、`/new`、`/resume`、`/status`、`/settings`、`/cost`、`/help`、`/exit`。放在 `~/.favilla/commands` 或 `.favilla/commands` 里的 markdown 文件会成为自定义命令，`$ARGUMENTS` 换成命令后面的内容。

**人设。** `/persona import FILE` 导入一张角色卡，智能体会在这个文件夹中以该角色回复，加 `--global` 就对所有文件夹生效。`/persona none` 换回普通的智能体。

## 桌面应用

引擎在独立进程中运行，通过带随机令牌的本机端口向窗口提供界面，耗时较长的步骤不会阻塞窗口。会话按文件夹和日期列出。智能体的每一步都可以展开，看终端输出、差异、预览和截图。侧边面板列出每一轮的文件改动，可以撤销，并按比例显示上下文窗口的占用。每条回答末尾有一行摘要，包括本轮用时、请求次数、改动的文件，以及最后一次检查是否通过。窗口在后台时，会话完成或等待你操作都会弹出系统通知。

| 快捷键 | |
|---|---|
| Ctrl+K | 命令面板 |
| Ctrl+N / Ctrl+O | 新会话 / 打开文件夹 |
| Ctrl+B / Ctrl+Alt+B | 侧栏 / 侧面板 |
| Esc | 停止智能体 |
| Ctrl+, | 设置 |
| Ctrl+= / Ctrl+- / Ctrl+0 | 缩放 |

一共六套主题：Drafting 和 Night shift 一浅一深，默认跟随系统切换，另有 Daylight、Porcelain、Plain，以及自带夜间版的 Kiln。界面风格见 `packages/web/STYLE.md`。设置 > 用量按天、模型和文件夹统计这台电脑上的 token 和请求数，费用按各模型的价格估算。这里只保存数字，不保存对话内容。

应用和终端界面支持英语、简体中文、繁体中文、日语、韩语、西班牙语、巴西葡萄牙语、法语、德语和俄语，没选语言时跟随系统。

## 远程控制

在设置 > 远程控制里扫二维码，即可配对手机和电脑。手机上打开的是同样的界面，可以查看会话、发送消息和批准操作。手机和电脑之间的内容由两端端到端加密，实现见 `packages/core/src/remote/e2e.ts`。中间的中转服务只转发加密后的消息，再给手机提供页面。

Favilla 不内置中转服务，需要你在 Cloudflare Workers 上自行部署，免费套餐即可：

```bash
pnpm install
pnpm --filter @favilla/web build    # 中转服务给手机的页面
cd packages/relay
npx wrangler login
npx wrangler deploy                 # 输出 https://favilla-relay.<你的子域>.workers.dev
```

把这个地址填进设置 > 远程控制 > 中转服务，再打开远程控制，配对手机。使用自己的域名请参考 `packages/relay/wrangler.jsonc` 中的注释。

## 平台

| | 情况 |
|---|---|
| Windows | 主要平台。可以用安装命令、安装包或便携版，也可以用 `pnpm --filter @favilla/desktop dist` 自己生成。电脑控制只支持 Windows。 |
| Linux | 类型检查和测试在 CI 和容器里都能通过。终端界面和浏览器页面在该平台上使用较少，不提供桌面安装包。 |
| macOS | 类型检查和测试在 CI 里跑。尚未在真机上测试，不提供桌面安装包。 |

欢迎提交 Linux 和 macOS 上的问题和修复。

## 参与开发

`AGENTS.md` 写了代码结构和改动完成前要跑的检查：`pnpm typecheck` 和 `pnpm test`。

```
packages/core      引擎：供应商、工具、智能体循环、上下文、会话、本地服务
packages/cli       favilla 和 fav 命令，以及终端界面
packages/web       界面，使用 React，主题在 src/themes
packages/desktop   Electron 外壳和打包
packages/relay     远程控制的中转服务，一个 Cloudflare Worker
```

## 许可

MIT，作者 Bene Latuit。
