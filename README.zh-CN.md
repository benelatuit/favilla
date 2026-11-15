<p align="center"><img src="packages/web/public/icon.png" width="88" alt="Favilla"></p>

<h1 align="center">Favilla</h1>

<p align="center">面向终端、桌面与浏览器的开源 AI Agent。</p>

<p align="center"><a href="https://favilla.melodybounce.com/zh/">官网</a> · <a href="https://github.com/benelatuit/favilla/releases">下载</a> · <a href="README.md">English</a></p>

Favilla 基于同一套引擎提供终端界面 `fav`、桌面应用与浏览器界面 `fav web`，可处理代码开发、文档整理、网页调研、邮件收发与 Windows 桌面操作。支持接入 OpenAI、Anthropic、Gemini、DeepSeek、Kimi、GLM、Qwen、MiniMax、OpenRouter、xAI、Ollama、`llama.cpp` 及任意兼容 API，可使用自有 API 密钥或本机模型。

## 安装

### Windows 10 / 11 · 桌面应用与 CLI

```powershell
irm https://favilla.melodybounce.com/install.ps1 | iex
```

下载当前版本并校验 SHA-256，在当前用户目录下安装桌面应用及 `fav`、`favilla` 命令，无需管理员权限。安装版会在后台检查并下载更新，点击重启即可完成升级，可在设置中关闭或配置 `updates.check: false`。也可前往 [Releases](https://github.com/benelatuit/favilla/releases) 下载独立安装包与便携版 `.exe`。

### macOS、Linux 与 Windows CLI · 需 `Node.js 22+`

```bash
npm install -g favilla
```

安装 `fav`、`favilla` 终端命令及 `fav web` 浏览器界面。再次运行同一命令即可更新。

## 快速开始

在应用的“设置 > 供应商”中填写 API 密钥，或设置对应环境变量：

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # 也可设置 OPENAI_API_KEY、GEMINI_API_KEY、DEEPSEEK_API_KEY 等
```

在任意项目目录下运行：

```bash
fav                                     # 启动交互式终端界面
fav "修复失败的按天折算测试"            # 打开终端界面并直接发送该任务
fav -p "修复失败的按天折算测试"         # 无界面单次运行，适用于脚本与 CI
git diff | fav -p "审查这份改动"        # 通过标准输入管道传入内容
fav -c                                  # 恢复当前目录最近一次会话
fav web                                 # 在 127.0.0.1 启动浏览器界面
favilla models                          # 列出已配置供应商与可用模型
favilla sessions                        # 列出当前目录已保存的会话，加 -a 查看全部
favilla mcp                             # 检查已配置的 MCP 服务器并列出工具
```

## 核心能力

### 代码、文档与网页

- **批量读取文件与文档。** `read` 支持单次读取多个文件与行号区间，支持浏览目录、提取 PDF 与 Office 文档 `.docx`、`.xlsx`、`.pptx`，支持读取 Jupyter `notebook` 并由 `notebook_edit` 编辑，支持读取图片并按区域放大查看小字。
- **代码搜索。** `search` 支持正则表达式全文检索、文件名通配匹配，以及按自然语言问题检索相关代码定义。
- **带语法检查的文件编辑。** `edit` 支持单次执行多处替换，在精确匹配之外容忍空白与行号偏移，遇到多处歧义时带行号拒绝修改。修改后立即检查 TypeScript、JavaScript、Python、JSON 与 YAML 语法，自动联动已安装的语言服务器，并保留 GBK、CRLF 等原始编码与换行格式。
- **命令执行与项目检查。** `shell` 运行单次命令，`job` 托管后台服务与交互式进程，`check` 自动识别并运行项目的 `types`、`lint`、`test` 与 `build` 任务。开启 `beforeTests` 后，本轮修改过的测试文件还会在改动前的代码上运行一次，确认测试能捕获原问题。
- **跨家族 Shadow tests。** 把 `shadowTests.model` 设成另一家族的模型后，这个模型只看用户需求，在项目副本里独立写测试来验证修改。在 52 个 Go 修复任务中通过数从 `20 / 52` 提升至 `23 / 52`，改坏已有修复 `0` 次。
- **浏览器检查与画布绘制。** `browser` 通过带编号的元素引用如 `[e7] button "Save"` 驱动无头 Chrome 或 Edge，支持多标签页、弹窗处理、文件下载与接管本机已打开的浏览器，并支持单次同时打开桌面 `1280×800` 与手机 `390×844` 两种宽度，返回截图及控制台报错、横向溢出、WCAG AA 对比度不足、点击热区过小与失效图片检查结果。`paint` 支持分层画布渲染并输出 PNG。
- **联网搜索与网页抓取。** OpenAI Responses 接口模型可调用原生搜索，其余模型使用内置的 DuckDuckGo 与 Bing 搜索，也可配置 Brave 与 SearXNG。`web_fetch` 自动识别网页字符编码，并通过官方 API 读取 GitHub、Stack Overflow 与包管理仓库。

### 上下文管理

- **固定前缀保障缓存命中。** System Prompt 与工具定义在会话启动时生成一次，后续轮次保持逐字节一致，使云端供应商的提示词缓存与本机 `llama.cpp` 的 KV 缓存持续生效。
- **按真实窗口动态分配。** 上下文预算、工具输出上限与压缩阈值均按供应商接口或 [models.dev](https://models.dev) 返回的真实窗口计算，`context.limit` 默认把单次窗口上限设为 `256,000` token，也可按模型单独覆盖。
- **兼顾缓存收益的旧输出裁剪。** 窗口用量超过 `50%` 后，仅当节省的缓存 token 超过重写前缀的开销时，才会裁剪已被取代或较早的大段工具输出。完整内容保留在磁盘上，模型可随时通过 `recall` 按调用 ID 或关键词调回。
- **后台预写摘要与工作记录核对。** 达到压缩阈值 `compactAt` 默认 `0.82` 的 `75%` 时，后台即开始生成摘要，到达阈值时直接切换，无需中断当前工作。用户的每条原始消息均逐字保留，并附上 Favilla 独立记录的已读文件行段、修改文件与命令退出状态。在 DeepSeek 对 63 个真实编码会话切点的测试中，附带工作记录时此前命令结果的回忆准确率为 `87%`，仅靠摘要为 `51%`。

### 多模型、Sub-agent 与版本回退

- **会话中途切换模型。** 默认使用统一的 `"tools": "favilla"` 工具集，中途切换模型或供应商无需压缩历史。`"tools"` 设为 `"auto"` 时，自动切换为对应模型家族原生训练的工具格式，GPT 模型使用 `shell_command` 与 `apply_patch`，Anthropic 模型使用 `Read`、`Edit`、`Bash` 与 `Grep`。
- **推理内容完整回传。** 跨工具轮次保留 Anthropic 思考签名、OpenAI 加密推理条目、Gemini 思考签名，以及兼容接口要求的 `reasoning_content` 或 `<think>` 字段。按模型开放支持的思考强度档位 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，接口拒绝某档位时自动记忆并降级重试。
- **限定文件范围的 Sub-agent。** 具备写权限的 `Sub-agent` 仅可修改分配给它的文件路径，路径可能重叠的任务按顺序执行。每份 `Sub-agent` 报告末尾均自动附上实际改动文件数、增删行数、执行命令与退出码。
- **逐轮快照与对话分支。** 每一轮自动为工作区建立快照，`/undo` 或界面还原点可一并撤回文件编辑与命令产生的改动。任意历史消息均可编辑重发或创建新分支，异常中断的工具调用在重新打开会话时自动恢复。

### 扩展、邮件与远程访问

- **MCP 服务器与 Skills。** `mcpServers` 支持连接本地 `stdio` 命令、Streamable HTTP 与 SSE 服务，一次启动即可在所有会话中复用。`Skills` 自动扫描 `.favilla/skills`、`~/.favilla/skills`、`~/.agents/skills` 与 `~/.claude/skills` 下的 `SKILL.md`，以单行摘要提供给模型并按需加载全文。
- **邮箱、人设与预设。** “设置 > 邮箱”支持通过应用专用密码接入 IMAP / SMTP 邮箱以搜索、整理邮件和撰写草稿，默认每封邮件发送前均需确认。“人设”支持导入角色卡，“预设”支持导入 SillyTavern 对话补全预设的提示词层级、角色、深度、宏与预填充内容，忽略其中的模型与代理字段。
- **Windows 桌面控制。** 默认关闭 `computer: false`。在 Windows 上开启后，Agent 可截取屏幕并执行鼠标点击与键盘输入，把鼠标移到屏幕左上角就能立即中止。
- **端到端加密的手机远程访问。** 在“设置 > 远程”中扫码即可配对手机，加密实现见 `packages/core/src/remote/e2e.ts`。同一 Wi-Fi 下手机扫码直接连接本机，不在同一网络时，可以把 `packages/relay` 部署到 Cloudflare Workers，运行 `pnpm --filter @favilla/web build && cd packages/relay && npx wrangler deploy`，再把生成的地址填进“设置 > 远程 > 中继服务”。

## 供应商与配置

### 内置供应商

| 供应商 | ID | 环境变量 | 默认地址与说明 |
|---|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` | `https://api.openai.com/v1` · Responses API |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` | `https://api.anthropic.com` |
| Google Gemini | `gemini` | `GEMINI_API_KEYS`、`GEMINI_API_KEY`、`GOOGLE_API_KEY` | 逗号分隔多个密钥时遇限流自动轮换 |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` |
| Moonshot Kimi | `moonshot` | `MOONSHOT_API_KEY`、`KIMI_API_KEY` | `https://api.moonshot.cn/v1` |
| Zhipu GLM | `zhipu` | `ZHIPU_API_KEY`、`GLM_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` |
| Alibaba Qwen | `dashscope` | `DASHSCOPE_API_KEY` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| MiniMax | `minimax` | `MINIMAX_API_KEY` | `https://api.minimaxi.com/v1` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| xAI | `xai` | `XAI_API_KEY` | `https://api.x.ai/v1` |
| 本机服务 | `local` | 无 | `http://127.0.0.1:8080/v1` · 支持 `llama.cpp`、vLLM、LM Studio |
| Ollama | `ollama` | 无 | `http://127.0.0.1:11434/v1` |

可在“设置 > 供应商”或 `~/.favilla/config.json` 中添加任意兼容 OpenAI Chat、OpenAI Responses、Anthropic 或 Gemini 接口的自定义服务，并手动补充模型 ID、上下文窗口大小与图片输入支持。

### `~/.favilla/config.json`

全局配置保存在 `~/.favilla/config.json`，支持带注释的 JSONC 格式。全局规则保存在 `~/.favilla/AGENTS.md`，项目级规则自动读取仓库下的 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 或 `.github/copilot-instructions.md`。

```jsonc
{
  "model": "anthropic/claude-sonnet-5-5",
  "effort": "high",                     // off、minimal、low、medium、high、xhigh、max
  "proxy": "http://127.0.0.1:7890",     // 仅作用于远程供应商，本机服务始终直连
  "providers": {
    "local": { "baseUrl": "http://127.0.0.1:8090/v1" },
    "gemini": { "keyFile": "/path/to/gemini.env" },
    "openai": { "models": { "gpt-6-luna": { "contextWindow": 400000 } } }
  },
  "guard": { "mode": "confirm" },       // "confirm"、"block" 或 "off"
  "context": {
    "compactAt": 0.82,
    "limit": 256000
  },
  "webSearch": true,                    // true、false、"provider" 或 "builtin"
  "skills": true,                       // true、false 或额外 Skills 目录列表
  "shell": "bash",                      // bash、pwsh、powershell、cmd 或可执行文件路径
  "tools": "favilla",                   // "favilla" 或 "auto"
  "computer": false,
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } },
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }
  }
}
```

### 安全边界与本地存储

- **危险命令确认。** 递归删除根目录、主目录或工作区外路径，丢弃未 `commit` 的 Git 改动，`force push` 与改写历史，磁盘、引导与电源操作，按名称结束进程，发布软件包以及删除数据库前均需确认，无界面模式下直接拒绝执行。子进程耗尽系统内存时由 `memoryGuard` 自动中止。
- **项目配置隔离。** 仓库内的 `.favilla/config.json` 仅可设置模型、思考强度、上下文参数、规则、Skills 与工具风格，无法覆盖 `providers`、API 密钥、`proxy`、`mcpServers`、`shell`、`browser`、`computer`、`remote` 或 `guard`。
- **去重压缩与静态加密。** 图片、长输出与文件快照在 Brotli 块存储中按内容去重，闲置会话自动重打包压缩，本地会话数据默认使用系统账户密钥库加密保存，可通过 `storage.encrypt` 配置。

## 界面与快捷键

### 终端界面 · `fav`

回复按完成段落逐块输出，避免整屏重绘，内置 `diff`、检查结果、搜索结果与运行中 `Sub-agent` 的单行实时状态展示。支持在 `~/.favilla/commands` 与 `.favilla/commands` 中放置 Markdown 文件定义斜杠命令，使用 `$ARGUMENTS` 接收参数。

| 快捷键 | 功能 |
|---|---|
| `Enter` / `Shift+Enter`、`Alt+Enter`、`Ctrl+J` | 发送消息 / 换行 |
| `Esc` / `Esc Esc` | 停止当前轮次 / 回到先前的消息修改重发或创建分支 |
| `Shift+Tab` | 切换默认模式与规划模式 |
| `Alt+V` · 非 Windows 为 `Ctrl+V` | 粘贴剪贴板图片 |
| `↑` / `Ctrl+R` | 浏览历史输入 / 搜索历史输入 |
| `Ctrl+G` / `Ctrl+T` | 在 `$EDITOR` 中编辑输入 / 打开可搜索的完整对话记录 |
| `@路径` / `!命令` | 附加文件 / 立即运行命令，输出交给 Agent |

内置命令：`/model`、`/effort`、`/plan`、`/rewind`、`/fork`、`/diff`、`/undo`、`/agents`、`/transcript`、`/context`、`/compact`、`/rules`、`/persona`、`/preset`、`/copy`、`/export`、`/review`、`/init`、`/new`、`/resume`、`/status`、`/settings`、`/cost`、`/help`、`/exit`。

### 桌面应用与浏览器界面 · `fav web`

引擎运行在独立子进程中，通过带随机令牌的本机端口提供界面，耗时任务不会阻塞窗口渲染。提供可展开的步骤时间线、按轮次查看 `diff` 与还原点、按比例绘制的上下文窗口剖面、“设置 > 用量”本机 token / 费用 / 速度统计、手机端简易与完整双布局、10 种界面语言，以及 9 款主题：`Drafting`、`Night shift`、`Kiln`、`Kiln at night`、`Clear sky`、`Night flight`、`Daylight`、`Porcelain`、`Plain`。

| 快捷键 | 功能 |
|---|---|
| `Ctrl+K` | 打开命令面板 |
| `Ctrl+N` / `Ctrl+O` | 新建会话 / 打开文件夹 |
| `Ctrl+B` / `Ctrl+Alt+B` | 展开或收起侧边栏 / 右侧面板 |
| `Esc` | 停止当前轮次 |
| `Ctrl+,` | 打开设置 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 放大 / 缩小 / 重置缩放 |

## 平台支持与源码构建

| 平台 | 支持状态 |
|---|---|
| Windows 10 / 11 · x64 | 主力平台，提供桌面安装包、便携版 `.exe`、CLI、浏览器界面与桌面控制。 |
| Linux | 支持 CLI 与浏览器界面，CI 与容器环境通过类型检查与测试，暂不提供桌面安装包。 |
| macOS | 支持 CLI 与浏览器界面，CI 通过类型检查与测试，暂不提供桌面安装包。 |

从源码运行需安装 `Node.js 22+` 与 `pnpm 9+`：

```bash
git clone https://github.com/benelatuit/favilla && cd favilla
pnpm install
pnpm fav                                # 从源码启动终端界面
pnpm fav web                            # 从源码启动浏览器界面
pnpm --filter @favilla/desktop start    # 从源码启动 Electron 桌面应用
pnpm --filter @favilla/desktop dist     # 构建 Windows 安装包与便携版 exe
pnpm typecheck && pnpm test             # 运行全仓库类型检查与测试套件
```

目录结构详见 `AGENTS.md`：

```text
packages/core      引擎核心：Agent 循环、供应商适配、工具、上下文压缩、会话存储与本地服务
packages/cli       fav / favilla 命令行入口与终端界面
packages/web       React 界面与主题，供桌面应用、浏览器界面与手机远程页面共用
packages/desktop   Electron 主进程、独立引擎进程与 Windows 打包脚本
packages/relay     用于手机端到端加密远程访问的 Cloudflare Worker 中继服务
```

## 许可证

MIT，作者 Bene Latuit。
