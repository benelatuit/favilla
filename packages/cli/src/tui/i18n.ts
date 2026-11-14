/**
 * Interface text for the terminal. English is the key; Chinese follows the same key. Technical terms (model
 * names, effort levels, file paths, commands, keys) are never translated. Notices from the engine carry their
 * English template as `key`, so they are translated here too.
 */
import { extensionString } from '@favilla/core';
import { catastropheZh } from '@favilla/core/guard/i18n';
import { coreWords, FALLBACK, isLanguage, languageForLocale, settingText, sharedZh, type Language, type SettingsMessage, type SettingsNotice } from '@favilla/core/i18n';
import de from './locales/de';
import es from './locales/es';
import fr from './locales/fr';
import ja from './locales/ja';
import ko from './locales/ko';
import ptBR from './locales/pt-BR';
import ru from './locales/ru';
import zhTW from './locales/zh-TW';

type Lang = Language;

let current: Lang = 'en';

/** The setting from the config ('auto' or a language); auto follows the system's language, English when it has none. */
export function setLanguage(setting: string | undefined): Lang {
  if (setting !== 'auto' && isLanguage(setting)) current = setting;
  else {
    const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
    // C and POSIX name no language: the system's own locale says more.
    const sys = env && !/^(C|POSIX)\b/i.test(env) ? env : Intl.DateTimeFormat().resolvedOptions().locale;
    current = languageForLocale(sys) ?? 'en';
  }
  return current;
}

export const language = (): Lang => current;

/** The text for `key` in the current language, with {name} placeholders filled; an extension's words come with it. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const fallback = FALLBACK[current];
  let s = current === 'en' ? key : (word(current, key) ?? (fallback ? word(fallback, key) : undefined) ?? key);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

const printedSettings = new Set<string>();

export function printSettingNotice(notice: SettingsNotice): void {
  const text = settingText(notice, t);
  printedSettings.add(text);
  console.error(text);
}

export function printSettingError(problem: SettingsMessage): void {
  const text = settingText(problem, t);
  if (!printedSettings.has(text)) console.error(text);
}

/**
 * The terminal's Chinese, by its English text.
 *
 * What stays English in the Chinese is what Chinese developers say in English: Agent (a sub-agent is 子 Agent),
 * Prompt and System Prompt, Preset, Skills, MCP, API, CLI, commit, token, shell, diff, fork, the names of models and
 * providers, the effort levels (low, medium, high, xhigh, max), shadow tests, recall, flags, commands, paths and file
 * names. What reads naturally in Chinese stays Chinese: 会话, 设置, 上下文, 模型, 文件夹, 工具, 分支, 终端, 规则, 压缩.
 * An English word stands between spaces beside Chinese. No full-width semicolon and no bracketed aside: a sentence
 * ends, or the aside goes into the sentence.
 */
