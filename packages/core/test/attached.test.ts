import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ATTACHED, attach, attachedPart, pastedBlock, typedPart } from '../src/prompt/attached';
import { expandMentions } from '../src/prompt/mentions';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-attached-'));
fs.writeFileSync(path.join(dir, 'notes.txt'), 'first\nsecond\n');
fs.writeFileSync(path.join(dir, 'other.txt'), 'never asked for\n');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('what a user attached', () => {
  it('goes after their words under one line, however many times something is added', () => {
    const once = attach('look at this', ['<a>']);
    expect(once).toBe(`look at this${ATTACHED}<a>`);
    expect(attach(once, ['<b>'])).toBe(`look at this${ATTACHED}<a>\n\n<b>`);
    expect(attach('nothing', [])).toBe('nothing');
    expect(typedPart(once)).toBe('look at this');
    expect(attachedPart(once)).toBe('<a>');
    expect(attachedPart('nothing')).toBe('');
  });

  it('keeps everything after the words, though a paste holds the attachment line itself', () => {
    const paste = pastedBlock(`a log${ATTACHED}that quotes a message`, 1);
    const text = attach('why?', [paste, '<file path="x">\n1\tone\n</file>']);
    expect(typedPart(text)).toBe('why?');
    expect(attachedPart(text)).toBe(`${paste}\n\n<file path="x">\n1\tone\n</file>`);
  });

  it('counts the lines of a paste in its tag', () => {
    expect(pastedBlock('one\ntwo\nthree', 2)).toBe('<pasted name="Pasted text 2" lines="3">\none\ntwo\nthree\n</pasted>');
  });
});

describe('a file named with @', () => {
  it('is attached when the user typed its name, and joins what is already attached', () => {
    const sent = attach('compare @notes.txt with [Pasted text 1]', [pastedBlock('pasted line', 1)]);
    const out = expandMentions(sent, dir);
    expect(out.files).toEqual(['notes.txt']);
    expect(out.text.split(ATTACHED)).toHaveLength(2);
    expect(typedPart(out.text)).toBe('compare @notes.txt with [Pasted text 1]');
    expect(attachedPart(out.text)).toContain(pastedBlock('pasted line', 1));
    expect(attachedPart(out.text)).toContain('<file path="notes.txt">');
  });

  it('is not attached for an @ inside something pasted', () => {
    const sent = attach('what does this log say?', [pastedBlock('mail from @other.txt arrived', 1)]);
    const out = expandMentions(sent, dir);
    expect(out.files).toEqual([]);
    expect(out.text).toBe(sent);
  });
});
