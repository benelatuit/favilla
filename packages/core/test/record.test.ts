import { describe, expect, it } from 'vitest';
import type { Message } from '../src/types';
import { failingTests, workRecord } from '../src/context/record';

const call = (id: string, name: string, input?: Record<string, unknown>): Message => ({ id: `a${id}`, role: 'assistant', parts: [{ type: 'tool_call', id, name, input: input as Record<string, unknown> }], time: 1 });
const result = (id: string, name: string, content: string, isError = false): Message => ({ id: `r${id}`, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: id, name, content, isError }], time: 1 });

describe('the work record', () => {
  const messages: Message[] = [
    call('1', 'read', { paths: ['src/lexer.ts:1-80', 'README.md'] }),
    result('1', 'read', '...'),
    call('2', 'write', { path: 'reproduce.py', content: 'print(1)' }),
    result('2', 'write', 'Wrote reproduce.py'),
    call('3', 'shell', { command: 'python reproduce.py' }),
    result('3', 'shell', 'Traceback (most recent call last):\nAssertionError: expected 3, got 2\n[exit 1 · 0.4 s]', true),
    call('4', 'edit', { path: 'src/lexer.ts', old_string: 'a', new_string: 'b' }),
    result('4', 'edit', 'Edited src/lexer.ts'),
    call('5', 'edit', { path: 'src/lexer.ts', old_string: 'c', new_string: 'd' }),
    result('5', 'edit', 'Edited src/lexer.ts'),
    call('6', 'shell', { command: 'python reproduce.py' }),
    result('6', 'shell', '3\n[Command finished with exit code 0]'),
    call('7', 'Bash', { command: 'npm test' }),
    result('7', 'Bash', 'Tests: 12 passed, 12 total'),
    call('8', 'exec_command', { cmd: 'go vet ./...' }),
    result('8', 'exec_command', 'Exit code: 2\nWall time: 1.0 seconds\nOutput:\nvet: bad thing'),
    call('9', 'apply_patch', { input: '*** Begin Patch\n*** Add File: notes/plan.md\n+x\n*** Update File: src/parse.ts\n@@\n-a\n+b\n*** End Patch' }),
    result('9', 'apply_patch', 'Done'),
    call('10', 'list_tasks'),
    result('10', 'list_tasks', 'none'),
  ];
  const text = workRecord(messages, { log: true });

  it('lists what was made, changed and only read, from the calls themselves', () => {
    expect(text).toMatch(/Files it made: reproduce\.py, notes\/plan\.md/);
    // A file read before its first change names that read: its text as it was, for recall.
    expect(text).toMatch(/Files it changed: src\/lexer\.ts \(2 edits, its text before the first: recall call_id 1\), src\/parse\.ts \(1 edit\)/);
    expect(text).toMatch(/read and left as they were: README\.md$/m);
    // With code changed whose old text a recall gives back, the record says to look before building on how it worked.
    expect(text).toContain('Before you write code that has to keep how removed or rewritten code worked, recall that code\'s text from before the change');
  });

  it("gives each command how it last ended, in any harness's words", () => {
    expect(text).toMatch(/`python reproduce\.py` \(2 runs\): exit 0/);
    expect(text).toMatch(/`npm test`: exit 0, Tests: 12 passed, 12 total/);
    expect(text).toMatch(/`go vet \.\/\.\.\.`: exit 2, vet: bad thing/);
  });

  it('keeps a line a step, the latest when there are many, and copes with a call that has no input', () => {
    expect(text).toMatch(/1\. read src\/lexer\.ts, README\.md/);
    expect(text).toMatch(/3\. ran `python reproduce\.py`: exit 1/);
    expect(text).toMatch(/10\. list_tasks/);
    const many = Array.from({ length: 90 }, (_, i) => [call(`m${i}`, 'shell', { command: `echo ${i}` }), result(`m${i}`, 'shell', `${i}\n[exit 0 · 0.1 s]`)]).flat();
    const long = workRecord(many, { log: true, steps: 20 });
    expect(long).toMatch(/the last 20 of 90/);
    expect(long).toMatch(/90\. ran `echo 89`/);
    expect(long).not.toMatch(/ 70\. ran/);
  });

  it('leaves the line-a-step log out unless asked for', () => {
    const short = workRecord(messages);
    expect(short).toMatch(/the files are as it left them/);
    expect(short).toMatch(/Commands, with how each last ended/);
    expect(short).not.toMatch(/Its steps/);
  });

  it('reads how a command ended from its whole output when the session let it go from memory', () => {
    const kept = 'collected 40 items\n' + 'x'.repeat(3000) + '\n2 failed, 38 passed in 4.1s\n[exit 1 · 4.2 s]';
    const released: Message = { id: 'r1', role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: 't1', name: 'shell', content: '', contentBlob: 'b1', isError: true }], time: 1 };
    const msgs = [call('t1', 'shell', { command: 'pytest -q' }), released];
    // A failure names its call, so recall brings its whole output back.
    expect(workRecord(msgs)).toMatch(/`pytest -q`: failed \(recall call_id t1\)$/m);
    const back = workRecord(msgs, { text: (r) => (r.contentBlob === 'b1' ? kept : r.content) });
    expect(back).toMatch(/`pytest -q`: exit 1, 2 failed, 38 passed in 4\.1s/);
  });

  it('keeps how the first run of a command ended when the last ended otherwise, with the tests that failed', () => {
    const tap = 'TAP version 13\n# Subtest: keeps every flag of a WF02 frame\nnot ok 2 - keeps every flag of a WF02 frame\n  ---\n  error: expected 5\n  ...\n# tests 4\n# pass 3\n# fail 1';
    const msgs = [
      call('t1', 'shell', { command: 'node --test', workdir: 'wire-frame' }),
      result('t1', 'shell', `${tap}\n[exit 1 · 0.3 s]`, true),
      call('t2', 'shell', { command: 'node --test', workdir: 'harborline' }),
      result('t2', 'shell', '# tests 6\n# pass 6\n# fail 0\n[exit 0 · 0.3 s]'),
      call('t3', 'shell', { command: 'node --test', workdir: 'wire-frame' }),
      result('t3', 'shell', '# tests 4\n# pass 4\n# fail 0\n[exit 0 · 0.3 s]'),
    ];
    const text = workRecord(msgs);
    expect(text).toMatch(/`\(in wire-frame\) node --test` \(2 runs\): exit 0, # fail 0\. The first: exit 1, failing: keeps every flag of a WF02 frame \(recall call_id t1\)$/m);
    expect(text).toMatch(/`\(in harborline\) node --test`: exit 0, # fail 0$/m);
  });

  it('says how long a file printed by a command was, never a line of its code, and names the call to get it back', () => {
    const code = Array.from({ length: 60 }, (_, i) => `  if (code === ${i}) throw new Error('bad status ${i}');`).join('\n');
    const msgs = [call('g1', 'shell', { command: 'git show HEAD~1:src/codec.ts' }), result('g1', 'shell', `${code}\n[exit 0 · 0.1 s]`)];
    expect(workRecord(msgs)).toMatch(/`git show HEAD~1:src\/codec\.ts`: exit 0, 61 lines \(recall call_id g1\)$/m);
  });

  it('is empty when nothing was done', () => {
    expect(workRecord([{ id: 'u', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'hi' }], time: 1 }])).toBe('');
  });
});

