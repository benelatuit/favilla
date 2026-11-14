import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeFile, decodeOutput, encode1252, encodeGbk, OutputDecoder } from '../src/util/text';
import { editTool, patchTool, readTool, writeTool } from '../src/tools/fs-tools';
import { grepTool } from '../src/tools/search-tools';
import { FileTracker } from '../src/tools/filestate';
import { Checkpoints } from '../src/agent/checkpoints';
import { BlobStore } from '../src/store/blobs';
import type { ToolContext } from '../src/tools/types';

// Text that is not all UTF-8: command output from Windows tools in the ANSI code page, legacy source files in GBK.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-encoding-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const ctx = {
  cwd: root,
  turn: 't',
  files: new FileTracker(),
  checkpoints: new Checkpoints(path.join(root, '.cp'), new BlobStore(path.join(root, '.blobs'))),
  config: {},
  outputChars: 20_000,
  signal: new AbortController().signal,
} as unknown as ToolContext;
const text = (r: { content: unknown }) => String(r.content);

describe('output that is not all UTF-8', () => {
  it('decodes each line on its own, so one stray byte garbles only its line', () => {
    const buf = Buffer.concat([Buffer.from('✓ 通过 tests passed\n', 'utf8'), Buffer.from([0xff]), Buffer.from('\n完成\n', 'utf8')]);
    const text = decodeOutput(buf);
    expect(text).toContain('✓ 通过 tests passed');
    expect(text).toContain('完成');
  });

  it('reads a GBK line as GBK', () => {
    expect(decodeOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]))).toBe('中文\n');
  });

  it('reads a line of Western one-byte text as that, not as GBK', () => {
    // A compiler's message in the ANSI code page of a German or French system.
    expect(decodeOutput(Buffer.concat([Buffer.from('✓ ok\n', 'utf8'), encode1252('Datei nicht gefunden: Übersicht für März.txt\n')!]))).toBe('✓ ok\nDatei nicht gefunden: Übersicht für März.txt\n');
  });

  it('reads a Western line that pairs up as GBK by the lines around it', () => {
    // "süß" alone is fc df, a valid GBK pair; the other lines say the output is Western.
    const out = encode1252('Zucker ist süß,\nÄpfel für den Kuchen\nund Käse dazu.\n')!;
    expect(decodeOutput(out)).toBe('Zucker ist süß,\nÄpfel für den Kuchen\nund Käse dazu.\n');
  });

  it('keeps a character split between two chunks whole', () => {
    const bytes = Buffer.from('进度 50%', 'utf8');
    const d = new OutputDecoder();
    const text = d.push(bytes.subarray(0, 4)) + d.push(bytes.subarray(4)) + d.end();
    expect(text).toBe('进度 50%');
  });
});

describe('a GBK source file', () => {
  it('turns back into the same bytes, and an edit keeps it GBK', async () => {
    const gbk = encodeGbk('// 中文注释\nconst a = 1;\n')!;
    expect(decodeFile(gbk)).toEqual({ text: '// 中文注释\nconst a = 1;\n', encoding: 'gbk' });
    const file = path.join(root, 'legacy.c');
    fs.writeFileSync(file, gbk);
    const r = await editTool.execute({ path: 'legacy.c', old: 'const a = 1;', new: 'const a = 2;', requireRead: false }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(file)).toEqual(encodeGbk('// 中文注释\nconst a = 2;\n'));
  });

  it('refuses text GBK cannot hold rather than writing it as something else', async () => {
    const file = path.join(root, 'legacy2.c');
    fs.writeFileSync(file, encodeGbk('// 中文\n')!);
    await expect(editTool.execute({ path: 'legacy2.c', old: '中文', new: '中文 😀', requireRead: false }, ctx)).rejects.toThrow(/GBK cannot hold/);
    expect(decodeFile(fs.readFileSync(file)).text).toBe('// 中文\n');
  });
});

