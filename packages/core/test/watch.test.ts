import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { judge, parseCuts, watchTool } from '../src/tools/watch';

const probe = { width: 1920, height: 1080, fps: 24, duration: 10, audio: true, start: 0 };
/** Frames of a film: `diff` per frame from a function of time; repeated where it is zero. */
const film = (seconds: number, diff: (t: number, i: number) => number, fastest: (t: number) => number = () => 0) =>
  Array.from({ length: seconds * 24 }, (_, i) => {
    const t = i / 24;
    const d = i ? diff(t, i) : 0;
    return { t, diff: d, repeated: i > 0 && d === 0, fastest: d ? fastest(t) : 0, tile: 10, pan: 0, tiles: new Float32Array(32).fill(d), second: undefined };
  });

describe('watching a film', () => {
  it('reads a cut list in either form', () => {
    const c = parseCuts('fps: 24\nsize: [1920, 1080]\nshots: [0, {at: 4}, 9.5]\nhits:\n  - 4\n  - {at: 6.25, what: the door}\nholds: [[7, 8], {from: 9, to: 9.4}]\n');
    expect(c).toEqual({ fps: 24, size: [1920, 1080], shots: [0, 4, 9.5], hits: [{ at: 4, what: undefined }, { at: 6.25, what: 'the door' }], holds: [[7, 8], [9, 9.4]] });
    expect(() => parseCuts('just words')).toThrow(/cut list/);
  });

  it('names a freeze, a pop, a stretch of nothing, a move too fast and a late hit', () => {
    const frames = film(
      10,
      (t) => (t >= 2 && t < 3.5 ? 0 : t >= 4.99 && t < 5.01 ? 30 : t >= 6 && t < 9 ? 0.1 : 1),
      (t) => (t > 8.9 && t < 9.6 ? 40 : 4),
    );
    const cuts = parseCuts('shots: [0, 4]\nhits: [{at: 4, what: the cut}, {at: 9.8, what: the door}]\nholds: []');
    const heard = [
      { t: 4.01, rise: 9 },
      { t: 10.0, rise: 8 },
    ];
    const r = judge(probe, frames, cuts, heard);
    const text = r.flags.join('\n');
    expect(text).toMatch(/Frozen 1\.9\d s to 3\.4\d s/);
    expect(text).toMatch(/A jump at 5\.00 s .* where the cut list has no cut/);
    expect(text).toMatch(/The cut list starts a shot at 4\.00 s, but the picture does not change there/);
    expect(text).toMatch(/Almost nothing moves from 6\.\d+ s to 8\.9\d s/);
    expect(text).toMatch(/something moves up to 40 px a frame/);
    expect(text).toMatch(/The sound hits 200 ms after the picture at 9\.8\d* s \(the door\)/);
    expect(text).not.toMatch(/at 4\.00 s \(the cut\)/);
    // A hold in the cut list is stillness meant as such.
    const held = judge(probe, frames, parseCuts('shots: [0, 5]\nhits: []\nholds: [[1.9, 3.6], [5.9, 9.1]]'), heard);
    expect(held.flags.join('\n')).not.toMatch(/Frozen|Almost nothing moves/);
  });

  it('tells a film made at half the rate', () => {
    const r = judge(probe, film(4, (_t, i) => (i % 2 ? 2 : 0)), undefined, null);
    expect(r.flags.join('\n')).toMatch(/Every other frame repeats the one before: the whole film moves at 12 pictures a second/);
  });

  const ffmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
  it.skipIf(!ffmpeg)('watches a rendered video end to end: a frozen ending and a beep on its hit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-watch-'));
    process.env.FAVILLA_HOME = path.join(dir, 'home');
    try {
      const video = path.join(dir, 'clip.mp4');
      const made = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.15', '-filter_complex', '[0:v]tpad=stop_mode=clone:stop_duration=2[v];[1:a]adelay=1000|1000,apad=whole_dur=5[a]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video],
        { windowsHide: true },
      );
      expect(made.status).toBe(0);
      fs.writeFileSync(path.join(dir, 'cuts.yaml'), 'fps: 24\nsize: [480, 270]\nshots: [0]\nhits: [{at: 1.0, what: the beep}]\nholds: []\n');
      const out = await watchTool.execute({ path: video, cuts: path.join(dir, 'cuts.yaml') }, { cwd: dir, model: { vision: true } } as never);
      expect(out.isError).toBeFalsy();
      expect(out.content).toMatch(/480×270, 24 fps/);
      // The encoder still refines the held picture for a few frames, so the freeze shows a little after it starts.
      expect(out.content).toMatch(/Frozen 3\.\d+ s to 4\.9\d s/);
      expect(out.content).toMatch(/Almost nothing moves from 3\.0\d s/);
      // A counter that changes once a second is new content, not a slow move in hops.
      expect(out.content).not.toMatch(/advance in hops/);
      expect(out.content).not.toMatch(/the beep\): more than/);
      expect(out.content).toMatch(/Hits: the sound's accents [+-]\d+ ms/);
      expect(out.images?.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);
});
