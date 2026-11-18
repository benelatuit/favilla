/** The backstop's card and refusal text, kept together for the front ends. */
export const catastropheText = {
  folder: 'This would erase the folder {target}.',
  git: 'This would destroy repository history at {target}.',
  disk: 'This would overwrite or repartition the disk {target}.',
  database: 'This would destroy the database {target}.',
  schema: 'This would destroy the schema {target}.',
  store: 'This would flush the key-value store {target}.',
  variable: 'The path {target} could erase a filesystem root if its variable is empty.',
};

export const catastropheZh: Record<string, string> = {
  'This would erase the folder {target}.': '会清空文件夹 {target}。',
  'This would destroy repository history at {target}.': '会破坏 {target} 的仓库历史。',
  'This would overwrite or repartition the disk {target}.': '会覆盖磁盘 {target} 或重新分区。',
  'This would destroy the database {target}.': '会删除数据库 {target}。',
  'This would destroy the schema {target}.': '会删除 schema {target}。',
  'This would flush the key-value store {target}.': '会清空键值存储 {target}。',
  'The path {target} could erase a filesystem root if its variable is empty.': '变量为空时，路径 {target} 可能清空文件系统根目录。',
};

/**
 * Why the guard asks before a command (guard.ts), in Simplified Chinese; the other languages are in ../locales. Both
 * front ends read them through coreWords and turn a reason into words with guardReason, so a sentence is translated
 * once for the window and the terminal alike.
 */
export const guardZh: Record<string, string> = {
  'Partitions or formats a disk.': '会对磁盘分区或格式化。',
  'Formats a drive.': '会格式化驱动器。',
  'Shuts down or restarts the machine.': '会关机或重启电脑。',
  'Changes the boot configuration.': '会修改系统启动配置。',
  'dd writes directly to a device.': 'dd 会直接写入设备。',
  'Deletes a GitHub repository or release.': '会删除 GitHub 仓库或 Release。',
  'Deletes Docker data (volumes or images).': '会删除 Docker 数据卷或镜像。',
  'Deletes every row of a table.': '会清空数据表的所有行。',
  'Deletes machine-wide registry keys.': '会删除系统范围的注册表项。',
  'Deletes Windows shadow copies (restore points).': '会删除 Windows 卷影副本与系统还原点。',
  'Deletes Windows shadow copies.': '会删除 Windows 卷影副本。',
  'Dropping stashes deletes saved work.': '丢弃 stash 会删除暂存的改动。',
  'Drops or truncates database objects.': '会删除或清空数据库对象。',
  'Expiring the reflog removes the safety net for lost commits.': '清理 reflog 后，丢失的 commit 就找不回了。',
  'Force-deleting a branch can lose unmerged commits.': '强制删除分支可能丢失未合并的 commit。',
  'git checkout --force discards uncommitted changes.': 'git checkout --force 会丢弃未 commit 的改动。',
  'git checkout on paths discards uncommitted changes to them.': '对指定路径执行 git checkout 会丢弃未 commit 的改动。',
  'git clean -f permanently deletes untracked files.': 'git clean -f 会永久删除未跟踪的文件。',
  'git reset --hard discards uncommitted changes.': 'git reset --hard 会丢弃未 commit 的改动。',
  'git restore discards uncommitted changes to those paths.': 'git restore 会丢弃指定路径未 commit 的改动。',
  'Kills every process you own.': '会结束当前用户的所有进程。',
  'Kills processes by name, which can hit unrelated programs (editors, other agents, servers).': '按名称结束进程可能误伤编辑器、其他 Agent 或服务等无关程序。',
  'Pruning removes unreachable commits for good.': '清理会永久删除无引用的 commit。',
  'Publishes a crate.': '会发布 Rust crate。',
  'Publishes a package to a public registry.': '会把软件包发布到公共仓库。',
  'Rewrites the whole repository history.': '会改写整个仓库的提交历史。',
  'This is a fork bomb.': '疑似 fork 炸弹。',
  'This push rewrites or deletes history on the remote.': '这次推送会改写或删除远端历史。',
  'Uploads a package to PyPI.': '会把软件包上传到 PyPI。',
  'Wipes free disk space.': '会擦除磁盘空闲空间。',
  'Writes directly to a disk device.': '会直接写入磁盘设备。',
  'it targets a filesystem root': '目标是文件系统根目录',
  'it targets your home folder': '目标是用户主目录',
  'it deletes a git repository and its history': '会删除 Git 仓库及其全部历史',
  'Deletes {a}: {b}.': '删除 {a}：{b}。',
  'Recursively deletes {a}, outside the workspace.': '递归删除工作区外的 {a}。',
  'Changes permissions recursively on {a}: {b}.': '递归修改 {a} 的权限：{b}。',
  'find … -delete under {a}, outside the workspace.': 'find … -delete 会删除工作区外 {a} 下的文件。',
  'find … -delete under {a}: {b}.': 'find … -delete 会删除 {a} 下的文件：{b}。',
  'Matches your rule /{a}/.': '命中自定义规则 /{a}/。',
  'it targets the system folder {a}': '目标是系统目录 {a}',
  'it targets {a}, which holds keys and app data': '目标是存放密钥与应用数据的 {a}',
  '"{a}" depends on a variable that may be empty': '“{a}”依赖的变量可能为空',
};

