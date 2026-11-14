import { describe, expect, it } from 'vitest';
import { isVague, sessionTitle, titleWithFile } from '../src/agent/title';
import { attach, pastedBlock } from '../src/prompt/attached';

const name = (text: string) => sessionTitle(text).title;
const traceback = [
  'Traceback (most recent call last):',
  '  File "C:\\Users\\dev\\tally\\src\\load.py", line 12, in <module>',
  '    rows = read(path)',
  "ValueError: invalid literal for int() with base 10: '12.50'",
].join('\n');
const stack = "TypeError: Cannot read properties of undefined (reading 'map')\n    at renderRows (src/table.tsx:41:18)";

describe('a session is named after what its first message asks', () => {
  it('takes the sentence that says it, without the greeting and the asking around it', () => {
    expect(name('Hi! Can you please fix the login timeout in @src/auth/session.ts?')).toBe('Fix the login timeout in session.ts');
    expect(name('I want a dark mode for the settings page')).toBe('A dark mode for the settings page');
    expect(name('你好，请帮我看看为什么测试一直挂，谢谢')).toBe('为什么测试一直挂');
    expect(name('\nFix the parser\nand run the tests')).toBe('Fix the parser');
    expect(name('/plan add a dark mode to the settings page')).toBe('Add a dark mode to the settings page');
  });

  it('stops before a colon when what comes before it says the work, and keeps a label with what follows', () => {
    expect(name('A payee with a comma in it breaks the import: the amount comes out wrong. Fix the parser.')).toBe('A payee with a comma in it breaks the import');
    expect(name('登录老是超时：用户点登录以后转圈三十秒才报错。修一下')).toBe('登录老是超时');
    expect(name('TypeError: x is undefined')).toBe('TypeError: x is undefined');
    expect(name('Bug: the login page times out')).toBe('Bug: the login page times out');
  });

  it('does not cut the start of ordinary words that look like a request', () => {
    expect(name('请求超时的问题修一下')).toBe('请求超时的问题修一下');
    expect(name('现在的实现太慢了，能不能优化一下')).toBe('现在的实现太慢了，能不能优化一下');
    expect(name('给我们的 README 加一段安装说明')).toBe('给我们的 README 加一段安装说明');
    expect(name('Next.js build fails after the upgrade')).toBe('Next.js build fails after the upgrade');
    expect(name('OK button sits under the keyboard on phones')).toBe('OK button sits under the keyboard on phones');
    expect(name('First-run tour never ends')).toBe('First-run tour never ends');
    expect(name('Hello, now please add a CSV export')).toBe('Add a CSV export');
  });

  it('leaves code out and writes paths and links as the names they point at', () => {
    expect(name('```ts\nwhile (i < n) step();\n```\nWhy does this loop never end?')).toBe('Why does this loop never end');
    expect(name('把 C:\\Projects\\tally\\src\\parse.ts 里的金额改成按分存')).toBe('把 parse.ts 里的金额改成按分存');
    expect(name('Look at https://github.com/acme/ledger/issues/482 and fix it')).toBe('Look at ledger#482 and fix it');
    expect(name('https://github.com/someone/evo-seat')).toBe('evo-seat');
    // A sentence that points at the link takes its name; one that already says it stays as it is.
    expect(name('How is this built? https://github.com/someone/evo-seat')).toBe('How is this built · evo-seat');
    expect(name('这个人的东西是怎么实现的？https://github.com/someone/evo-seat')).toBe('这个人的东西是怎么实现的 · evo-seat');
    expect(name('Port the reader in https://github.com/acme/csvkit to TypeScript')).toBe('Port the reader in csvkit to TypeScript');
  });

  it('keeps a lower-case tool name as the tools write it', () => {
    expect(name('npm install fails on the runner')).toBe('npm install fails on the runner');
    expect(name('continue')).toBe('Continue');
  });

  it('fits the title bar, stopping at a clause when one ends in the room, counting a CJK character as two', () => {
    expect(name('我想做一个记账应用，可以导入银行流水，自动分类，每个月出一份报表，还能在手机上看')).toBe('做一个记账应用，可以导入银行流水，自动分类');
    expect(name('Refactor the invoice scanner so that every page is read twice and filed only when both agree')).toBe('Refactor the invoice scanner so that every…');
  });

  it('takes the error a paste ends in when the words say nothing of the work', () => {
    expect(name(attach('看看这个报错', [pastedBlock(traceback, 1)]))).toBe('ValueError: invalid literal for int() with…');
    expect(name(attach('fix it', [pastedBlock(stack, 1)]))).toBe('TypeError: Cannot read properties of undefined…');
    expect(name(attach('', [pastedBlock(traceback, 1)]))).toBe('ValueError: invalid literal for int() with…');
    expect(name(attach('Fix the parser', [pastedBlock(traceback, 1)]))).toBe('Fix the parser');
  });

  it('names the file attached when there are no other words, and nothing at all for an image alone', () => {
    const file = '<file path="src/parse.ts">\n1 export function parseRow() {}\n</file>';
    expect(name(attach('', [file]))).toBe('parse.ts');
    expect(name(attach('look at this', [file]))).toBe('Look at this · parse.ts');
    expect(name('')).toBe('');
    expect(name('你好')).toBe('');
  });

  it('marks a name that says little, for the first turn to add the file it changed', () => {
    expect(sessionTitle('继续')).toEqual({ title: '继续', vague: true });
    expect(sessionTitle('fix it').vague).toBe(true);
    expect(isVague('Fix the login bug')).toBe(false);
    expect(isVague('修一下登录超时')).toBe(false);
    expect(isVague('看看这个项目')).toBe(true);
    expect(titleWithFile('继续', 'C:/dev/tally/src/parse.ts')).toBe('继续 · parse.ts');
  });

  it('takes no time worth counting', () => {
    const long = `${'The import drops rows when a payee has a comma, '.repeat(200)}\n${'x'.repeat(20_000)}`;
    const start = performance.now();
    for (let i = 0; i < 200; i++) sessionTitle(long);
    expect((performance.now() - start) / 200).toBeLessThan(5);
  });
});
