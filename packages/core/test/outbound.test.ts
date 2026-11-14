import { describe, expect, it } from 'vitest';
import { documentNote, keepPrivate, mailHold, outboundLeaks, visibleText } from '../src/tools/outbound';

// What a user found in made things (2026-11-02): an email that says it was written by an AI, internal numbers, the
// request pasted into the page, and an art direction's name shown as a page's heading.
describe('words for other people', () => {
  it('finds talk of being an AI, of instructions, Favilla ids and machine paths, in English and Chinese', () => {
    expect(outboundLeaks('Dear Ms Park,\nAs an AI, I cannot visit the flat.')).toEqual([expect.stringContaining('talk of being an AI')]);
    expect(outboundLeaks('您好，作为一个AI助手，我整理了以下内容。')[0]).toContain('talk of being an AI');
    expect(outboundLeaks('根据您的要求，这封信说明了漏水的情况。')[0]).toContain('talk of the request');
    expect(outboundLeaks('See s0mvz6o5s700d467cad7ac for details.')[0]).toContain("Favilla's own notes or ids");
    expect(outboundLeaks('The file is at C:\\Users\\me\\report.pdf')[0]).toContain('a path on this machine');
    expect(outboundLeaks('Hi Sam, the leak under the sink is back. Could someone come on Thursday?')).toEqual([]);
  });

  it("finds the request's own sentences and the names Favilla gave the work", () => {
    const cp = {};
    keepPrivate(cp, { asked: '帮我给房东写封邮件，说厨房水槽下面又漏水了，周四下午家里有人，别写得太凶。', names: ['The name as a monument'] });
    expect(outboundLeaks('房东您好：厨房水槽下面又漏水了，周四下午家里有人。', cp)).toEqual([]);
    expect(outboundLeaks('房东您好：说厨房水槽下面又漏水了，周四下午家里有人，别写得太凶。', cp)[0]).toContain("the request's own words");
    expect(outboundLeaks('<h1>The name as a monument</h1>', cp)[0]).toContain('the internal name "The name as a monument"');
  });

  it('reads only what a page shows, and says nothing for code files', () => {
    const page = '<!doctype html><!-- Three ideas: the request asked for a ramen page --><style>.a{}</style><h1>Hachi</h1><p>Eight seats.</p>';
    expect(visibleText(page).trim()).toBe('Hachi Eight seats.');
    expect(documentNote('index.html', page)).toBe('');
    expect(documentNote('index.html', '<p>As requested by the user, here is the menu.</p>')).toContain('words meant for the user alone');
    expect(documentNote('main.go', '// as requested by the user')).toBe('');
    // A project's notes may name its own paths; a page never should.
    expect(documentNote('NOTES.md', 'Build output goes to C:\\Projects\\app\\dist.')).toBe('');
    expect(documentNote('index.html', '<p>C:\\Users\\me\\site</p>')).toContain('a path on this machine');
  });

  it('holds an email that carries them once, and lets the same email through the second time', () => {
    const cp = {};
    expect(mailHold('Leak', 'Hi Sam, the sink leaks again.', cp)).toBeNull();
    const held = mailHold('Leak', 'As an AI assistant I wrote this for my user: the sink leaks again.', cp);
    expect(held).toContain('Not saved or sent yet');
    expect(held).toContain('talk of being an AI');
    expect(mailHold('Leak', 'As an AI assistant I wrote this for my user: the sink leaks again.', cp)).toBeNull();
  });
});
