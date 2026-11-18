import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserSession, findBrowser } from '../src/tools/browser';
import { buildTools, type ProfileContext } from '../src/tools/profiles';
import type { Point } from '../src/tools/stroke';
import type { ToolContext } from '../src/tools/types';

const exe = findBrowser();
const fixture = new URL('fixtures/stroke-pad.html', import.meta.url);
const anchors: Point[] = [[32, 100], [96, 36], [160, 100]];
const binding = buildTools('favilla', { role: 'main', screenshot: true, shell: { kind: 'bash' } } as ProfileContext).find(b => b.spec.name === 'browser')!;

describe.runIf(!!exe)('mouse strokes on a local canvas', () => {
  const browser = new BrowserSession(exe!, false, { visible: false });
  const ctx = { browser: () => browser, cwd: fileURLToPath(new URL('.', fixture)), model: { vision: true }, signal: new AbortController().signal } as unknown as ToolContext;
  const run = (input: Record<string, unknown>, signal = ctx.signal) => binding.def.execute(binding.normalize(input), { ...ctx, signal });
  const open = async (brush: string, scale = 1) => {
    const result = await run({ url: `${fixture.href}?brush=${brush}`, width: 1280, height: 800, scale });
    expect(result.isError, result.content).toBeFalsy();
  };
  beforeAll(() => browser.start(), 30_000);
  afterAll(() => browser.close());

  it('checks its own headless browser and clicks at main screenshot pixels without a DOM target', async () => {
    await browser.verifyPrivateHeadless();
    await open('pointer', 2);
    await browser.act({ click: [112, 86] });
    expect(await browser.evaluate('strokes.map(s => s.start)')).toEqual([[56, 43]]);
    for (const point of [[2560, 0], [-1, 0], [0, Infinity], [2], [1, 2, 3]])
      await expect(browser.act({ click: point as Point })).rejects.toThrow(/inside the main screenshot/);
    expect(await browser.evaluate('strokes.length')).toBe(1);
  });

  it.each([['mouse', 1], ['pointer', 2]] as const)('leaves a smooth arc on the %s-only pad and lifts between marks', async (brush, scale) => {
    await open(brush, scale);
    const coords = (p: Point[]) => p.map(([x, y]) => [x * scale, y * scale]);
    const result = await run({ actions: [
      { stroke: coords(anchors) },
      { stroke: coords([[192, 100], [210, 116]]) },
      { zoom: [32, 36, 128, 64].map(v => v * scale) },
    ] });
    expect(result.isError, result.content).toBeFalsy();
    expect(await browser.evaluate('strokes.map(s => [s.start, s.end])')).toEqual([[anchors[0], anchors[2]], [[192, 100], [210, 116]]]);
    expect(await browser.evaluate('strokes[0].moves.length')).toBeGreaterThan(3);
    if (brush === 'pointer') expect(await browser.evaluate('strokes[0].tool')).toBe('mouse');
    // The curve passes through both shoulders at y=60. The chords and the gap between strokes stay blank.
    expect(await browser.evaluate('[[32,100],[64,60],[96,36],[128,60],[160,100],[202,109]].every(([x,y]) => alpha(x,y) > 180)')).toBe(true);
    expect(await browser.evaluate('[[64,68],[128,68],[176,100]].map(([x,y]) => alpha(x,y))')).toEqual([0, 0, 0]);
    expect(result.images?.map(pic => pic.name)).toEqual(['page.png', 'zoom [32, 36, 128, 64]']);
    // Inspect the returned PNGs too: the same shoulder and empty chord in the overview and its 3x crop.
    for (const [i, pic] of result.images!.entries()) {
      const [ink, paper] = await browser.evaluate<number[]>(`(async () => {
        const img = new Image(); img.src = 'data:image/png;base64,${pic.data}'; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        return ${i ? '[[96,72],[96,96]]' : '[[64,60],[64,68]]'}.map(([x,y]) => g.getImageData(x,y,1,1).data[0]);
      })()`);
      expect(ink).toBeLessThan(75); // The screenshot can antialias the edge of a canvas pixel.
      expect(paper).toBe(255);
    }
  });

  it('gives a velocity brush a wider slow stroke on the same path', async () => {
    await open('speed');
    const result = await run({ actions: [
      { stroke: [[40, 50], [220, 50]], ms: 80 },
      { stroke: [[40, 100], [220, 100]], ms: 1400 },
    ] });
    expect(result.isError, result.content).toBeFalsy();
    const [fast, slow] = await browser.evaluate<number[]>(`[50,100].map(y => {
      const lines = [80,100,120,140,160,180].map(x => {
        let width = 0;
        for (let dy = -12; dy <= 12; dy++) if (alpha(x, y + dy) > 127) width++;
        return width;
      });
      return lines.sort((a,b) => a-b)[3];
    })`);
    expect(fast).toBeGreaterThan(0);
    expect(slow).toBeGreaterThan(fast + 3);
    expect(await browser.evaluate('alpha(120,75)')).toBe(0);
  });

  it('acknowledges an intermediate batch without inspecting, and shows a partial failure without replay', async () => {
    await open('pointer');
    const snapshot = vi.spyOn(browser, 'snapshot'), shot = vi.spyOn(browser, 'capture');
    try {
      const actions = [{ stroke: anchors }, { click: [240, 124] }];
      const incompatible = await run({ actions, observe: false, scale: 2 });
      expect(incompatible.content).toContain('No actions were sent');
      expect(await browser.evaluate('strokes.length')).toBe(0);
      const ack = await run({ actions, observe: false });
      expect(ack.content).toContain('Acknowledged 2');
      expect(ack.images).toBeUndefined();
      expect(snapshot).not.toHaveBeenCalled();
      expect(shot).not.toHaveBeenCalled();
      const failed = await run({ actions: [{ stroke: anchors }, { click: [-4, 8] }], observe: false });
      expect(failed.isError).toBe(true);
      expect(failed.content).toContain('Done: drew a stroke.');
      expect(failed.images).toHaveLength(1);
      shot.mockRejectedValueOnce(new Error('readback unavailable'));
      expect((await run({ actions: [{ stroke: anchors }] })).content).toContain('before repeating');
      expect((await run({})).images).toHaveLength(1);
      expect(await browser.evaluate('strokes.length')).toBe(4);
    } finally { snapshot.mockRestore(); shot.mockRestore(); }
  });

  it('releases a cancelled stroke without finishing it or starting the next one', async () => {
    await open('pointer');
    const controller = new AbortController();
    const work = run({ actions: [{ stroke: anchors, ms: 1800 }, { stroke: anchors }] }, controller.signal)
      .then(() => 'finished', (e: Error) => e.name);
    try {
      await vi.waitFor(async () => expect(await browser.evaluate('strokes[0]?.moves.length > 0')).toBe(true));
    } finally {
      controller.abort();
    }
    expect(await work).toBe('AbortError');
    expect(await browser.evaluate('strokes.length')).toBe(1);
    expect(await browser.evaluate('strokes[0].end')).toEqual(await browser.evaluate('strokes[0].moves.at(-1)'));
    expect(await browser.evaluate('alpha(160,100)')).toBe(0);
  });

  it('draws 50 separate three-point marks in one tool call with one screenshot', async () => {
    await open('mouse');
    const actions = Array.from({ length: 50 }, (_, i) => {
      const x = 16 + i % 10 * 62, y = 28 + Math.floor(i / 10) * 56;
      return { stroke: [[x, y + 12], [x + 18, y - 6], [x + 36, y + 12]] };
    });
    const start = performance.now();
    const result = await run({ actions });
    const elapsed = Math.round(performance.now() - start);
    expect(result.isError, result.content).toBeFalsy();
    expect(result.images).toHaveLength(1);
    expect(await browser.evaluate('strokes.filter(s => s.end).length')).toBe(50);
    expect(await browser.evaluate(`${JSON.stringify(actions)}.every(({stroke}) => stroke.every(([x,y]) => alpha(x,y) > 180) && !alpha(stroke[0][0]+18,stroke[0][1]))`)).toBe(true);
    const moves = await browser.evaluate('strokes.reduce((n,s) => n+s.moves.length,0)');
    console.info(`50 strokes, ${moves} held moves, ${elapsed} ms including the final screenshot`);
  }, 60_000);
});