export const zh: Record<string, string> = {
  ...catastropheZh,
  ...sharedZh,
  'SillyTavern presets: /preset lists them, /preset import FILE, use NAME, inherit, none, show, copy, delete; --global for every folder': 'SillyTavern 预设：/preset 列出，/preset import 文件、use 名字、inherit、none、show、copy、delete，加 --global 表示全局',
  prompts: '条提示词',
  'left out (no character card here):': '跳过，这里没有角色卡：',
  'empty, with no character card:': '留空，没有角色卡：',
  'not understood, sent as written:': '不认识，原样发送：',
  'before the chat': '对话之前',
  'after the chat': '对话之后',
  'none imported': '还没导入',
  'who the agent is: /persona lists the personas, /persona import FILE (a character card), use NAME, inherit, none, show, delete; --global for every folder':
    'Agent 是谁：/persona 列出人设，/persona import 文件导入角色卡，还有 use 名字、inherit、none、show、delete，加 --global 表示全局',
  'no persona': '不用人设',
  'New sessions here are:': '这里的新会话用的人设：',
  'Say which file: /persona import FILE': '要说明文件：/persona import 文件',
  'not used here:': '这几样没有用上：',
  'Turn it on with /persona use NAME.': '用 /persona use 名字 启用。',
  'No persona by that name:': '没有这个名字的人设：',
  '/persona, then: import FILE, use NAME, inherit, none, show NAME, delete NAME; add --global for every folder.': '/persona 后面接：import 文件、use 名字、inherit、none、show 名字、delete 名字。加 --global 表示全局。',
  'no preset': '不用预设',
  'New sessions here use:': '这里的新会话用：',
  'every folder': '全局',
  'this folder': '当前工作区',
  'This folder': '当前工作区',
  'Every folder': '全局',
  'follows every-folder choice': '跟随全局',
  'Say which file: /preset import FILE': '要说明文件：/preset import 文件',
  Imported: '已导入',
  'Turn it on with /preset use NAME.': '用 /preset use 名字 启用。',
  'No preset by that name in': '没有这个名字的预设，位置：',
  Using: '已启用',
  'This folder follows the every-folder choice.': '当前工作区改为跟随全局。',
  depth: '深度',
  order: '顺序',
  prefill: '预填充',
  'Copied to': '已复制到',
  Deleted: '已删除',
  '/preset, then: import FILE, use NAME, inherit, none, show NAME, copy NAME, delete NAME; add --global for every folder.': '/preset 后面接：import 文件、use 名字、inherit、none、show 名字、copy 名字、delete 名字。加 --global 表示全局。',
  // The engine's notices.

  // Turns and the live part.
  'sub-agent': '子 Agent',
  'Interrupted.': '已中断。',
  'The turn failed.': '这一轮失败了。',
  'The turn reached its step limit; say "continue" to go on.': '这一轮已达到步数上限。发送“继续”可以接着执行。',
  'The model declined to go on with this request.': '模型拒绝继续这个请求。',
  'earlier conversation summarized; continuing from the summary': '之前的对话已压缩成摘要，从摘要继续',
  'The reply above was cut off; the model is asked again.': '上面的回复中途断了，正在重新请求。',
  'The agent did not read your last message; ↑ brings it back.': 'Agent 没读到你刚才那条消息。按 ↑ 取回。',
  'The agent did not read {n} messages; ↑ brings them back.': 'Agent 有 {n} 条消息没读到。按 ↑ 取回。',
  'compacting the context…': '正在压缩上下文…',
  'context compacted: {a} → {b} tokens': '上下文已压缩：{a} → {b} tokens',
  'trimmed {n} old tool outputs: {m} tokens in context (recall brings them back)': '已裁剪 {n} 条旧的工具输出，上下文现为 {m} tokens，可用 recall 取回',
  '1 file changed this turn · /diff shows it · /undo puts it back': '这一轮改了 1 个文件 · /diff 查看 · /undo 撤销',
  '{n} files changed this turn · /diff shows them · /undo puts them back': '这一轮改了 {n} 个文件 · /diff 查看 · /undo 撤销',
  'Checking the answer covers every request': '正在核对回答是否覆盖了每个要求',
  'Measuring the page at desktop and phone width': '正在按桌面和手机宽度检查页面',
  'esc to interrupt': 'esc 中断',
  // The minutes come from QUIET_MS, QUIET_DEEP_MS and STALL_MS in core/src/agent/session.ts.
  '{n} sub-agents in the background': '{n} 个子 Agent 在后台工作',
  'the agent goes on when they are done': '全部完成后主 Agent 继续',
  'esc stops them': 'esc 停止它们',
  'type to queue a message': '直接输入即可排队',
  queued: '排队中',
  '↑ takes it back': '↑ 取回修改',
  '… {n} lines above, printed in full when this part is done': '… 上面还有 {n} 行，这段写完后完整显示',
  'press ctrl+c again to quit': '再按一次 ctrl+c 退出',
  'esc again: go back to an earlier message': '再按一次 esc：回到之前的消息',
  'esc again: clear the input': '再按一次 esc：清空输入',
  'Queue a message for the agent…': '排队一条消息给 Agent…',
  'Ask, or describe a change. @ attaches files, / for commands, alt+v pastes a picture': '提问或描述要做的修改。@ 附加文件，/ 查看命令，alt+v 粘贴图片',
  'plan mode': '规划模式',
  branch: '分支',
  '/help for keys and commands · alt+v pastes a picture · esc esc goes back': '/help 查看按键和命令 · alt+v 粘贴图片 · esc esc 返回之前的消息',
  untitled: '未命名',

  // Branches, rewind, edits.
  'New branch from message {n} of “{t}”; /resume returns to the original.': '已从「{t}」的第 {n} 条消息分出新分支。/resume 可回到原会话。',
  'New branch after message {n}; /resume returns to the original.': '已在第 {n} 条消息之后分出新分支。/resume 可回到原会话。',
  'Continuing in a copy of “{t}”; /resume returns to the original.': '在「{t}」的副本里继续。/resume 可回到原会话。',
  'Put back {n} files: {f}': '已撤销 {n} 个文件的改动：{f}',
  'No earlier messages in this session.': '这个会话里还没有之前的消息。',
  'Go back to an earlier message': '回到之前的消息',
  '{n} files changed since': '之后改了 {n} 个文件',
  'Edit and send again, putting back the {n} files changed since': '修改后重发，并撤销之后改过的 {n} 个文件',
  'Edit and send again, leaving the files as they are': '修改后重发，文件保持现状',
  'Edit and send again': '修改后重发',
  'Edit and send in a new branch, putting back the {n} files changed since': '修改后在新分支里发送，并撤销之后改过的 {n} 个文件',
  'Edit and send in a new branch, leaving the files as they are': '修改后在新分支里发送，文件保持现状',
  'Edit and send in a new branch': '修改后在新分支里发送',
  'Message {n} sent again; the conversation after it is gone.': '第 {n} 条消息已重新发送，之后的对话已删除。',
  'Sent again, the conversation after it goes; a new branch keeps it.': '重发会丢掉这条之后的对话。新分支会保留原对话。',
  'Branch after this exchange: a new session continues from its answer': '在这轮回答之后开新分支：新会话从这里继续',
  'Message {n}': '第 {n} 条消息',
  'Editing message {n}: enter sends it in a new branch from there · esc cancels': '正在修改第 {n} 条消息：enter 从那里分出新分支发送 · esc 取消',
  'Editing message {n}: enter sends it again in its place · esc cancels': '正在修改第 {n} 条消息：enter 原地重发，之后的对话会丢掉 · esc 取消',
  'Edit cancelled.': '已取消修改。',
  'Nothing to copy yet.': '还没有可复制的内容。',

  // ! commands and the editor.
  'The output goes to the agent with your next message.': '输出会随你的下一条消息交给 Agent。',
  'Could not open the editor {e}: {n}': '无法打开编辑器 {e}：{n}',
  Image: '图片',
  'Images over 4.5 MB are left out: {n}': '超过 4.5 MB 的图片没有附上：{n}',
  'The copied files are not pictures.': '复制的文件不是图片。',
  'Could not read the clipboard: {n}': '无法读取剪贴板：{n}',
  'No picture on the clipboard. Copy a screenshot or an image first.': '剪贴板里没有图片。先截图或复制一张图片。',
  Pasted: '已粘贴',
  history: '历史',
  'no match': '没有匹配',
  'lines {a}-{b} of {n}': '第 {a}-{b} 行，共 {n} 行',
  'Reading the clipboard…': '正在读取剪贴板…',

  // Sub-agents.
  'No sub-agents in this session yet.': '这个会话还没有子 Agent。',
  done: '已完成',
  working: '工作中',
  'Sub-agents': '子 Agent',
  'writing its report': '正在写报告',
  'waiting for you': '等你回复',
  starting: '启动中',
  thinking: '思考中',
  background: '后台',

  // Settings and status.
  on: '开',
  off: '关',
  'follow the system': '跟随系统',
  'enter changes · esc closes · the rest is in {n}': 'enter 切换 · esc 关闭 · 其余设置在 {n}',
  Language: '界面语言',
  'Approvals for risky commands': '危险命令确认',
  ask: '询问',
  refuse: '拒绝',
  'run without asking': '直接运行',
  'Web search': '网页搜索',
  'Agent browser window': 'Agent 浏览器窗口',
  'on screen': '显示',
  hidden: '隐藏',
  'Language servers': '语言服务器',
  week: '周',
  '5 h': '5 小时',
  left: '剩余',
  'resets {n}': '{n} 重置',
  model: '模型',
  '{n} takes over once this turn stops.': '这一轮停下后换成 {n}。',
  effort: '思考强度',
  mode: '模式',
  plan: '规划',
  default: '默认',
  folder: '文件夹',
  session: '会话',
  'branch of': '分支自',
  account: '账号',
  limits: '额度',
  approvals: '确认',
  shell: '终端',
  usage: '用量',
  requests: '次请求',
  cached: '命中缓存',
  current: '当前',

  // /help.
  Keys: '按键',
  'enter sends · shift+enter, alt+enter or ctrl+j adds a line · \\ at the end of a line + enter too': 'enter 发送 · shift+enter、alt+enter 或 ctrl+j 换行 · 行尾打 \\ 再按 enter 也换行',
  'alt+v pastes a picture (ctrl+v outside Windows) · drop an image file in to attach it · @path attaches a file': 'alt+v 粘贴图片，非 Windows 系统用 ctrl+v · 拖入图片文件即可附加 · @路径 附加文件',
  '↑/↓ history · ctrl+r searches it · ctrl+g edits in $EDITOR · ctrl+t the whole transcript': '↑/↓ 浏览历史 · ctrl+r 搜索历史 · ctrl+g 用 $EDITOR 编辑 · ctrl+t 查看完整记录',
  '!command runs it now and gives the output to the agent · type while it works to queue a message (↑ takes it back)': '!命令 立即运行并把输出交给 Agent · Agent 工作时打字会排队，↑ 取回',
  'ctrl+c twice quits': '连按两次 ctrl+c 退出',
  'Your own commands: markdown files in ~/.favilla/commands or .favilla/commands; $ARGUMENTS takes what follows.': '自定义命令：放在 ~/.favilla/commands 或 .favilla/commands 里的 markdown 文件。$ARGUMENTS 换成命令后面的内容。',
  'your command': '自定义命令',

  // Rules, copy, export.
  'enter opens it in your editor · the agent reads it again when you close it': 'enter 用编辑器打开 · 关掉后 Agent 会重新读取',
  'Yours, for every project': '你的规则，所有项目都用',
  'This project': '这个项目',
  'new file': '新文件',
  'The rules did not change.': '规则没有改动。',
  'Rules saved; the agent follows them from its next step.': '规则已保存，Agent 从下一步开始遵守。',
  'No answer to copy yet.': '还没有可复制的回答。',
  'Copied the last answer ({n} characters).': '已复制最后一条回答，共 {n} 字。',
  'Could not reach the clipboard.': '无法访问剪贴板。',
  'Saved the conversation to {n}': '对话已保存到 {n}',
  "edit the rules the agent follows: yours and this project's": '编辑 Agent 遵守的规则：你的和这个项目的',
  'copy the last answer': '复制最后一条回答',
  'save the conversation as markdown; /export FILE picks where': '把对话存成 markdown，/export 加文件名指定位置',

  'esc stops the agent · esc esc goes back to an earlier message · shift+tab switches default and plan': 'esc 中断 Agent · esc esc 回到之前的消息 · shift+tab 在默认和规划之间切换',

  // Commands.
  'No configured providers. Set an API key in /settings or in its environment variable.': '还没有可用的供应商。在 /settings 或环境变量里设置 API key。',
  'Switch model': '切换模型',
  'This model has no reasoning effort setting.': '这个模型没有思考强度设置。',
  'This session has not changed any files (in this run).': '这个会话在本次运行里还没有改过文件。',
  'Changes in this session': '本会话的改动',
  Transcript: '完整记录',
  'compacting…': '正在压缩…',
  'No file changes to undo.': '没有可撤销的文件改动。',
  'No other sessions in this folder.': '这个文件夹里没有别的会话。',
  'Resume a session': '继续一个会话',
  Usage: '用量',
  'Unknown command {n}. /help lists them; // at the start sends a message that begins with /.': '未知命令 {n}。/help 列出全部命令。开头输入 // 可以发送以 / 开头的消息。',
  'switch model': '切换模型',
  'reasoning effort': '思考强度',
  'plan mode on or off (shift+tab)': '开启或关闭规划模式，shift+tab',
  'edit an earlier message and send it again, or branch from it (esc esc)': '修改之前的消息重发，或从那里开新分支，esc esc',
  'continue in a copy of this session, leaving this one as it is': '复制这个会话接着做，原会话保持不动',
  'every change this session made, file by file': '本会话做过的全部改动，逐个文件',
  'put back the files the last turn changed': '撤销上一轮改过的文件',
  'sub-agents of this session and what they did': '本会话的子 Agent 和它们做了什么',
  'the whole conversation with full tool output (ctrl+t)': '完整对话和全部工具输出，ctrl+t',
  'what fills the context window': '查看上下文窗口的内容',
  'summarize the conversation to free context': '把对话压缩成摘要，腾出上下文',
  'review the uncommitted changes for bugs; /review FOCUS narrows it': '审查未 commit 的改动找 bug，/review 加重点可以缩小范围',
  'write AGENTS.md: how to build, test and work in this project': '写 AGENTS.md：这个项目怎么构建、测试和开发',
  'start a new session': '开始新会话',
  'continue a saved session': '继续一个保存的会话',
  'model, limits, folder, settings': '模型、额度、文件夹、设置',
  'language, approvals, web search, browser': '界面语言、命令确认、网页搜索、浏览器',
  'tokens, cache and cost': 'tokens、缓存和费用',
  'keys and commands': '按键和命令',
  quit: '退出',

  // Times and counts.
  'just now': '刚刚',
  '{n} min ago': '{n} 分钟前',
  '{n} h ago': '{n} 小时前',
  '{n} d ago': '{n} 天前',
  '[1 image]': '[1 张图片]',
  '[{n} images]': '[{n} 张图片]',

  // Tool results.
  added: '新增',
  deleted: '删除',
  moved: '移动',
  changed: '修改',
  '… {n} more changed lines · /diff shows all': '… 还有 {n} 行改动 · /diff 查看全部',
  'in the background: {n}': '后台运行：{n}',
  'timed out': '超时',
  stopped: '已停止',
  'exit {n}': '退出码 {n}',
  '… {n} lines above': '… 上面还有 {n} 行',
  'region {n}': '区域 {n}',
  '{n} matches in {m} files': '{m} 个文件里 {n} 处匹配',
  '{n} matches': '{n} 处匹配',
  'no matches': '没有匹配',
  '{n} items': '{n} 项',
  'running in the background; its report comes back as a message': '在后台运行，做完会把报告发回来',
  'running in the background; its result comes back as a message': '在后台运行，做完会把结果发回来',
  '{n} chars': '{n} 字',
  '{n} messages': '{n} 封',
  'You turned this email down.': '你拒绝发送这封邮件。',
  approved: '已批准',
  'not approved': '未批准',
  '{n} of {m} failed': '{m} 项里 {n} 项失败',
  'none found': '未找到检查命令',
  'on the code before your changes': '在改动前的代码上',
  'The new tests fail on the old code: they catch the fix.': '新测试在旧代码上失败：它们确实验证了这次修复。',
  'The tests pass on the old code too: they do not prove the fix.': '测试在旧代码上也通过：证明不了这次修复。',
  'The old code does not build with the new tests.': '旧代码无法通过新测试的编译。',
  'probe: {n} of {m} reverted lines caught by the tests': '探测：回退的 {m} 行中有 {n} 行被测试发现',
  '{n} attempts': '{n} 次尝试',
  '1 file': '1 个文件',
  '{n} of {m} runs failed': '{m} 次运行里 {n} 次失败',
  '{n} runs': '{n} 次运行',
  '1 run': '1 次运行',

  // Context.
  'system prompt': 'System Prompt',
  'tool definitions': '工具定义',
  'summary of earlier work': '之前工作的摘要',
  conversation: '对话',
  reasoning: '推理',
  'tool output': '工具输出',
  'tool output cut to stubs': '裁成占位的工具输出',
  'compacts at {n}': '到 {n} 时压缩',
  'provider window {n}': '供应商窗口 {n}',
  '{n} tool outputs in full, {m} cut to stubs (recall brings them back) · {c} compactions': '{n} 条工具输出完整保留，{m} 条裁成占位，recall 能取回 · 压缩过 {c} 次',

  // Transcript.
  '… {n} earlier messages · ctrl+t shows the whole conversation': '… 前面还有 {n} 条消息 · ctrl+t 看完整对话',
  'earlier conversation summarized': '之前的对话已压缩成摘要',
  'Summary of earlier work': '之前工作的摘要',
  'Favilla to the model': 'Favilla 发给模型的说明',
  '… {n} more lines': '… 还有 {n} 行',

  // Prompts.
  Confirm: '确认',
  'Run it once': '运行这一次',
  'Allow this kind for the session': '本会话都允许这类命令',
  'Don’t run it': '不运行',
  'enter chooses · y / a / n': 'enter 选择 · y / a / n',
  'enter chooses · y / n': 'enter 选择 · y / n',
  'Something else (type it)': '其他，手动输入',
  'Skip: let the agent decide': '跳过：让 Agent 决定',
  Question: '问题',
  'enter sends · esc goes back': 'enter 发送 · esc 返回',
  'space ticks · enter sends what is ticked': '空格勾选 · enter 发送勾选的项',
  'Plan ready for review': '计划已就绪，请审阅',
  'What should change?': '要改什么？',
  'Approve and start building': '批准并开始执行',
  'Keep planning (give feedback)': '继续规划并提意见',
  'enter chooses · esc closes': 'enter 选择 · esc 关闭',
  filter: '筛选',
  'type to filter': '输入以筛选',
  'nothing matches': '没有匹配项',
  search: '搜索',
  closes: '关闭',
  '(end)': '已到末尾',
};

/** The terminal's words by language; Chinese is the table above, the others are filled from it by the model. */
const tables: Partial<Record<Lang, Record<string, string>>> = { 'zh-CN': zh, 'zh-TW': zhTW, ja, ko, es, 'pt-BR': ptBR, fr, de, ru };

function word(lang: Lang, key: string): string | undefined {
  return tables[lang]?.[key] ?? coreWords[lang]?.[key] ?? extensionString(lang, key);
}
