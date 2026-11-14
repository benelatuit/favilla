import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asksForRedesign, asksForWorkScreen } from '../src/agent/turn-checks';
import { dealAppStyles, dealDirections } from '../src/prompt/system';

const names = (note: string) => [...note.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

describe('art directions', () => {
  it('deals one direction, the same one for the same seed', () => {
    const note = dealDirections('session-a');
    expect(names(note)).toHaveLength(1);
    expect(dealDirections('session-a')).toEqual(note);
    expect(note).not.toContain('{{directions}}');
  });

  it('gives each direction a palette and faces, and never the cream ground a model picks by itself', () => {
    for (let i = 0; i < 40; i++) {
      const note = dealDirections(`seed-${i}`);
      expect(note.match(/^Palette "/gm)).toHaveLength(1);
      expect(note.match(/^Faces: .*from Google Fonts/gm)).toHaveLength(1);
      for (const m of note.matchAll(/ground #(..)(..)(..)/g)) {
        const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
        expect(r > 225 && g > 215 && b > 190 && r >= g && g >= b && r - b > 6 && r - b < 45, m[0]).toBe(false);
      }
    }
  });

  it('deals across the library, so pages do not all get the same three', () => {
    const seen = new Set(Array.from({ length: 80 }, (_, i) => names(dealDirections(`seed-${i}`))).flat());
    expect(seen.size).toBeGreaterThan(14);
    // Green is a quarter of the library's accents; drawn by hue family first it comes up about one time in eight.
    const greens = Array.from({ length: 200 }, (_, i) => /accent #([0-9a-f]{6})/i.exec(dealDirections(`hue-${i}`))![1]).filter((hex) => {
      const [r, g, b] = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
      return g > r + 20 && g > b + 20;
    }).length;
    expect(greens).toBeLessThan(45);
  });

  it('draws the palette from the kinds its direction names, and none that sets many colours side by side', () => {
    const library = <T>(name: string): T[] => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'design', `${name}.json`), 'utf8'));
    const directions = library<{ name: string; paletteTags: string[] }>('directions');
    const palettes = library<{ name: string; tags: string[]; note: string }>('palettes');
    for (const p of palettes) {
      expect(p.tags, p.name).not.toContain('flat-loud');
      expect(p.tags, p.name).not.toContain('pastel-fields');
      expect(p.note, p.name).not.toMatch(/alternat/i);
    }
    for (let i = 0; i < 120; i++) {
      const note = dealDirections(`fit-${i}`);
      const d = directions.find((x) => x.name === names(note)[0])!;
      const p = palettes.find((x) => x.name === /^Palette "([^"]+)"/m.exec(note)![1])!;
      expect(p.tags.some((t) => d.paletteTags.includes(t)), `${d.name} with ${p.name}`).toBe(true);
    }
  });

  it('gives a screen people work in two app styles with their tokens', () => {
    const note = dealAppStyles('session-b');
    expect(names(note).length).toBe(2);
    expect(note.match(/^Tokens: \{/gm)).toHaveLength(2);
    expect(note).not.toContain('{{styles}}');
  });

  it('tells a screen people work in from a page that persuades', () => {
    for (const yes of ['Build a dashboard for our deploys', 'make an inbox for the support team', '做一个后台管理系统', '写一个音乐播放器']) expect(asksForWorkScreen(yes), yes).toBe(true);
    for (const no of ['Build a landing page for our app', 'a portfolio website', '做一个官网首页', 'make a game about cats']) expect(asksForWorkScreen(no), no).toBe(false);
    // Things people use, in plain words: none of them is a page to be art-directed.
    for (const yes of ['The expense-claims screen of a 40-person company', 'make a mortgage calculator', 'a pomodoro timer', 'Build the sign-in and checkout', '做一个记账的页面', '写一个番茄钟', '做个登录界面', '做一个图书借阅系统']) expect(asksForWorkScreen(yes), yes).toBe(true);
    for (const no of ['A site for a night food market', '做一个在线教育平台的官网', 'the landing page of our calendar app', 'A page for a six-week course in letterpress printing']) expect(asksForWorkScreen(no), no).toBe(false);
  });

  it('knows a request to change how something looks from other work', () => {
    for (const yes of ['Redesign the settings page', 'this page looks generic', '这个页面太丑了，重新设计一下', '帮我改版首页', 'make it look better']) expect(asksForRedesign(yes), yes).toBe(true);
    for (const no of ['Fix the login redirect', 'add a retry to the upload', '修复页面报错', 'rename the design module']) expect(asksForRedesign(no), no).toBe(false);
  });
});
