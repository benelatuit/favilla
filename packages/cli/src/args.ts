/**
 * A prompt that opens with a dash ("- Fix the failing import", a list pasted as the task) reads to commander as an
 * unknown option, and the run ends before it starts: a task given that way had Favilla exit with "unknown option"
 * (2026-11-08). No option name holds a space, so an argument with one
 * before any "=" is a word of the prompt. When one is there, the prompt's words go after "--" in their order, where
 * commander takes them as words, and the options and their values stay before it. A command (login, models) is left
 * as it is.
 */
export function promptWordsLast(args: string[], takesValue: (flag: string) => boolean, isCommand: (word: string) => boolean): string[] {
  const end = args.indexOf('--');
  const head = end < 0 ? args : args.slice(0, end);
  const options: string[] = [];
  const words: string[] = [];
  let dashed = false;
  let value = false;
  for (const a of head) {
    if (value) {
      options.push(a);
      value = false;
      continue;
    }
    const sentence = /\s/.test(a) && !a.split(/\s/, 1)[0]!.includes('=');
    if (a.length > 1 && a.startsWith('-') && !sentence) {
      options.push(a);
      value = !a.includes('=') && takesValue(a);
      continue;
    }
    if (a.length > 1 && a.startsWith('-')) dashed = true;
    words.push(a);
  }
  if (!dashed || (words.length && isCommand(words[0]!))) return args;
  return [...options, '--', ...words, ...(end < 0 ? [] : args.slice(end + 1))];
}