/**
 * Why the guard asks, in the front end's language. Whole sentences are translated by their text; the ones built around
 * a path or a rule by their pattern, the path or rule kept as the guard gave it and the clause after the colon
 * translated the same way. The backstop's reasons go through translateCatastropheReason. A sentence not known here
 * stays in English.
 */
const PATTERNS: [RegExp, string][] = [
  [/^Deletes (.+): (.+)\.$/, 'Deletes {a}: {b}.'],
  [/^Recursively deletes (.+), outside the workspace\.$/, 'Recursively deletes {a}, outside the workspace.'],
  [/^Changes permissions recursively on (.+): (.+)\.$/, 'Changes permissions recursively on {a}: {b}.'],
  [/^find … -delete under (.+), outside the workspace\.$/, 'find … -delete under {a}, outside the workspace.'],
  [/^find … -delete under (.+): (.+)\.$/, 'find … -delete under {a}: {b}.'],
  [/^Matches your rule \/(.+)\/\.$/, 'Matches your rule /{a}/.'],
  [/^it targets the system folder (.+)$/, 'it targets the system folder {a}'],
  [/^it targets (.+), which holds keys and app data$/, 'it targets {a}, which holds keys and app data'],
  [/^"(.+)" depends on a variable that may be empty$/, '"{a}" depends on a variable that may be empty'],
];

export function guardReason(t: (key: string) => string, reason: string): string {
  const catastrophe = translateCatastropheReason(reason, t);
  if (catastrophe !== null) return catastrophe;
  for (const [re, key] of PATTERNS) {
    const m = re.exec(reason);
    if (m) return t(key).replace('{a}', m[1]).replace('{b}', m[2] === undefined ? '' : guardReason(t, m[2]));
  }
  return t(reason);
}

export function translateCatastropheReason(reason: string, t: (key: string) => string): string | null {
  const lines = reason.split('\n').map((line) => {
    for (const template of Object.values(catastropheText)) {
      const [before, after] = template.split('{target}');
      if (line.startsWith(before) && line.endsWith(after)) return t(template).replace('{target}', line.slice(before.length, -after.length));
    }
    return null;
  });
  return lines.every((line) => line !== null) ? lines.join('\n') : null;
}

export function catastropheReason(kind: keyof typeof catastropheText, target: string): string {
  return catastropheText[kind].replace('{target}', target);
}

export function catastropheRefusal(reason: string): string {
  return `Not run: ${reason.split('\n').map((line) => line.replace(/\.$/, '')).join('; ')}. Ask the user about this exact target; do not try another command to do the same thing.`;
}
