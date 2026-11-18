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
 * What stays English in the Chinese is what Chinese developers say in English: Agent, Sub-agent, Prompt and System
 * Prompt, Preset, Skills, MCP, API, CLI, commit, token, shell, diff, fork, Benchmark, the names of models and
 * providers, the effort levels (low, medium, high, xhigh, max), shadow tests, recall, flags, commands, paths and file
 * names. What reads naturally in Chinese stays Chinese: 会话, 设置, 上下文, 模型, 文件夹, 工具, 分支, 终端, 规则, 压缩, 预设, 提示词.
 * An English word stands between spaces beside Chinese. No full-width semicolon and no bracketed aside: a sentence
 * ends, or the aside goes into the sentence.
 */
export const zh: Record<string, string> = {
  ...catastropheZh,
  ...sharedZh,
  Working: '运行中',
  'The background sub-agent "{n}" is done.': '后台 Sub-agent「{n}」已完成。',
  'SillyTavern presets: /preset lists them, /preset import FILE, use NAME, inherit, none, show, copy, delete; --global for every folder': 'SillyTavern 预设：/preset 列出，/preset import FILE、use NAME、inherit、none、show、copy、delete，--global 作用于所有文件夹',
  prompts: '条提示词',
  'left out (no character card here):': '未导入角色卡，已跳过：',
  'empty, with no character card:': '未导入角色卡，以下宏留空：',
  'not understood, sent as written:': '未识别的宏，原样发送：',
  'before the chat': '对话之前',
  'after the chat': '对话之后',
  'none imported': '尚未导入',
  'who the agent is: /persona lists the personas, /persona import FILE (a character card), use NAME, inherit, none, show, delete; --global for every folder':
    '设置 Agent 人设：/persona 列出，/persona import FILE 导入角色卡，支持 use NAME、inherit、none、show、delete，--global 作用于所有文件夹',
  'no persona': '不使用人设',
  'New sessions here are:': '当前文件夹新会话的人设：',
  'Say which file: /persona import FILE': '请指定文件：/persona import FILE',
  'not used here:': '未使用的字段：',
  'Turn it on with /persona use NAME.': '运行 /persona use NAME 启用。',
  'No persona by that name:': '未找到该人设：',
  '/persona, then: import FILE, use NAME, inherit, none, show NAME, delete NAME; add --global for every folder.': '用法：/persona import FILE、use NAME、inherit、none、show NAME、delete NAME，加 --global 作用于所有文件夹。',
  'no preset': '不使用预设',
  'New sessions here use:': '当前文件夹新会话的预设：',
  'every folder': '所有文件夹',
  'this folder': '当前文件夹',
  'This folder': '当前文件夹',
  'Every folder': '所有文件夹',
  'follows every-folder choice': '跟随默认设置',
  'Say which file: /preset import FILE': '请指定文件：/preset import FILE',
  Imported: '已导入',
  'Turn it on with /preset use NAME.': '运行 /preset use NAME 启用。',
  'No preset by that name in': '未找到该预设，位置：',
  Using: '已启用',
  'This folder follows the every-folder choice.': '当前文件夹已改为跟随默认设置。',
  depth: '深度',
  order: '顺序',
  prefill: '预填充',
  'Copied to': '已复制到',
  Deleted: '已删除',
  '/preset, then: import FILE, use NAME, inherit, none, show NAME, copy NAME, delete NAME; add --global for every folder.': '用法：/preset import FILE、use NAME、inherit、none、show NAME、copy NAME、delete NAME，加 --global 作用于所有文件夹。',
  // The engine's notices.

  // Turns and the live part.
  'sub-agent': 'Sub-agent',
  'Interrupted.': '已中断。',
  'The turn failed.': '本轮执行失败。',
  'The turn reached its step limit; say "continue" to go on.': '已达到本轮步数上限，发送“继续”可接着执行。',
  'The model declined to go on with this request.': '模型拒绝继续处理该请求。',
  'earlier conversation summarized; continuing from the summary': '早期对话已生成摘要，后续从摘要继续',
  'The reply above was cut off; the model is asked again.': '上一条回复意外中断，正在重新请求。',
  'The agent did not read your last message; ↑ brings it back.': 'Agent 未读到刚才的消息，按 ↑ 取回。',
  'The agent did not read {n} messages; ↑ brings them back.': 'Agent 有 {n} 条消息未读到，按 ↑ 取回。',
  'compacting the context…': '正在压缩上下文…',
  'context compacted: {a} → {b} tokens': '上下文已压缩：{a} → {b} tokens',
  'trimmed {n} old tool outputs: {m} tokens in context (recall brings them back)': '已裁剪 {n} 条旧工具输出，当前上下文 {m} tokens，可通过 recall 调回',
  '1 file changed this turn · /diff shows it · /undo puts it back': '本轮修改了 1 个文件 · /diff 查看 · /undo 撤销',
  '{n} files changed this turn · /diff shows them · /undo puts them back': '本轮修改了 {n} 个文件 · /diff 查看 · /undo 撤销',
  'Checking the answer covers every request': '正在核对回答是否覆盖全部需求',
  'Measuring the page at desktop and phone width': '正在按桌面与手机宽度检查页面',
  'esc to interrupt': 'esc 中断',
  // The minutes come from QUIET_MS, QUIET_DEEP_MS and STALL_MS in core/src/agent/session.ts.
  '{n} sub-agents in the background': '{n} 个 Sub-agent 在后台运行',
  'the agent goes on when they are done': '全部完成后 Agent 继续',
  'esc stops them': 'esc 全部停止',
  'type to queue a message': '直接输入即可排队',
  queued: '排队中',
  '↑ takes it back': '↑ 取回修改',
  '… {n} lines above, printed in full when this part is done': '… 上方还有 {n} 行，本段完成后完整显示',
  'press ctrl+c again to quit': '再按一次 ctrl+c 退出',
  'esc again: go back to an earlier message': '再按一次 esc：回到先前的消息',
  'esc again: clear the input': '再按一次 esc：清空输入',
  'Queue a message for the agent…': '输入排队发给 Agent 的消息…',
  'Ask, or describe a change. @ attaches files, / for commands, alt+v pastes a picture': '提问或描述要做的修改。@ 附加文件，/ 查看命令，alt+v 粘贴图片',
  'plan mode': '规划模式',
  branch: '分支',
  '/help for keys and commands · esc esc goes back': '/help 查看快捷键与命令 · esc esc 回到先前的消息',
  untitled: '未命名',

  // Branches, rewind, edits.
  'New branch from message {n} of “{t}”; /resume returns to the original.': '已从「{t}」第 {n} 条消息创建新分支，/resume 可返回原会话。',
  'New branch after message {n}; /resume returns to the original.': '已在第 {n} 条消息后创建新分支，/resume 可返回原会话。',
  'Continuing in a copy of “{t}”; /resume returns to the original.': '正在「{t}」的副本中继续，/resume 可返回原会话。',
  'Put back {n} files: {f}': '已恢复 {n} 个文件：{f}',
  'No earlier messages in this session.': '当前会话没有更早的消息。',
  'Go back to an earlier message': '回到先前的消息',
  '{n} files changed since': '此后修改了 {n} 个文件',
  'Edit and send again, putting back the {n} files changed since': '修改后重发，并恢复此后修改的 {n} 个文件',
  'Edit and send again, leaving the files as they are': '修改后重发，保留现有文件改动',
  'Edit and send again': '修改后重发',
  'Edit and send in a new branch, putting back the {n} files changed since': '修改后在新分支发送，并恢复此后修改的 {n} 个文件',
  'Edit and send in a new branch, leaving the files as they are': '修改后在新分支发送，保留现有文件改动',
  'Edit and send in a new branch': '修改后在新分支发送',
  'Message {n} sent again; the conversation after it is gone.': '第 {n} 条消息已重新发送，后续对话已删除。',
  'Sent again, the conversation after it goes; a new branch keeps it.': '原地重发会删除后续对话，在新分支发送可保留原对话。',
  'Branch after this exchange: a new session continues from its answer': '在本轮回答后创建分支：新会话从此处继续',
  'Message {n}': '第 {n} 条消息',
  'Editing message {n}: enter sends it in a new branch from there · esc cancels': '正在修改第 {n} 条消息：enter 在新分支发送 · esc 取消',
  'Editing message {n}: enter sends it again in its place · esc cancels': '正在修改第 {n} 条消息：enter 原地重发并删除后续对话 · esc 取消',
  'Edit cancelled.': '已取消修改。',
  'Nothing to copy yet.': '暂无可复制的内容。',

  // ! commands and the editor.
  'The output goes to the agent with your next message.': '命令输出会随下一条消息发给 Agent。',
  'Could not open the editor {e}: {n}': '无法打开编辑器 {e}：{n}',
  Image: '图片',
  'Images over 4.5 MB are left out: {n}': '超过 4.5 MB 的图片未附加：{n}',
  'The copied files are not pictures.': '复制的文件不是图片。',
  'Could not read the clipboard: {n}': '无法读取剪贴板：{n}',
  'No picture on the clipboard. Copy a screenshot or an image first.': '剪贴板中没有图片，请先截图或复制图片。',
  Pasted: '已粘贴',
  history: '历史',
  'no match': '无匹配项',
  'lines {a}-{b} of {n}': '第 {a}-{b} 行，共 {n} 行',
  'Reading the clipboard…': '正在读取剪贴板…',

  // Sub-agents.
  'No sub-agents in this session yet.': '当前会话暂无 Sub-agent。',
  done: '已完成',
  working: '运行中',
  'Sub-agents': 'Sub-agent',
  'writing its report': '正在整理报告',
  'waiting for you': '等待确认',
  starting: '启动中',
  thinking: '思考中',
  background: '后台',

  // Settings and status.
  on: '开',
  off: '关',
  'follow the system': '跟随系统',
  'enter changes · esc closes · the rest is in {n}': 'enter 切换 · esc 关闭 · 其余设置在 {n}',
  Language: '语言',
  'Approvals for risky commands': '危险命令确认',
  ask: '询问',
  refuse: '拒绝',
  'run without asking': '直接运行',
  'Web search': '联网搜索',
  'Agent browser window': 'Agent 浏览器窗口',
  'on screen': '显示',
  hidden: '隐藏',
  'Language servers': '语言服务器',
  week: '周',
  '5 h': '5 小时',
  left: '剩余',
  'resets {n}': '{n} 重置',
  model: '模型',
  '{n} takes over once this turn stops.': '本轮结束后切换为 {n}。',
  effort: '思考强度',
  mode: '模式',
  plan: '规划',
  default: '默认',
  folder: '文件夹',
  session: '会话',
  'branch of': '分支自',
  account: '账号',
  limits: '额度',
  approvals: '命令确认',
  shell: 'shell',
  usage: '用量',
  requests: '次请求',
  cached: '命中缓存',
  current: '当前',
  'security key ✓': '安全密钥 ✓',
  'in {n}': '输入 {n}',
  'out {n}': '输出 {n}',
  'not run': '未运行',
  explored: '已探索',
  'Plan mode is on, so files cannot be changed yet.': '规划模式已开启，暂不可修改文件。',
  'Plan mode is on, so only commands that look, build or run tests can run.': '规划模式已开启，仅可运行查看、构建或测试命令。',

  // /help.
  Keys: '快捷键',
  'send, or queue the message while the agent works': '发送，Agent 运行时加入队列',
  'new line, as do alt+enter, ctrl+j and \\ before enter': '换行，alt+enter、ctrl+j 或行尾 \\ 加 enter 也可',
  'stop the agent': '中断 Agent',
  'go back to an earlier message': '回到先前的消息',
  'switch between default and plan': '切换默认与规划模式',
  'paste a picture, ctrl+v outside Windows': '粘贴图片，非 Windows 用 ctrl+v',
  'attach a file, or drop an image file in': '附加文件，也可拖入图片文件',
  'history, and a queued message back': '浏览历史，取回排队的消息',
  'search the history': '搜索历史',
  'edit the message in $EDITOR': '用 $EDITOR 编辑消息',
  'the whole transcript': '查看完整记录',
  'run it now and give the output to the agent': '立即运行，并把输出发给 Agent',
  'Your own commands: markdown files in ~/.favilla/commands or .favilla/commands; $ARGUMENTS takes what follows.': '自定义命令：放在 ~/.favilla/commands 或 .favilla/commands 下的 Markdown 文件，$ARGUMENTS 会替换为命令后的参数。',
  'your command': '自定义命令',

  // Rules, copy, export.
  'enter opens it in your editor · the agent reads it again when you close it': 'enter 用编辑器打开 · 关闭后 Agent 重新读取',
  'Yours, for every project': '个人规则 · 所有项目生效',
  'This project': '当前项目',
  'new file': '新建文件',
  'The rules did not change.': '规则未改动。',
  'Rules saved; the agent follows them from its next step.': '规则已保存，Agent 从下一步起生效。',
  'No answer to copy yet.': '暂无可复制的回答。',
  'Copied the last answer ({n} characters).': '已复制最后一条回答，共 {n} 个字符。',
  'Could not reach the clipboard.': '无法访问剪贴板。',
  'Saved the conversation to {n}': '对话已保存到 {n}',
  "edit the rules the agent follows: yours and this project's": '编辑个人规则与当前项目规则',
  'copy the last answer': '复制最后一条回答',
  'save the conversation as markdown; /export FILE picks where': '导出对话为 Markdown，/export FILE 指定路径',


  // Commands.
  'No configured providers. Set an API key in /settings or in its environment variable.': '尚未配置供应商。请在 /settings 或环境变量中设置 API 密钥。',
  'Switch model': '切换模型',
  'This model has no reasoning effort setting.': '当前模型不支持设置思考强度。',
  'This session has not changed any files (in this run).': '当前会话在本次运行中尚未修改文件。',
  'Changes in this session': '本会话改动',
  Transcript: '完整记录',
  'compacting…': '正在压缩…',
  'No file changes to undo.': '没有可撤销的文件改动。',
  'No other sessions in this folder.': '当前文件夹暂无其他会话。',
  'Resume a session': '恢复会话',
  Usage: '用量',
  'Unknown command {n}. /help lists them; // at the start sends a message that begins with /.': '未知命令 {n}。输入 /help 查看命令列表，开头输入 // 可发送以 / 开头的消息。',
  'switch model': '切换模型',
  'reasoning effort': '思考强度',
  'plan mode on or off (shift+tab)': '切换规划模式 · shift+tab',
  'edit an earlier message and send it again, or branch from it (esc esc)': '编辑先前的消息并重发或创建分支 · esc esc',
  'continue in a copy of this session, leaving this one as it is': '在会话副本中继续，保留当前会话',
  'every change this session made, file by file': '按文件查看本会话的全部 diff',
  'put back the files the last turn changed': '撤销上一轮的文件改动',
  'sub-agents of this session and what they did': '查看本会话的 Sub-agent 及执行记录',
  'the whole conversation with full tool output (ctrl+t)': '查看完整对话与全部工具输出 · ctrl+t',
  'what fills the context window': '查看上下文窗口占用',
  'summarize the conversation to free context': '压缩对话摘要以释放上下文',
  'review the uncommitted changes for bugs; /review FOCUS narrows it': '审查未 commit 的改动，/review FOCUS 指定重点',
  'write AGENTS.md: how to build, test and work in this project': '生成 AGENTS.md：整理构建、测试与开发说明',
  'start a new session': '开始新会话',
  'continue a saved session': '恢复已保存的会话',
  'model, limits, folder, settings': '模型、额度、文件夹、设置',
  'language, approvals, web search, browser': '语言、命令确认、联网搜索、浏览器',
  'tokens, cache and cost': 'token、缓存与费用',
  'keys and commands': '快捷键与命令',
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
  '… {n} more changed lines · /diff shows all': '… 另有 {n} 行改动 · /diff 查看全部',
  'in the background: {n}': '后台运行：{n}',
  'timed out': '超时',
  stopped: '已停止',
  'exit {n}': '退出码 {n}',
  '… {n} lines above': '… 上方还有 {n} 行',
  'region {n}': '区域 {n}',
  '{n} matches in {m} files': '{m} 个文件共 {n} 处匹配',
  '{n} matches': '{n} 处匹配',
  'no matches': '无匹配项',
  '{n} items': '{n} 项',
  'running in the background; its report comes back as a message': '正在后台运行，完成后会发回报告',
  'running in the background; its result comes back as a message': '正在后台运行，完成后会发回结果',
  '{n} chars': '{n} 字符',
  '{n} messages': '{n} 封',
  'You turned this email down.': '已取消发送该邮件。',
  approved: '已批准',
  'not approved': '未批准',
  '{n} of {m} failed': '{m} 项中 {n} 项未通过',
  'none found': '未找到检查命令',
  'on the code before your changes': '在改动前的代码上',
  'The new tests fail on the old code: they catch the fix.': '新增测试在改动前的代码上未通过，能够验证本次修复。',
  'The tests pass on the old code too: they do not prove the fix.': '测试在改动前的代码上同样通过，未能验证本次修复。',
  'The old code does not build with the new tests.': '新增测试在改动前的代码上无法编译。',
  'probe: {n} of {m} reverted lines caught by the tests': '回退检查：回退的 {m} 行中有 {n} 行被测试检出',
  '{n} attempts': '{n} 次尝试',
  '1 file': '1 个文件',
  '{n} of {m} runs failed': '{m} 次运行中 {n} 次失败',
  '{n} runs': '{n} 次运行',
  '1 run': '1 次运行',

  // Context.
  'system prompt': 'System Prompt',
  'tool definitions': '工具定义',
  'summary of earlier work': '先前工作摘要',
  conversation: '对话',
  reasoning: '推理',
  'tool output': '工具输出',
  'tool output cut to stubs': '已裁剪的工具输出',
  'compacts at {n}': '达到 {n} 时压缩',
  'provider window {n}': '供应商窗口 {n}',
  '{n} tool outputs in full, {m} cut to stubs (recall brings them back) · {c} compactions': '完整保留 {n} 条工具输出，已裁剪 {m} 条，可通过 recall 调回 · 已压缩 {c} 次',

  // Transcript.
  '… {n} earlier messages · ctrl+t shows the whole conversation': '… 前方还有 {n} 条消息 · ctrl+t 查看完整对话',
  'earlier conversation summarized': '早期对话已生成摘要',
  'Summary of earlier work': '先前工作摘要',
  'Favilla to the model': 'Favilla 发给模型的提示',
  '… {n} more lines': '… 另有 {n} 行',

  // Prompts.
  Confirm: '确认',
  'Run it once': '运行一次',
  'Allow this kind for the session': '本会话始终允许此类命令',
  'Don’t run it': '不运行',
  'enter chooses · y / a / n': 'enter 选择 · y / a / n',
  'enter chooses · y / n': 'enter 选择 · y / n',
  'Something else (type it)': '其他 · 手动输入',
  'Skip: let the agent decide': '跳过，由 Agent 决定',
  Question: '问题',
  'enter sends · esc goes back': 'enter 发送 · esc 返回',
  'space ticks · enter sends what is ticked': 'space 勾选 · enter 提交所选',
  'Plan ready for review': '规划待审阅',
  'What should change?': '需要如何调整？',
  'Approve and start building': '批准并开始执行',
  'Keep planning (give feedback)': '继续规划并补充意见',
  'enter chooses · esc closes': 'enter 选择 · esc 关闭',
  filter: '筛选',
  'type to filter': '输入关键词筛选',
  'nothing matches': '无匹配项',
  search: '搜索',
  closes: '关闭',
  '(end)': '已到末尾',
  'Favilla {v} is available. Update with: npm install -g favilla@latest': '新版本 Favilla {v} 已发布。更新命令：npm install -g favilla@latest',
  'Favilla {v} is available. Update from the desktop app.': '新版本 Favilla {v} 已发布，请在桌面版中更新。',
  'This provider has no API key yet. Set it in the config file or its environment variable.': '当前供应商尚未配置 API 密钥，请在配置文件或对应的环境变量中设置。',
  'The provider turned down the API key. Check it in the config file.': '供应商拒绝了该 API 密钥，请在配置文件中检查。',
  'The provider does not have this model.': '供应商没有这个模型。',
  'Could not reach the provider. Check its address and the HTTPS proxy.': '无法连接供应商。请检查服务地址和 HTTPS 代理设置。',
  'This account has used up its quota with the provider.': '该账号在供应商处的额度已用完。',
  '/retry tries again from where it stopped. /model picks another model.': '/retry 从中断处重试，/model 切换模型。',
  'Nothing to try again: the last turn did not fail.': '上一轮没有失败，无需重试。',
  'try a failed turn again from where it stopped': '从中断处重试失败的一轮',
  '… 1 line above': '… 上方还有 1 行',
};

/** The terminal's words by language; Chinese is the table above, the others are filled from it by the model. */
const tables: Partial<Record<Lang, Record<string, string>>> = { 'zh-CN': zh, 'zh-TW': zhTW, ja, ko, es, 'pt-BR': ptBR, fr, de, ru };

function word(lang: Lang, key: string): string | undefined {
  return tables[lang]?.[key] ?? coreWords[lang]?.[key] ?? extensionString(lang, key);
}
