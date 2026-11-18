<p align="center"><img src="packages/web/public/icon.png" width="88" alt="Favilla"></p>

<h1 align="center">Favilla</h1>

<p align="center">Open-source AI agent for the terminal, desktop, and browser.</p>

<p align="center"><a href="https://favilla.melodybounce.com/">Website</a> · <a href="https://github.com/benelatuit/favilla/releases">Releases</a> · <a href="README.zh-CN.md">中文说明</a></p>

Favilla runs coding, document, web research, email, and Windows desktop tasks from one engine across three interfaces: a terminal UI (`fav`), a desktop app, and a browser UI (`fav web`). It connects to OpenAI, Anthropic, Gemini, DeepSeek, Kimi, GLM, Qwen, MiniMax, OpenRouter, xAI, Ollama, `llama.cpp`, or any compatible endpoint using your own API keys or local models.

## Install

### Windows 10 / 11 (Desktop App + CLI)

```powershell
irm https://favilla.melodybounce.com/install.ps1 | iex
```

Downloads the current release, verifies its SHA-256 checksum, and installs the desktop app plus `fav` and `favilla` for the current user without administrator rights. Installed copies check for updates in the background and apply them on restart (`Settings > General` or `updates.check: false` disables the check). Standalone `.exe` installers and portable `.exe` builds are also available on [Releases](https://github.com/benelatuit/favilla/releases).

### macOS, Linux, and Windows CLI (`Node.js 22+`)

```bash
npm install -g favilla
```

Installs the `fav` and `favilla` CLI commands and the `fav web` browser UI. Re-run the same command to update.

## Quick Start

Configure an API key in the app under `Settings > Providers`, or export a provider environment variable:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # or OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, ...
```

Run Favilla inside any project directory:

```bash
fav                                     # interactive terminal UI
fav "fix the failing prorate test"      # open terminal UI and start with this prompt
fav -p "fix the failing prorate test"   # single headless run for scripts and CI
git diff | fav -p "review this patch"   # pipe stdin into a headless run
fav -c                                  # resume the latest session in this folder
fav web                                 # open the browser UI on 127.0.0.1
favilla models                          # list configured providers and discovered models
favilla sessions                        # list saved sessions in this folder (-a for all)
favilla mcp                             # verify configured MCP servers and list tools
```

## Capabilities

### Code, Documents, and Web

- **Batched file and document reading.** `read` accepts multiple file paths and line ranges in one call, lists directories, extracts PDFs and Office files (`.docx`, `.xlsx`, `.pptx`), reads Jupyter notebooks (`.ipynb`, edited via `notebook_edit`), and inspects images with optional region zoom for small text.
- **Code search.** `search` runs regex content queries, file-name globs, and ranked code queries written in plain language.
- **Syntax-checked edits.** `edit` applies multiple replacements in one call, falls back from exact match to whitespace- and drift-tolerant matching, rejects ambiguous targets with line numbers, runs syntax checks on TypeScript, JavaScript, Python, JSON, and YAML, queries language servers when installed, and preserves file encodings such as GBK and CRLF.
- **Commands and project checks.** `shell` runs one-shot commands, `job` manages background servers and interactive processes, and `check` runs detected `types`, `lint`, `test`, and `build` tasks. When `beforeTests` is enabled, modified test files are also run against the pre-change code to confirm they fail without the fix.
- **Cross-family shadow tests.** Setting `shadowTests.model` to a model from a second family runs an independent test writer in a project copy from the user prompt alone (`23 / 52` vs `20 / 52` Go bug-fix tasks passed, `0` fixes broken).
- **Browser inspection and painting.** `browser` drives headless Chrome or Edge via numbered element refs (`[e7] button "Save"`), handles tabs, dialogs, and downloads, can attach to an open Chrome or Edge session, and checks desktop (`1280×800`) and mobile (`390×844`) widths in one pass for console errors, horizontal overflow, WCAG AA contrast failures, undersized tap targets, and broken images. `paint` renders layered canvas scenes to PNG.
- **Web search and fetch.** OpenAI Responses models can use native provider search; all other models use built-in DuckDuckGo and Bing search (plus Brave and SearXNG when configured). `web_fetch` decodes page charsets and reads GitHub, Stack Overflow, and package registries via their APIs.

### Context Management

- **Stable prompt prefix.** System instructions and tool schemas are built once per session and kept byte-identical across turns so provider prompt caches and local `llama.cpp` KV caches stay warm.
- **Real window sizing.** Token budgets, output caps, and compaction thresholds scale to each model's reported window or [models.dev](https://models.dev) metadata, capped at `256,000` tokens by default (`context.limit`).
- **Cache-aware pruning.** Past `50%` of the active window, superseded or large older tool outputs are trimmed only when cached-token savings exceed the prefix rewrite cost. Full outputs stay on disk and remain searchable via `recall`.
- **Background compaction with a work record.** At `75%` of `compactAt` (default `0.82`), Favilla drafts the summary in the background and swaps it in at the threshold without pausing execution. User prompts stay verbatim, paired with Favilla's own ledger of files read, files modified, and command exit statuses (`87%` vs `51%` recall of earlier command outcomes on DeepSeek across `63` coding-session cut points).

### Models, Sub-agents, and History

- **Mid-session model switching.** All models share Favilla's default tool set, so switching providers mid-session does not force compaction. Setting `"tools": "auto"` switches to model-family-specific schemas (`shell_command` + `apply_patch` on GPT models, `Read` / `Edit` / `Bash` / `Grep` on Anthropic models).
- **Reasoning replay.** Preserves Anthropic thinking signatures, OpenAI encrypted reasoning items, Gemini thought signatures, and compatible `reasoning_content` or `<think>` blocks across tool loops. Effort levels adapt per model (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) and step down automatically if an endpoint rejects a level.
- **File-scoped Sub-agents.** Write-capable Sub-agents can modify only their assigned paths; overlapping assignments run sequentially. Each Sub-agent report appends Favilla's verified diff counts, command list, and exit codes.
- **Per-turn snapshots and branches.** Workspace snapshots record both agent edits and shell command file changes per turn (`/undo` or UI restore points put them back). Any earlier message can be edited or forked into a new branch, and interrupted tool calls recover cleanly on reopen.

### Extensions, Mail, and Remote Access

- **MCP servers and Skills.** `mcpServers` connects `stdio` commands, Streamable HTTP endpoints, and SSE servers once across sessions. `Skills` (`SKILL.md` folders in `.favilla/skills`, `~/.favilla/skills`, `~/.agents/skills`, and `~/.claude/skills`) expose one-line summaries and load on demand.
- **Mail, Personas, and Presets.** `Settings > Mail` connects IMAP/SMTP accounts with app passwords for search, triage, and drafting, asking before every send by default. `Personas` imports character cards, and `Presets` loads SillyTavern chat-completion prompt stacks, roles, depths, macros, and prefill while ignoring model and proxy fields.
- **Windows computer control.** Disabled by default (`computer: false`). When enabled on Windows, the agent can capture screenshots and send mouse and keyboard actions; moving the cursor to the top-left corner aborts control immediately.
- **End-to-end encrypted phone access.** Pair a phone via QR code in `Settings > Remote` (`packages/core/src/remote/e2e.ts`). On the same Wi-Fi, the phone connects directly to the computer over the local network; from outside networks, deploy `packages/relay` to Cloudflare Workers (`pnpm --filter @favilla/web build && cd packages/relay && npx wrangler deploy`) and set its URL in `Settings > Remote`.

## Providers and Configuration

### Built-in Providers

| Provider | ID | Environment Variable | Default Endpoint / Notes |
|---|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` | `https://api.openai.com/v1` (Responses API) |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | `https://api.anthropic.com` |
| Google Gemini | `gemini` | `GEMINI_API_KEYS`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` | Comma-separated keys rotate on rate limits |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` |
| Moonshot Kimi | `moonshot` | `MOONSHOT_API_KEY`, `KIMI_API_KEY` | `https://api.moonshot.cn/v1` |
| Zhipu GLM | `zhipu` | `ZHIPU_API_KEY`, `GLM_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` |
| Alibaba Qwen | `dashscope` | `DASHSCOPE_API_KEY` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| MiniMax | `minimax` | `MINIMAX_API_KEY` | `https://api.minimaxi.com/v1` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| xAI | `xai` | `XAI_API_KEY` | `https://api.x.ai/v1` |
| Local server | `local` | None | `http://127.0.0.1:8080/v1` (`llama.cpp`, vLLM, LM Studio) |
| Ollama | `ollama` | None | `http://127.0.0.1:11434/v1` |

Custom OpenAI Chat, OpenAI Responses, Anthropic, and Gemini endpoints (plus manual model IDs, context windows, and vision flags) can be added in `Settings > Providers` or `~/.favilla/config.json`.

### `~/.favilla/config.json`

Global settings live in `~/.favilla/config.json` (JSON with comments). Standing instructions load from `~/.favilla/AGENTS.md` globally and `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or `.github/copilot-instructions.md` per repository.

```jsonc
{
  "model": "anthropic/claude-sonnet-5-5",
  "effort": "high",                     // off, minimal, low, medium, high, xhigh, max
  "proxy": "http://127.0.0.1:7890",     // remote providers only; local servers connect directly
  "providers": {
    "local": { "baseUrl": "http://127.0.0.1:8090/v1" },
    "gemini": { "keyFile": "/path/to/gemini.env" },
    "openai": { "models": { "gpt-6-luna": { "contextWindow": 400000 } } }
  },
  "guard": { "mode": "confirm" },       // "confirm", "block", or "off"
  "context": {
    "compactAt": 0.82,
    "limit": 256000
  },
  "webSearch": true,                    // true, false, "provider", or "builtin"
  "skills": true,                       // true, false, or extra directory paths
  "shell": "bash",                      // bash (Git Bash on Windows), pwsh, powershell, cmd, or path
  "tools": "favilla",                   // "favilla" or "auto"
  "computer": false,
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } },
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }
  }
}
```

### Safety, Permissions, and Storage

- **Destructive-command guard.** Recursive deletes outside or across workspace roots, discarding uncommitted Git work, force pushes, history rewrites, disk/boot/power commands, killing processes by name, package publishing, and database drops pause for confirmation (or fail closed in headless mode). Runaway child processes that exhaust system RAM are terminated automatically (`memoryGuard`).
- **Workspace trust boundary.** A repository's `.favilla/config.json` can set models, effort, context, instructions, skills, and tool profiles, and cannot override `providers`, API keys, `proxy`, `mcpServers`, `shell`, `browser`, `computer`, `remote`, or `guard`.
- **Local storage.** Images, large outputs, and snapshots are deduplicated in a Brotli blob store, idle sessions are repacked and compressed, and session data is encrypted at rest under the OS account key store (`storage.encrypt`, enabled by default).

## Interfaces

### Terminal UI (`fav`)

Streams completed blocks without full-screen redraws, formats diffs, checks, searches, and live Sub-agent progress inline, and supports custom Markdown slash commands in `~/.favilla/commands` and `.favilla/commands` (`$ARGUMENTS`).

| Shortcut | Action |
|---|---|
| `Enter` / `Shift+Enter`, `Alt+Enter`, `Ctrl+J` | Send message / insert newline |
| `Esc` / `Esc Esc` | Stop active turn / rewind to edit or branch an earlier message |
| `Shift+Tab` | Toggle default and plan mode |
| `Alt+V` (`Ctrl+V` on macOS/Linux) | Paste clipboard image |
| `↑` / `Ctrl+R` | History / search history |
| `Ctrl+G` / `Ctrl+T` | Edit prompt in `$EDITOR` / open searchable full transcript |
| `@path` / `!command` | Attach file / run command and attach output |

Built-in commands: `/model`, `/effort`, `/plan`, `/rewind`, `/fork`, `/diff`, `/undo`, `/agents`, `/transcript`, `/context`, `/compact`, `/rules`, `/persona`, `/preset`, `/copy`, `/export`, `/review`, `/init`, `/new`, `/resume`, `/status`, `/settings`, `/cost`, `/retry`, `/help`, `/exit`.

### Desktop App and Browser UI (`fav web`)

Runs the agent engine in a separate utility process behind a random loopback token so heavy steps do not block the UI. Includes an expandable step timeline, per-turn file diffs and restore points, a scaled context-window breakdown, local-only token/cost/speed charts (`Settings > Usage`), Simple and Full mobile layouts, 10 UI languages, and 11 themes in `Settings > Appearance` (`Drafting`, `Night shift`, `Kiln`, `Kiln at night`, `Clear sky`, `Night flight`, `Daylight`, `Porcelain`, `Plain`, `Gesso`, `Lampblack`).

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Command palette |
| `Ctrl+N` / `Ctrl+O` | New session / open folder |
| `Ctrl+B` / `Ctrl+Alt+B` | Toggle sidebar / side panel |
| `Esc` | Stop active turn |
| `Ctrl+,` | Open settings |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |

## Platforms and Building from Source

| Platform | Status |
|---|---|
| Windows 10 / 11 (x64) | Primary platform. Desktop installer, portable `.exe`, CLI, browser UI, and computer control. |
| Linux | CLI and browser UI; typecheck and test suite verified in CI and containers. No packaged desktop installer. |
| macOS | CLI and browser UI; typecheck and test suite verified in CI. No packaged desktop installer. |

Requires `Node.js 22+` and `pnpm 9+`:

```bash
git clone https://github.com/benelatuit/favilla && cd favilla
pnpm install
pnpm fav                                # run terminal UI from source
pnpm fav web                            # run browser UI from source
pnpm --filter @favilla/desktop start    # run Electron desktop app from source
pnpm --filter @favilla/desktop dist     # build Windows installer and portable exe
pnpm typecheck && pnpm test             # run workspace typecheck and test suite
```

Repository layout (`AGENTS.md` documents development conventions):

```text
packages/core      agent loop, providers, tools, context compaction, session store, local server
packages/cli       fav / favilla CLI commands and terminal UI
packages/web       React UI and themes (shared by desktop app, browser UI, and phone web view)
packages/desktop   Electron main/engine processes and Windows packaging
packages/relay     Cloudflare Worker relay for end-to-end encrypted phone access
```

## License

MIT, by Bene Latuit.