describe('a GBK file beside Western ones', () => {
  it('stays GBK when a rare character has an ASCII second byte', () => {
    // 镕 is e9 46: its first byte stands alone the way a Western letter does, the rest of the text decides.
    for (const s of ['// 中文注释\n', 'name = "朱镕基"; // 姓名\n', 'x = 1 # 数量\n']) expect(decodeFile(encodeGbk(s)!)).toEqual({ text: s, encoding: 'gbk' });
  });
});

describe('a Windows-1252 file', () => {
  // German, French and Spanish text of the years before UTF-8, and what Windows tools in those countries still write.
  it('reads as its own text, not as GBK', () => {
    // "über" pairs up as valid GBK (fc 62): it was declared GBK, shown as a Chinese character, and new text went
    // into the file in GBK.
    for (const s of ['über\n', 'Lieferung an: Gänsemarkt 3\r\nGröße: 5 – “groß”, 10 €\r\n', 'café\nx\n', 'Señor Núñez, ¿cuándo?\n']) expect(decodeFile(encode1252(s)!)).toEqual({ text: s, encoding: 'cp1252' });
  });

  it('is edited in place: its encoding, its line ends and every other byte stay', async () => {
    const file = path.join(root, 'brief.txt');
    fs.writeFileSync(file, encode1252('Lager Süd · Gänsemarkt 3\r\n\r\nSehr geehrte Frau Müller,\r\n')!);
    const r = await editTool.execute({ path: 'brief.txt', old: 'Lager Süd · Gänsemarkt 3', new: 'Lager Süd · Mönckebergstraße 11', requireRead: false }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(file)).toEqual(encode1252('Lager Süd · Mönckebergstraße 11\r\n\r\nSehr geehrte Frau Müller,\r\n'));
    const patch = ['*** Begin Patch', '*** Update File: brief.txt', '@@', '-Sehr geehrte Frau Müller,', '+Sehr geehrter Herr Weiß,', '*** End Patch'].join('\n');
    expect((await patchTool.execute({ patch }, ctx)).isError).toBeFalsy();
    expect(fs.readFileSync(file)).toEqual(encode1252('Lager Süd · Mönckebergstraße 11\r\n\r\nSehr geehrter Herr Weiß,\r\n'));
  });

  it('stays Windows-1252 when it is written whole', async () => {
    const file = path.join(root, 'carte.txt');
    fs.writeFileSync(file, encode1252('entrée\r\n')!);
    ctx.files.recordRead(file);
    expect((await writeTool.execute({ path: 'carte.txt', content: 'entrée\nplat du jour : bœuf\n' }, ctx)).isError).toBeFalsy();
    expect(fs.readFileSync(file)).toEqual(encode1252('entrée\r\nplat du jour : bœuf\r\n'));
  });

  it('refuses a character it has no byte for, and names it', async () => {
    const file = path.join(root, 'liste.txt');
    const bytes = encode1252('Müller\nx\n')!;
    fs.writeFileSync(file, bytes);
    await expect(editTool.execute({ path: 'liste.txt', old: 'x', new: 'Łukasz 北', requireRead: false }, ctx)).rejects.toThrow(/Windows-1252 .* cannot hold: Ł 北\./);
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it('is shown as its text, with a line saying what it is', async () => {
    fs.writeFileSync(path.join(root, 'preis.txt'), encode1252('Preis für Größe M: 12 €\r\n')!);
    const shown = text(await readTool.execute({ path: 'preis.txt' }, ctx));
    expect(shown).toContain('Preis für Größe M: 12 €');
    expect(shown).toContain('preis.txt is not UTF-8: it is read as Windows-1252');
    fs.writeFileSync(path.join(root, 'plain.txt'), 'Preis für Größe M\n');
    expect(text(await readTool.execute({ path: 'plain.txt' }, ctx))).not.toContain('not UTF-8');
  });
});

describe('a search for text above ASCII', () => {
  const dir = path.join(root, 'search');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'old.txt'), encode1252('Lager: Gänsemarkt 3\r\ncafe\r\ncafé\r\n')!);
  fs.writeFileSync(path.join(dir, 'new.py'), 'ADDRESS = "Gänsemarkt 3"\n');
  // Its bytes hold e9, the first byte of 道 in UTF-8 and é in Windows-1252.
  fs.writeFileSync(path.join(dir, 'tao.md'), '道可道\n');
  fs.writeFileSync(path.join(dir, 'legacy.c'), encodeGbk('// 中文注释\nint a;\n')!);
  const here = { ...ctx, cwd: dir } as unknown as ToolContext;

  it('finds it in a Windows-1252 file as well, and says what the file is', async () => {
    const r = text(await grepTool.execute({ pattern: 'Gänsemarkt', mode: 'content' }, here));
    expect(r).toContain('new.py:1:ADDRESS = "Gänsemarkt 3"');
    expect(r).toContain('old.txt:1:Lager: Gänsemarkt 3');
    expect(r).toContain('Not UTF-8: old.txt is Windows-1252.');
  });

  it('in the list of files, the count and the grouped form', async () => {
    expect(text(await grepTool.execute({ pattern: 'Gänsemarkt', mode: 'files' }, here))).toMatch(/2 files match[^]*old\.txt/);
    expect(text(await grepTool.execute({ pattern: 'Gänsemarkt', mode: 'count' }, here))).toContain('old.txt:1');
    const grouped = text(await grepTool.execute({ pattern: 'Gänsemarkt', mode: 'content', grouped: true }, here));
    expect(grouped).toMatch(/2 matching lines in 2 files[^]*old\.txt\n1:Lager: Gänsemarkt 3/);
  });

  it('leaves out a UTF-8 file that matches only when misread', async () => {
    const r = text(await grepTool.execute({ pattern: 'é', mode: 'files' }, here));
    expect(r).toContain('old.txt');
    expect(r).not.toContain('tao.md');
  });

  it('gives each line once when the pattern matches it either way', async () => {
    const r = text(await grepTool.execute({ pattern: 'caf(é|e)', mode: 'content' }, here));
    expect(r.match(/old\.txt:2:cafe/g)).toHaveLength(1);
    expect(r.match(/old\.txt:3:café/g)).toHaveLength(1);
  });

  it('finds Chinese in a GBK file', async () => {
    const r = text(await grepTool.execute({ pattern: '中文', mode: 'content' }, here));
    expect(r).toContain('legacy.c:1:// 中文注释');
    expect(r).toContain('legacy.c is GBK');
  });

  it('says nothing of encodings when the pattern is plain ASCII', async () => {
    const r = text(await grepTool.execute({ pattern: 'cafe', mode: 'content' }, here));
    expect(r).toContain('old.txt:2:cafe');
    expect(r).not.toContain('Not UTF-8');
  });
});

describe('a file in an encoding that is not known', () => {
  it('is not written by an edit, so its characters are not destroyed', async () => {
    // Windows-1251: Russian words are runs of high bytes, and these do not pair up as GBK.
    const file = path.join(root, 'notes.txt');
    const bytes = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xec, 0xe8, 0xf0, 0x0a, 0x78, 0x0a]);
    fs.writeFileSync(file, bytes);
    expect(decodeFile(bytes).encoding).toBe('unknown');
    await expect(editTool.execute({ path: 'notes.txt', old: 'x', new: 'y', requireRead: false }, ctx)).rejects.toThrow(/not UTF-8 or GBK/);
    expect(fs.readFileSync(file)).toEqual(bytes);
    const patch = ['*** Begin Patch', '*** Update File: notes.txt', '@@', '-x', '+y', '*** End Patch'].join('\n');
    const r = await patchTool.execute({ patch }, ctx);
    expect(r.isError).toBe(true);
    expect(fs.readFileSync(file)).toEqual(bytes);
  });
});
