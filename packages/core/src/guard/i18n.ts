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
  'This would erase the folder {target}.': '这会清空文件夹 {target}。',
  'This would destroy repository history at {target}.': '这会破坏 {target} 中的仓库历史。',
  'This would overwrite or repartition the disk {target}.': '这会覆盖磁盘 {target} 或重新分区。',
  'This would destroy the database {target}.': '这会销毁数据库 {target}。',
  'This would destroy the schema {target}.': '这会销毁 schema {target}。',
  'This would flush the key-value store {target}.': '这会清空键值存储 {target}。',
  'The path {target} could erase a filesystem root if its variable is empty.': '如果变量为空，路径 {target} 可能会清空文件系统根目录。',
};

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
