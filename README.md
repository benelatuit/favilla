<p align="center"><img src="packages/web/public/icon.png" width="96" alt=""></p>

<h1 align="center">Favilla</h1>

<p align="center">An open-source, general-purpose AI agent for the terminal and the desktop.</p>

<p align="center"><a href="https://favilla.melodybounce.com/">Website</a> · <a href="https://github.com/benelatuit/favilla/releases">Downloads</a> · <a href="README.zh-CN.md">中文说明</a></p>

Favilla handles coding, documents, web research, email and computer tasks, and keeps a record of each step. It works with OpenAI, Anthropic, Gemini, DeepSeek, Kimi, GLM, Qwen, OpenRouter, xAI, any OpenAI-compatible server, or a model running on your own machine. One engine drives three front ends: a terminal UI, a desktop app and a page in your browser. Long sessions keep going past the context window: compaction runs in the background, keeps what you said word for word, and is checked against what the agent actually read and ran.

## Compaction for long sessions

A long task outgrows any context window. Favilla compacts without stopping the work and keeps the facts the work depends on.

- **Written in the background.** From three quarters of the way to the compaction point the summary is written while the agent keeps working. At the point it is swapped in, and everything since it was started stays word for word.
- **Your words, word for word.** Every message you sent is carried verbatim through every summary, so a rule given at the start still holds after many compactions. When they run very long, the oldest keep their start and `recall` finds the rest. The last tool rounds stay word for word as well.
- **A record beside the summary.** Favilla keeps its own record of which lines of which files were read, which files were made or changed, and how each command last ended. The summary is checked against it and the record goes in with it, so what the model carries forward matches what was actually read and run. With the record the model knew how earlier commands had ended in 87% of cases, against 51% from the summary alone (DeepSeek, 63 cut points in real coding work, 2026-11-05).
- **Light trimming first.** From half the window on, tool output that a later call superseded, or that is large and from earlier steps, is cut to a short stub, and only when the saving outweighs what the cut costs the provider's prompt cache. The full text stays on disk: `recall` brings it back by call id or searches the whole history.
- **Sized from the real window.** Budgets, tool-output caps and the compaction point come from the model's actual window, read from the provider or from [models.dev](https://models.dev), and each model's window can be set by hand.
- **Visible.** The side panel draws the context as a cross-section of what it holds (system prompt, tools, summary, conversation, reasoning, tool output, trimmed output), marks where trimming and compaction start, and counts the compactions so far.

## Install

On macOS and Linux, with Node.js 22 or later:

```bash
npm install -g favilla
```

It installs the `favilla` and `fav` commands. The terminal UI says when a new version is out; run the same command to update.

On Windows 10 or 11, in PowerShell:

```powershell
irm https://favilla.melodybounce.com/install.ps1 | iex
```