describe('web lookups', () => {
  it('names the searches and pages with the calls that hold them, and leaves failed ones out', () => {
    const text = workRecord([
      call('s1', 'web_search', { query: 'cloudflare workers cpu limit' }),
      result('s1', 'web_search', 'Results for ...'),
      call('f1', 'WebFetch', { url: 'https://developers.cloudflare.com/workers/platform/limits/', prompt: 'free plan cpu time' }),
      result('f1', 'WebFetch', 'On "free plan cpu time": 10 ms'),
      call('f2', 'web_fetch', { url: 'https://example.com/gone' }),
      result('f2', 'web_fetch', 'HTTP 404 from https://example.com/gone', true),
    ]);
    expect(text).toContain('- Web searches it ran: "cloudflare workers cpu limit" (call_id s1)');
    expect(text).toContain('- Web pages it read, which recall brings back word for word: https://developers.cloudflare.com/workers/platform/limits/ on "free plan cpu time" (call_id f1)');
    expect(text).not.toContain('example.com/gone (call_id');
  });
});

describe('the tests a run names failing', () => {
  it('reads them in the words of the common runners', () => {
    expect(failingTests('not ok 2 - keeps every flag # TODO later\nnot ok 1 - codec')).toEqual(['keeps every flag', 'codec']);
    expect(failingTests('✔ parses (0.4ms)\n✖ keeps every flag (1.2ms)\n✖ failing tests:\n✖ keeps every flag (1.2ms)')).toEqual(['keeps every flag']);
    expect(failingTests(' FAIL  test/a.test.ts > cart > adds tax\n × adds tax 3ms')).toEqual(['cart > adds tax', 'adds tax']);
    expect(failingTests('  ✕ rounds to cents (4 ms)')).toEqual(['rounds to cents']);
    expect(failingTests('FAILED tests/test_cart.py::test_empty - AssertionError')).toEqual(['tests/test_cart.py::test_empty']);
    expect(failingTests('--- FAIL: TestParse (0.00s)\ntest lexer::tests::eof ... FAILED')).toEqual(['TestParse', 'lexer::tests::eof']);
    expect(failingTests('# tests 4\n# pass 4\n# fail 0')).toEqual([]);
    // TAP escapes a # in a name; the name is given as the test has it.
    expect(failingTests('not ok 6 - ticket \\#5104: two tenants get their own price')).toEqual(['ticket #5104: two tenants get their own price']);
  });
});

