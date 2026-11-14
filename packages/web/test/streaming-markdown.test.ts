import assert from 'node:assert/strict';
import { it } from 'vitest';
import { renderFullStreaming, renderStreamingParts } from '../src/lib/markdown';

function renderStreaming(text: string, session: string): string {
  const { prefix, tail } = renderStreamingParts(text, session);
  return prefix + tail;
}

const fixtures = {
  'prose, blank lines and headings without fences': [
    '# First heading', '', 'First paragraph with *emphasis*.', 'A continued line.', '  ',
    'Second paragraph with `src/index.ts` and 试验.', '', 'Heading by underline', '===', '',
    'Third paragraph.', '', 'Fourth paragraph.', '', '---', '', 'One last paragraph.', '',
  ],
  'list, quote and table boundaries without fences': [
    'Intro.', '', 'Paragraph before a list.', '', '- First item', '  - Nested item', '',
    '    Same item after a blank.', 'Lazy continuation.', '', '- Second item', '',
    'Paragraph outside the list.', '', '> Quoted text.', 'Still quoted.', '',
    'Outside again.', '', '| Key | Value |', '| --- | --- |', '| A | 1 |', '', 'Tail.', '',
  ],
  'definitions that arrive after apparently settled paragraphs': [
    '[See the file][source] and [short].', '', 'Next paragraph.', '',
    'Another paragraph with ![plot][picture].', '', '[source]:', '  ./src/index.ts#L9', '',
    '[short]: #target', '[picture]: ./plot.png "small"', '', 'The end.', '',
  ],
  'prose, pictures and file links': [
    '# Review / 审阅', '',
    'File `src/import.ts:12` and [the report](#report). 这里是检查结果。',
    '![图示](./chart.png "small")', '',
    '```ts', 'const complete = true;', '```', '',
    'See [import.ts](./src/import.ts#L12) and ![another figure](./next.png).',
  ],
  'a table while its separator and rows arrive': [
    '```python', 'print("ready")', '```', '',
    '| Case | Outcome |', '| :--- | ---: |', '| One | Pass |',
    '| 二 | ![图](chart.png) |', '| Three | [Result](#result) |', '',
    '```sql', "SELECT 'complete' AS status;", '```', '',
    'End of table.',
  ],
  'loose and tight nested lists with indented code': [
    '```ts', 'const list = [];', '```', '',
    '1. Prepare', '   - Read the header', '     - Preserve case', '',
    '       Extra detail.', '   - Check the rows', '2. Close', '',
    '    not nested here', '',
    '```python', 'for row in rows:', '    print(row)', '```', '',
    '- A new list',
  ],
  'forward references and later definitions': [
    '[The source][doc], [doc], ![a picture][picture] and [the long label][two words].', '',
    '~~~text', 'A hard boundary.', '~~~', '',
    '> [doc]: ./src/report.ts#L8', '',
    '[picture]: ./picture.png "small"', '',
    '[two', 'words]: #the-result', '',
    '[The source][doc] again.',
  ],
  'setext headings and a following indented block': [
    'Early title', '===========', '',
    '```sql', 'SELECT 1;', '```', '',
    'New title', '---', '',
    '    first line', '    second line', '', '    more after a blank', '',
    'A new paragraph.', '',
    '```text', 'another completed fence', '```', '',
    'Last words',
  ],
  'quoted fences and an unclosed fence after a completed one': [
    '> A nested block.', '> ```js', '> const value = 1;', '> ```', '',
    '```mermaid', 'flowchart LR', '  a --> b', '```', '',
    'The next block is still open.', '',
    '```python', 'payload = {"head": "数据", "count": 1}', '  ',
  ],
  'long backtick fences and synthetic fence parity': [
    '````text', '```', 'Literal backticks within the longer fence.', '````', '',
    'The total of backtick-starting lines is odd.', '',
    '```ts', 'const x = `hello`;', '```', '',
    'Trailing prose.',
  ],
  'Windows newlines and trailing spaces on fences': [
    '```ts', 'const x = 0;', '``` ', '', 'Next heading', '---',
    '', '    Indented code', '    and another line.', '',
  ].join('\r\n').split('\n'),
};

for (const [name, lines] of Object.entries(fixtures)) {
  it('renders every streaming prefix exactly as a full parse for ' + name, () => {
    const text = lines.join('\n');
    for (let length = 0; length <= text.length; length++) {
      const prefix = text.slice(0, length);
      assert.equal(renderStreaming(prefix, 'fixture'), renderFullStreaming(prefix, 'fixture'), name + ', prefix ' + length);
    }
  });
}

it('settles prose past a blank and discards it when a reference definition arrives', () => {
  const first = 'First paragraph with [later].\n\n';
  const next = first + 'Another paragraph.';
  assert.equal(renderStreamingParts(next, 'prose').prefix, '');
  assert.equal(renderStreamingParts(next + '\n', 'prose').prefix, renderFullStreaming(first, 'prose'));
  const defined = next + '\n\n[later]: #target';
  assert.deepEqual(renderStreamingParts(defined, 'prose'), { prefix: '', tail: renderFullStreaming(defined, 'prose') });
});

it('uses the correct session for a settled prefix after switching drafts or going back', () => {
  const base = '![Picture](./image.png)\n\n`src/view.ts:12`\n\n```ts\nconst x = 1;\n```\n';
  const extended = base + '\nMore work.';
  for (const [text, session] of [
    [base, 'first'], [extended, 'first'], [extended, 'second'], [base.slice(0, -2), 'first'],
    [base + '\n[link]: ./other.md', 'first'], [extended, 'first'],
  ]) {
    assert.equal(renderStreaming(text, session), renderFullStreaming(text, session));
  }
});
