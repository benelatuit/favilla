import { describe, expect, it } from 'vitest';
import { applyChunks, parsePatch } from '../src/tools/patch';

describe('parsePatch', () => {
  it('parses add, update with move, and delete sections', () => {
    const ops = parsePatch(`*** Begin Patch
*** Add File: hello.txt
+Hello
+world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-    print("hi")
+    print("hello")
*** Delete File: old.txt
*** End Patch`);
    expect(ops.map((o) => o.type)).toEqual(['add', 'update', 'delete']);
    expect(ops[0]).toMatchObject({ path: 'hello.txt', content: 'Hello\nworld\n' });
    expect(ops[1]).toMatchObject({ path: 'src/app.py', moveTo: 'src/main.py' });
  });

  it('accepts a heredoc wrapper and missing markers', () => {
    const ops = parsePatch(`apply_patch <<'EOF'
*** Update File: a.txt
@@
-a
+b
EOF`);
    expect(ops).toHaveLength(1);
  });

  it('rejects text without operations', () => {
    expect(() => parsePatch('just some text')).toThrow(/No patch operations/);
  });
});

describe('applyChunks', () => {
  const src = 'def greet():\n    print("hi")\n\ndef bye():\n    print("bye")\n';

  it('applies a chunk located by its @@ context', () => {
    const [op] = parsePatch(`*** Begin Patch
*** Update File: x.py
@@ def bye():
-    print("bye")
+    print("goodbye")
*** End Patch`);
    if (op.type !== 'update') throw new Error('expected update');
    expect(applyChunks(src, op.chunks, 'x.py')).toContain('print("goodbye")');
  });

  it('tolerates trailing whitespace and unicode punctuation differences', () => {
    const [op] = parsePatch(`*** Begin Patch
*** Update File: x.py
@@
 def greet():
-    print(“hi”)
+    print("hey")
*** End Patch`);
    if (op.type !== 'update') throw new Error('expected update');
    expect(applyChunks(src.replace('def greet():', 'def greet():   '), op.chunks, 'x.py')).toContain('print("hey")');
  });

  it('keeps CRLF line endings', () => {
    const [op] = parsePatch('*** Begin Patch\n*** Update File: x\n@@\n-a\n+b\n*** End Patch');
    if (op.type !== 'update') throw new Error('expected update');
    expect(applyChunks('a\r\nc\r\n', op.chunks, 'x')).toBe('b\r\nc\r\n');
  });

  it('fails clearly when the lines are not there', () => {
    const [op] = parsePatch('*** Begin Patch\n*** Update File: x\n@@\n-missing line\n+b\n*** End Patch');
    if (op.type !== 'update') throw new Error('expected update');
    expect(() => applyChunks('a\n', op.chunks, 'x')).toThrow(/Failed to find the expected lines/);
  });
});
