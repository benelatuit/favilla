import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { officeText, unzip } from '../src/tools/office';
import { readTool } from '../src/tools/fs-tools';
import { FileTracker } from '../src/tools/filestate';
import type { ToolContext } from '../src/tools/types';

/** A zip of the given files, the first stored and the rest deflated, as Office writes them. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const raw = Buffer.from(text, 'utf8');
    const method = i === 0 ? 0 : 8;
    const data = method ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(zlib.crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(zlib.crc32(raw), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

describe('reading Office files', () => {
  it('unzips stored and deflated entries', () => {
    const files = unzip(zip({ 'a.txt': 'plain', 'b/c.xml': '<x>deflated &amp; back</x>' }));
    expect(files.get('a.txt')?.toString()).toBe('plain');
    expect(files.get('b/c.xml')?.toString()).toBe('<x>deflated &amp; back</x>');
  });

  it('gives a .docx as markdown: headings by their style names, list items, tables', () => {
    const doc = `<w:document ${W}><w:body>
      <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>周会纪要</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">参会：王芳、</w:t></w:r><w:r><w:t>Sara &amp; 小林</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>小程序暂停</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>负责人</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>截止</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>陈默</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>11 月 13 日</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`;
    // A Chinese Word names the style id "1" and calls it heading 1 in styles.xml.
    const styles = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style></w:styles>`;
    expect(officeText(zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': doc, 'word/styles.xml': styles }), '.docx')).toBe(
      '# 周会纪要\n\n参会：王芳、Sara & 小林\n\n- 小程序暂停\n\n| 负责人 | 截止 |\n| --- | --- |\n| 陈默 | 11 月 13 日 |',
    );
  });

  it('gives each sheet of an .xlsx as a grid, a formula with its value and a date as a date', () => {
    const files = {
      '[Content_Types].xml': '<Types/>',
      'xl/workbook.xml': '<workbook><sheets><sheet name="October" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Date</t></si><si><t>Total</t></si><si><r><t>Bake</t></r><r><t>ry</t></r></si></sst>',
      'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" s="1"><v>46298</v></c><c r="B2" t="s"><v>2</v></c><c r="C2"><v>5.3</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>Sum</t></is></c><c r="C3"><f>SUM(C2:C2)</f><v>5.3</v></c></row></sheetData></worksheet>',
    };
    expect(officeText(zip(files), '.xlsx')).toBe(
      '## Sheet: October\n\n|  | A | B | C |\n| --- | --- | --- | --- |\n| 1 | Date |  | Total |\n| 2 | 2026-10-03 | Bakery | 5.3 |\n| 3 | Sum |  | =SUM(C2:C2) → 5.3 |',
    );
  });

  it('does not count sampled sheets as fully read and preserves rendered offsets across sheets', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'read-sheets-'));
    try {
      const file = path.join(cwd, 'stock.xlsx');
      const rows = Array.from({ length: 350 }, (_, i) => `<row r="${i+1}"><c r="B${i+1}"><v>${i+1}</v></c></row>`).join('');
      fs.writeFileSync(file, zip({
        'xl/workbook.xml': '<sheet name="First" r:id="a"/><sheet name="Second" r:id="b"/>',
        'xl/_rels/workbook.xml.rels': '<Relationship Id="a" Target="worksheets/a.xml"/><Relationship Id="b" Target="worksheets/b.xml"/>',
        'xl/worksheets/a.xml': rows, 'xl/worksheets/b.xml': rows,
      }));
      const files = new FileTracker();
      const ctx = { cwd, files, callId: 'first', inContext: () => true, outputChars: 89600 } as unknown as ToolContext;
      const preview = await readTool.execute({ path: file }, ctx);
      expect(preview.content).toContain('first 8 and last 2 of 350');
      expect(preview.content).toContain('Second');
      expect(preview.content).not.toContain('| 250 |');
      expect(files.readWhole(file)).toBe(false);
      const tail = await readTool.execute({ path: file, tail: 2 }, { ...ctx, files: new FileTracker() });
      expect(tail.content).toMatch(/708\t\| 349 [^\n]*\n\s*709\t\| 350/);
      const range = await readTool.execute({ path: file, offset: 609, limit: 1 }, ctx);
      expect(range.content).toContain('609\t| 250 |  | 250 |');
      const beforeLast = await readTool.execute({ path: file, offset: 1, limit: 708 }, ctx);
      expect(beforeLast.content).toContain('of 709');
      expect(files.readWhole(file)).toBe(false);
      const whole = await readTool.execute({ path: file, offset: 1, limit: 900 }, ctx);
      expect(whole.content).toContain('254\t| 250 |  | 250 |');
      expect(whole.content).toContain('709\t| 350 |  | 350 |');
      expect(files.readWhole(file)).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('gives each slide of a .pptx in order', () => {
    const slide = (t: string) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const text = officeText(zip({ '[Content_Types].xml': '<Types/>', 'ppt/slides/slide10.xml': slide('Ten'), 'ppt/slides/slide2.xml': slide('Two &lt;b&gt;') }), '.pptx');
    expect(text).toBe('--- slide 2 of 2 ---\nTwo <b>\n\n--- slide 10 of 2 ---\nTen');
  });

  it('turns away a file that is not a zip', () => {
    expect(() => officeText(Buffer.from('not a zip at all, just text that goes on for a while'), '.docx')).toThrow(/not a zip/);
  });
});
