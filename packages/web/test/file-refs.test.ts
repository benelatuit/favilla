import { describe, expect, it } from 'vitest';
import { fileInCode, fileInLink, filesInText } from '../src/lib/fileRefs';
import { renderMarkdown } from '../src/lib/markdown';

// A file an answer names shows as the file's name, which opens it, where a long path used to stand
// (2026-11-05: "应该把他渲染成一个符合主题可点开的文件名，而不是变成一大长串路径").

/** The file references of rendered HTML: what each points at, its lines and what it shows. */
const refs = (html: string) =>
  [...html.matchAll(/<span class="file-ref"[^>]*data-file="([^"]*)"(?: data-line="(\d+)")?(?: data-end="(\d+)")?[^>]*>.*?<span class="file-ref-name">([^<]*)<\/span>(?:<span class="file-ref-at">([^<]*)<\/span>)?<\/span>/g)].map((m) => ({
    file: m[1].replace(/&amp;/g, '&'),
    line: m[2] ? Number(m[2]) : undefined,
    end: m[3] ? Number(m[3]) : undefined,
    name: m[4],
    at: m[5],
  }));

describe('files named in answers', () => {
  it('knows a file in inline code by its extension, with or without folders and a line', () => {
    expect(fileInCode('packages/core/src/store/sessions.ts:566')).toEqual({ path: 'packages/core/src/store/sessions.ts', line: 566 });
    expect(fileInCode('sessions.ts:566-594')).toEqual({ path: 'sessions.ts', line: 566, end: 594 });
    expect(fileInCode('src/app.tsx:12:7')).toEqual({ path: 'src/app.tsx', line: 12 });
    expect(fileInCode('C:\\Program Files\\Favilla\\resources\\app.json')).toEqual({ path: 'C:\\Program Files\\Favilla\\resources\\app.json' });
    expect(fileInCode('README.md')).toEqual({ path: 'README.md' });
    expect(fileInCode('./scripts/build.mjs')).toEqual({ path: './scripts/build.mjs' });
  });

  it('leaves names, versions, commands and addresses that only look like files', () => {
    for (const text of ['Session.fork', 's.meta', '1.2.5', 'v1.2.4', 'node dist/app.js', 'npm run build', 'https://example.com/a.ts', 'github.com/x/y.ts', 'e.g.', 'this.loadIndex()']) {
      expect(fileInCode(text), text).toBeNull();
    }
  });

  it('finds paths in running text only with a folder before the name, and stops at the sentence', () => {
    const text = '见 C:\\Projects\\app\\packages\\core\\src\\store\\sessions.ts:566，以及 src/agent/session.ts:451-488。Session.fork 不算，https://github.com/a/b/blob/main/src/x.ts 也不算。';
    expect(filesInText(text).map(({ path, line, end }) => ({ path, line, end }))).toEqual([
      { path: 'C:\\Projects\\app\\packages\\core\\src\\store\\sessions.ts', line: 566, end: undefined },
      { path: 'src/agent/session.ts', line: 451, end: 488 },
    ]);
    expect(filesInText('see store.ts for it')).toEqual([]);
  });

  it('takes links to files here, and code files linkify took for web addresses', () => {
    expect(fileInLink('file:///C:/work/app/main.go', 'main.go')).toEqual({ path: 'C:/work/app/main.go' });
    expect(fileInLink('src/store.ts#L42-L60', 'store')).toEqual({ path: 'src/store.ts', line: 42, end: 60 });
    expect(fileInLink('http://README.md', 'README.md')).toEqual({ path: 'README.md' });
    expect(fileInLink('https://github.com/a/b/blob/main/x.ts', 'x.ts')).toBeNull();
    expect(fileInLink('mailto:a@b.md', 'a@b.md')).toBeNull();
  });

  it('shows the file name and its lines in place of the path, pointing at the path as written', () => {
    const html = renderMarkdown('分支在 `packages/core/src/store/sessions.ts:566-594` 里读，入口是 C:\\Projects\\app\\packages\\core\\src\\agent\\session.ts:451，说明见 `README.md`，页面用的是 Vue.js。', 's1');
    expect(refs(html)).toEqual([
      { file: 'packages/core/src/store/sessions.ts', line: 566, end: 594, name: 'sessions.ts', at: ':566–594' },
      { file: 'C:\\Projects\\app\\packages\\core\\src\\agent\\session.ts', line: 451, end: undefined, name: 'session.ts', at: ':451' },
      { file: 'README.md', line: undefined, end: undefined, name: 'README.md', at: undefined },
    ]);
    expect(html).toContain('data-session="s1"');
    // A framework's name in prose is no file: running text gives up only paths with folders.
    expect(html).toContain('页面用的是 Vue.js');
    // The long path is in the tip only.
    expect(html.replace(/data-(file|tip)="[^"]*"/g, '')).not.toContain('Projects');
  });

  it('keeps code in code blocks, text inside other links, and plain inline code as they are', () => {
    const html = renderMarkdown('```\nsrc/store.ts:42\n```\n\n[see src/store.ts](https://example.com/src/store.ts) and `const x = 1`');
    expect(refs(html)).toEqual([]);
    expect(html).toContain('<code>const x = 1</code>');
  });
});