It installs the desktop app with the `favilla` and `fav` commands for your user, with no administrator rights, and checks the download against its SHA-256 first. The app checks for new versions, downloads one in the background and installs it when you click Restart to update (Settings > Updates turns the check off). Running the line again also updates. The installer and a portable exe are also on the [releases page](https://github.com/benelatuit/favilla/releases). For the commands without the desktop app, `npm install -g favilla` works on Windows too.

Then, in a project folder:

```bash
fav                               # the terminal UI
fav -p "fix the failing test"     # one run without the UI, for scripts and CI
git diff | fav -p "review this"   # with piped input
fav web                           # the same UI in your browser
```

Add a model in the app under Settings > Providers, or set a provider's key variable (see [Models](#models)).

## From source

On Linux and macOS, or to work on Favilla itself, you need Node 22 or newer and pnpm 9.

```bash
git clone https://github.com/benelatuit/favilla && cd favilla
pnpm install
export ANTHROPIC_API_KEY=...            # or any provider's key, see "Models" below
pnpm fav                                # terminal UI in the current folder
pnpm fav -p "fix the failing test"      # one run without the UI
pnpm fav web                            # the same UI in your browser
pnpm --filter @favilla/desktop start    # the desktop app from source
pnpm --filter @favilla/desktop dist     # Windows installer and portable exe in packages/desktop/release
```

## Features

### Working on code

- **Batched tool calls.** `read` takes several files and line ranges at once, along with folders, images, notebooks and PDFs. `search` covers contents and file names, and also takes a plain question ("where are failed uploads retried") to find code by what it does. `edit` makes several exact replacements in one call and names any that did not match. `shell` runs commands, and hands servers and interactive programs to `job`.
- **Edit matching.** Matching is exact first, then tolerates whitespace, indentation, escaping and drift, and refuses ambiguous matches with line numbers. Every edit is followed by a syntax check (TypeScript, JavaScript, Python, JSON, YAML), so a broken bracket is reported next to the edit that caused it. Files keep their encoding: GBK stays GBK.
- **The same tools for every model.** A session can switch models without compacting. If you prefer the tool sets models were trained on, `"tools": "auto"` gives GPT models `shell_command` with `apply_patch` and Anthropic models `Read / Edit / Bash / Grep`.
- **Reasoning replay.** Anthropic thinking blocks keep their signatures, OpenAI reasoning items their encrypted content, Gemini parts their thought signatures, and compatible APIs get `reasoning_content` or `<think>` back the way each family expects.
- **Sub-agents.** A sub-agent that changes files can change only the files assigned to it, and sub-agents whose files could overlap run one after another. Each report ends with Favilla’s own record: files changed, lines added and removed, commands and exit codes.
- **Branches and undo.** Any sent message can be edited and sent again as a new branch, and any answer can start one. Every file the agent changes is snapshotted per turn, so `/undo` or the app can restore a turn.

### Long sessions

- **Stable prompt prefix.** The system prompt and tools are built once per session and are not changed afterwards. The prefix stays byte for byte the same, which keeps prompt caching effective with every provider, llama.cpp's KV cache included.
- **Effort levels per model.** The effort picker offers what the model takes, `max` included. A level a server refuses is read from the error, remembered, and the request is sent again at the nearest level it accepts.
- **Crash recovery.** A tool call left without a result when Favilla closed is answered when the session reopens. Ctrl+C and closing the app end the turn cleanly and stop its background jobs.

### Checks

- **Page checks.** After a turn changes a page that runs without a build step, Favilla opens it at desktop and phone width in a headless browser and reports console errors, horizontal scrolling, text below WCAG AA contrast, controls too small to tap and images that failed to load.
- **Browser tool.** Each page comes back as a list of interactive elements with refs (`[e7] button "Save"`) to click, fill and upload by. It follows new tabs, answers dialogs, keeps downloads, and renders at any width (390 px is a phone).
- **Web search.** GPT models on the OpenAI API use OpenAI's own search. Every other model gets a built-in search over DuckDuckGo and Bing, with Brave and SearXNG when you add them. Pages are read as text, in their own charset; GitHub, Stack Overflow and package registries are read through their APIs.
- **Images.** Reading an image gives its size, and reading a region shows that part enlarged, so small text can be read. `draw` renders SVG to PNG with a check sheet; `paint` keeps a canvas between calls and paints with real media.
- **Answer checks.** Code changed after the last run gets one reminder to run the checks. A message with several asks gets a short check of what the answer left out. After two failed attempts in a row, the effort goes up a level for the rest of the turn.
- **Tests from another model.** With `shadowTests.model` set to a model from another family, a fix gets tests written by that model from the request alone, in a copy of the project. A test that fails on the change sends the work back once.

### Other features

- **MCP servers.** Servers under `mcpServers` (a local command, or a URL speaking streamable HTTP or SSE) start once, and their tools reach every session. `favilla mcp` lists them.
- **Skills.** Skill folders (a `SKILL.md` with a name and description) in `.favilla/skills`, `~/.favilla/skills`, `~/.agents/skills` or `~/.claude/skills` are listed one line each; the model reads one when the task matches.
- **Mail.** Settings > Mail takes Gmail and other mailboxes with an app password. The agent searches, reads, sorts and drafts; every email it would send is shown to you first.
- **SillyTavern presets.** A chat-completion preset's prompts go into each request in their own layers, roles and depths, with macros and prefill. Only prompts and prefill are read. Model, temperature and proxy settings in the preset are ignored.
- **Computer control, off by default.** On Windows the agent can take screenshots, click, type and press keys. Moving the mouse to the top-left corner stops it.
- **Remote control from your phone.** Pair a phone by QR code and follow sessions, send messages and answer approvals from it, directly on the same Wi-Fi or through a relay you run yourself. See [Remote control](#remote-control).
- **Disk and memory use.** Images, long outputs and file snapshots live once in a compressed blob store; an idle session is repacked and compressed (one long session went from 36 MB to 0.3 MB). The agent's browser closes a few minutes after its last use.

## Safety

Commands that can cause loss need confirmation: recursive deletes of a root, your home, the workspace or folders outside it; discarding uncommitted git work; force pushes and history rewrites; disk, boot and power commands; killing processes by name; publishing packages; dropping databases. They wait for your confirmation and are refused in unattended runs. Other commands run without asking. A command that would use up the computer's memory is stopped, and the agent is told to run a narrower one.

A project's `.favilla/config.json` can set models, instructions, skills and the tool style, but not providers, keys, MCP servers, the shell or approvals, so a repository you open cannot change your keys, run programs or turn approvals off.

## Models

- **API keys.** Set the usual variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or a comma-separated `GEMINI_API_KEYS` that rotate on rate limits, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZHIPU_API_KEY`, `DASHSCOPE_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`), or paste the key in Settings > Providers.
- **A local model.** Any OpenAI-compatible server. The `local` provider points at llama.cpp's default port; change `providers.local.baseUrl` for another.
- **A server of your own.** Settings > Providers > Add a provider takes any server with an OpenAI-compatible, OpenAI Responses, Anthropic or Gemini API: a name, the address and a key.
- **Models a server does not list.** Under any provider in Settings > Providers, Add a model takes its id. Its window and whether it reads pictures are set under Models.

`favilla models` lists what each provider serves.

## Configuration

Settings in the app write `~/.favilla/config.json`; you can also edit it by hand (comments are allowed). A project's `.favilla/config.json` overrides the parts listed under [Safety](#safety).

```jsonc
{
  "model": "anthropic/claude-sonnet-5-5",
  "effort": "medium",                 // off, minimal, low, medium, high, xhigh, max: what the model supports
  "proxy": "http://127.0.0.1:7890",   // for remote providers; local ones always connect directly
  "providers": {
    "local": { "baseUrl": "http://127.0.0.1:8090/v1" },
    "gemini": { "keyFile": "/path/to/gemini.env" },
    "openai": { "models": { "gpt-6-luna": { "contextWindow": 400000 } } }   // a model's window, set by hand
  },
  "guard": { "mode": "confirm" },     // or "off"
  "webSearch": true,                  // false, or "builtin" / "provider" to choose the search
  "skills": true,                     // false, or a list of extra skill folders
  "shell": "bash",                    // bash (Git Bash on Windows), pwsh, powershell, cmd, or a path
  "tools": "favilla",                 // Favilla's own tools, or "auto" for the ones each model family was trained on
  "computer": false,                  // true lets the agent use this computer's screen, mouse and keyboard (Windows)
  "context": { "compactAt": 0.82 },   // compact once the context is this full
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } },
    "browser": { "command": "npx", "args": ["@playwright/mcp@latest"] }
  }
}
```

Standing instructions go in `~/.favilla/AGENTS.md` for every project, and in a project's own `AGENTS.md` or `CLAUDE.md`. Settings > Rules edits them in place.

## Terminal UI

`fav` (or `favilla`) in a folder opens the terminal UI. Replies are printed block by block as each block completes, so long answers do not redraw the screen. Diffs, commands, checks and search results each have their own layout, and every sub-agent at work keeps a live line with its current step.

| Keys | |
|---|---|
| Enter / Shift+Enter, Alt+Enter, Ctrl+J | send / new line |
| Esc / Esc Esc | stop the agent / go back to an earlier message to edit it or branch from it |
| Shift+Tab | plan mode on or off |
| Alt+V (Ctrl+V outside Windows) | paste a picture from the clipboard |
| ↑ / Ctrl+R | history / search it |
| Ctrl+G / Ctrl+T | edit the message in `$EDITOR` / read the whole transcript with search |
| `@path`, `!command` | attach a file / run a command and hand its output to the agent |

Commands: `/model`, `/effort`, `/plan`, `/rewind`, `/fork`, `/diff`, `/undo`, `/agents`, `/transcript`, `/context`, `/compact`, `/rules`, `/persona`, `/preset`, `/copy`, `/export`, `/review`, `/init`, `/new`, `/resume`, `/status`, `/settings`, `/cost`, `/help`, `/exit`. Markdown files in `~/.favilla/commands` or `.favilla/commands` become commands of your own, with `$ARGUMENTS` for what follows the name.

**Personas.** `/persona import FILE` takes a character card, and the agent speaks as that character in the folder, or everywhere with `--global`. `/persona none` goes back to the plain agent.

## Desktop app

The engine runs in its own process and serves the window over a loopback port guarded by a random token, so long steps do not block the window. Sessions are listed per folder by day. The agent's steps open into terminal output, diffs, previews and screenshots. The side panel shows each turn's file changes, with undo, and the context window drawn to scale. Each answer ends with a summary line: time, requests, files changed and whether the last check passed. While the window is in the background, a session that finishes or waits for you raises a notification.

| Keys | |
|---|---|
| Ctrl+K | command palette |
| Ctrl+N / Ctrl+O | new session / open a folder |
| Ctrl+B / Ctrl+Alt+B | sidebar / side panel |
| Esc | stop the agent |
| Ctrl+, | settings |
| Ctrl+= / Ctrl+- / Ctrl+0 | zoom |

Six themes: Drafting and Night shift (light and dark, following the system by default), Daylight, Porcelain, Plain, and Kiln with a night version of its own. `packages/web/STYLE.md` describes the look. Settings > Usage counts tokens and requests on this computer by day, model and folder, with costs estimated from each model's prices; only numbers are stored, not conversation content.

The app and the terminal UI speak English, Simplified and Traditional Chinese, Japanese, Korean, Spanish, Brazilian Portuguese, French, German and Russian, following the system's language until you pick one in Settings.

## Remote control

Settings > Remote control pairs a phone with the computer by QR code. The phone opens the same interface, follows sessions, sends messages and answers approvals. Traffic between phone and computer is end-to-end encrypted (`packages/core/src/remote/e2e.ts`). The relay only forwards encrypted messages and serves the page the phone opens.

On the same Wi-Fi the phone connects to the computer directly after scanning the code, with nothing to set up. The first time, Windows asks whether Favilla may use private networks. That page is served over plain http, so it is meant for a network you trust, such as home or the office.

From anywhere else the phone goes through a relay. No relay is built in. You run your own on Cloudflare Workers, and the free plan is enough:

```bash
pnpm install
pnpm --filter @favilla/web build    # the page the relay serves to phones
cd packages/relay
npx wrangler login
npx wrangler deploy                 # prints https://favilla-relay.<your-subdomain>.workers.dev
```

Put that address in Settings > Remote control > Relay, turn remote control on and pair. For a domain of your own, see the comment in `packages/relay/wrangler.jsonc`.

## Platforms

| | Status |
|---|---|
| Windows | The main platform. The install command, the installer and the portable exe; or build them with `pnpm --filter @favilla/desktop dist`. Computer control is Windows only. |
| Linux | Type checks and tests pass, in CI and in a container. The terminal UI and the browser page have had little use there; no desktop package is built. |
| macOS | Type checks and tests run in CI. Not tried on a real Mac; no desktop package is built. |

Reports and fixes for Linux and macOS are welcome.

## Contributing

`AGENTS.md` describes the layout and the checks to run before a change is done: `pnpm typecheck` and `pnpm test`.

```
packages/core      engine: providers, tools, agent loop, context, sessions, server
packages/cli       the favilla and fav commands and the terminal UI
packages/web       the UI (React), themes in src/themes
packages/desktop   Electron shell and packaging
packages/relay     the remote-control relay, a Cloudflare Worker
```

## License

MIT, by Bene Latuit.
