import { describe, expect, it } from 'vitest';
import { imageSlots, planImages, viewOf } from '../src/context/images';
import { recallTool } from '../src/tools/recall';
import type { Message, ToolCallPart } from '../src/types';
import type { ToolContext } from '../src/tools/types';

const pic = { type: 'image' as const, mediaType: 'image/png', data: 'iVBORw0KGgo=', blob: 'b1' };
let n = 0;
/** One tool round: the call and its result with a picture (or none). */
const round = (name: string, input: Record<string, unknown>, withPicture = true): Message[] => {
  const id = `c${++n}`;
  return [
    { id: `a${n}`, role: 'assistant', parts: [{ type: 'tool_call', id, name, input }] } as unknown as Message,
    { id: `u${n}`, role: 'user', parts: [{ type: 'tool_result', callId: id, name, content: `looked at ${JSON.stringify(input)}`, ...(withPicture ? { images: [{ ...pic }] } : {}) }] } as unknown as Message,
  ];
};
const ids = (m: Message[]) => m.flatMap((x) => x.parts).filter((p): p is ToolCallPart => p.type === 'tool_call').map((p) => p.id);

describe('pictures in a long session', () => {
  it('names a view by what it shows', () => {
    expect(viewOf({ type: 'tool_call', id: 'x', name: 'browser', input: { url: 'http://127.0.0.1:5173/', width: 390, height: 844 } })).toBe('page http://127.0.0.1:5173/ 390x844');
    expect(viewOf({ type: 'tool_call', id: 'x', name: 'read', input: { path: 'shots\\sheet.png' } })).toBe('file shots/sheet.png');
    // Favilla's read takes paths: two pictures are two views, and a region of one is another.
    expect(viewOf({ type: 'tool_call', id: 'x', name: 'read', input: { paths: ['ref.png'] } })).toBe('file ref.png');
    expect(viewOf({ type: 'tool_call', id: 'x', name: 'read', input: { paths: ['render.png'] } })).not.toBe(viewOf({ type: 'tool_call', id: 'y', name: 'read', input: { paths: ['ref.png'] } }));
    expect(viewOf({ type: 'tool_call', id: 'x', name: 'read', input: { paths: ['ref.png'], region: [0, 0, 100, 100] } })).not.toBe('file ref.png');
    expect(viewOf({ type: 'tool_call', id: 'x', name: 'paint', input: { canvas: 'fox' } })).toBe('canvas fox');
    expect(imageSlots(272_000)).toBe(8);
    expect(imageSlots(32_000)).toBe(4);
  });

  it('lets an older picture of the same view go once a newer one is in, and never the last round', () => {
    const first = round('browser', { url: 'http://x/', width: 1280, height: 800 });
    const second = round('browser', { url: 'http://x/', width: 1280, height: 800 });
    const phone = round('browser', { url: 'http://x/', width: 390, height: 844 });
    const drops = planImages([...first, ...second, ...phone], 0, 8);
    expect(drops.map((d) => d.callId)).toEqual(ids(first));
    expect(drops[0].caption).toContain('a newer picture of the same view came after it');
    expect(drops[0].caption).toContain(`recall with call_id ${ids(first)[0]}`);
    // The newest picture of a view stays, and so does the last round's.
    const only = round('browser', { url: 'http://x/', width: 1280, height: 800 });
    expect(planImages(only, 0, 8)).toEqual([]);
  });

  it('keeps at most the slots, letting the oldest go together down to six tenths', () => {
    const rounds = Array.from({ length: 10 }, (_, i) => round('read', { path: `frames/sheet-${i}.png` }));
    const drops = planImages(rounds.flat(), 0, 4);
    expect(drops.map((d) => d.callId)).toEqual(rounds.slice(0, 8).flatMap(ids));
    expect(drops[0].caption).toContain('older than the pictures kept');
  });

  it('leaves an old superseded picture for the next batch, so the cache does not break far back', () => {
    const early = round('browser', { url: 'http://x/', width: 1280, height: 800 });
    const work = Array.from({ length: 8 }, (_, i) => round('shell', { command: `go test ./pkg${i}` }, false));
    const later = round('browser', { url: 'http://x/', width: 1280, height: 800 });
    const tail = round('shell', { command: 'git status' }, false);
    expect(planImages([...early, ...work.flat(), ...later, ...tail], 0, 8)).toEqual([]);
  });

  it('recall brings a picture back from the blob store', async () => {
    const history = round('browser', { url: 'http://x/', width: 1280, height: 800 });
    const result = history[1].parts[0] as { images: { data: string }[] };
    result.images[0].data = '';
    const ctx = { history: () => history, blobs: { get: (id: string) => (id === 'b1' ? Buffer.from('png bytes') : null) }, outputChars: 10_000 } as unknown as ToolContext;
    const out = await recallTool.execute({ callId: ids(history)[0] }, ctx);
    expect(out.images?.[0].data).toBe(Buffer.from('png bytes').toString('base64'));
  });
});