describe('files read and then removed', () => {
  it('are named apart, with the reads that showed them, so recall brings their text back', () => {
    const msgs = [
      call('s1', 'read', { path: 'test/repro.spool' }),
      result('s1', 'read', '1\t{"title": "ticket #5104"}'),
      call('s2', 'read', { path: 'src/quotes.ts' }),
      result('s2', 'read', '1\texport {}'),
    ];
    const text = workRecord(msgs, { exists: (p) => p !== 'test/repro.spool' });
    expect(text).toMatch(/Files it read and left as they were: src\/quotes\.ts$/m);
    expect(text).toMatch(/Files it read that are gone now: test\/repro\.spool \(recall call_id s1\)$/m);
  });
});

describe('when more than sixty files are touched', () => {
  it('keeps pre-change recall call_ids and the newest edits instead of cutting after the oldest sixty', () => {
    const msgs = [
      call('r_early', 'read', { path: 'src/early.ts' }),
      result('r_early', 'read', '1\texport const v = 1;'),
      call('e_revisited', 'edit', { path: 'src/revisited.ts' }),
      result('e_revisited', 'edit', 'Edited src/revisited.ts'),
      call('e_early', 'edit', { path: 'src/early.ts' }),
      result('e_early', 'edit', 'Edited src/early.ts'),
      ...Array.from({ length: 65 }, (_, i) => [call(`b${i}`, 'edit', { path: `src/batch_${i}.ts` }), result(`b${i}`, 'edit', `Edited src/batch_${i}.ts`)]).flat(),
      call('r_late', 'read', { path: 'src/late.ts' }),
      result('r_late', 'read', '1\texport const w = 2;'),
      call('e_late', 'edit', { path: 'src/late.ts' }),
      result('e_late', 'edit', 'Edited src/late.ts'),
      call('e_revisited_2', 'edit', { path: 'src/revisited.ts' }),
      result('e_revisited_2', 'edit', 'Edited src/revisited.ts'),
    ];
    const text = workRecord(msgs);
    const line = text.split('\n').find((l) => l.startsWith('- Files it changed:')) ?? '';
    expect(line).toContain('src/early.ts (1 edit, its text before the first: recall call_id r_early)');
    expect(line).toContain('src/late.ts (1 edit, its text before the first: recall call_id r_late)');
    expect(line).toContain('src/revisited.ts (2 edits)');
    expect(line).toContain('src/batch_64.ts (1 edit)');
    expect(line).not.toContain('src/batch_0.ts');
    expect(line).toContain(', and 8 more');
  });

  it('pins shrunk/deleted-code edits first when every file was read before editing, and attaches recall call_id to long command stdout', () => {
    const msgs = [
      call('r_shrunk', 'read', { path: 'src/legacy_removed.ts' }),
      result('r_shrunk', 'read', '1\texport const oldToken = "LEGACY-42";\n2\texport const deprecated = true;'),
      call('e_shrunk', 'edit', {
        path: 'src/legacy_removed.ts',
        oldString: 'export const oldToken = "LEGACY-42";\nexport const deprecated = true;\n',
        newString: '',
      }),
      result('e_shrunk', 'edit', 'Edited src/legacy_removed.ts'),
      ...Array.from({ length: 65 }, (_, i) => [
        call(`rb${i}`, 'read', { path: `src/mod_${i}.ts` }),
        result(`rb${i}`, 'read', `1\texport const m${i} = 1;`),
        call(`eb${i}`, 'edit', { path: `src/mod_${i}.ts`, oldString: `m${i} = 1`, newString: `m${i} = 200` }),
        result(`eb${i}`, 'edit', `Edited src/mod_${i}.ts`),
      ]).flat(),
      call('cmd_long', 'shell', { command: 'node scripts/dump-metrics.mjs' }),
      result('cmd_long', 'shell', `${Array.from({ length: 8 }, (_, i) => `metric_${i}=${i * 10}`).join('\n')}\n[exit 0 · 0.1s]`),
    ];
    const text = workRecord(msgs);
    expect(text).toContain('src/legacy_removed.ts (1 edit, its text before the first: recall call_id r_shrunk)');
    expect(text).toContain('`node scripts/dump-metrics.mjs`: exit 0, metric_7=70 (recall call_id cmd_long)');
  });

  it('pins early exit-0 diagnostic outputs and earlier-failing commands when >40 ephemeral shell probes follow', () => {
    const diagStdout = Array.from({ length: 12 }, (_, i) => `window_${i}: skew=${(i * 0.003).toFixed(3)} ok`).join('\n');
    const msgs: Message[] = [
      // 1) Early one-time exit-0 diagnostic command (including compact 3-line non-test output):
      call('diag_1', 'shell', { command: 'node scripts/inspect-windows.mjs --stage 1' }),
      result('diag_1', 'shell', `${diagStdout}\n[exit 0 · 0.2s]`),
      call('diag_short', 'shell', { command: 'node scripts/drain-spool.mjs --summary' }),
      result('diag_short', 'shell', 'drained=14\nquarantined=2\nchecksum=0x9f3a\n[exit 0 · 0.1s]'),
      // 2) Early test suite that failed on its first run and later passed:
      call('suite_fail', 'shell', { command: 'node --test test/core.test.mjs' }),
      result('suite_fail', 'shell', 'not ok 1 - handles boundary window\n[exit 1 · 0.2s]', true),
      call('suite_pass', 'shell', { command: 'node --test test/core.test.mjs' }),
      result('suite_pass', 'shell', '# pass 5\n# fail 0\n[exit 0 · 0.2s]'),
      // 3) Early ephemeral grep (should be evicted when 45 newer ephemeral probes run):
      call('old_grep', 'shell', { command: 'rg -n "skew" src/old_probe.ts' }),
      result('old_grep', 'shell', `${Array.from({ length: 8 }, (_, i) => `src/old_probe.ts:${i + 1}: skew`).join('\n')}\n[exit 0 · 0.05s]`),
      // 4) 45 subsequent ephemeral probes (`grep`, `ls`, `npm test`):
      ...Array.from({ length: 45 }, (_, i) => [
        call(`ep_${i}`, 'shell', { command: `grep -n "tok_${i}" src/index.ts` }),
        result(`ep_${i}`, 'shell', `12:tok_${i}\n[exit 0 · 0.02s]`),
      ]).flat(),
    ];

    const text = workRecord(msgs);
    expect(text).toContain('(40 of 49 unique commands; earlier runs searchable via recall)');
    expect(text).toContain('`node scripts/inspect-windows.mjs --stage 1`: exit 0, window_11: skew=0.033 ok (recall call_id diag_1)');
    // Kept in the list; a call id for short output is a separate matter.
    expect(text).toContain('`node scripts/drain-spool.mjs --summary`: exit 0, checksum=0x9f3a');
    expect(text).toContain('`node --test test/core.test.mjs` (2 runs): exit 0, # fail 0. The first: exit 1, failing: handles boundary window (recall call_id suite_fail)');
    expect(text).not.toContain('src/old_probe.ts');
    expect(text).toContain('`grep -n "tok_44" src/index.ts`');
  });
});
