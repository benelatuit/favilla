import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserSession, findBrowser } from '../src/tools/browser';
import { filmTool } from '../src/tools/film';

const exe = findBrowser();
const ffmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

describe('a film rendered from a page', () => {
  it.skipIf(!exe || !ffmpeg)('draws every frame from seek(t), previews a sheet and encodes the video', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-film-'));
    process.env.FAVILLA_HOME = path.join(dir, 'home');
    const browser = new BrowserSession(exe!, false, {});
    try {
      fs.writeFileSync(
        path.join(dir, 'anim.html'),
        `<!doctype html><html><body style="margin:0"><canvas id="c" width="160" height="96"></canvas><script>
const g = document.getElementById('c').getContext('2d');
window.duration = 0.5;
window.ready = Promise.resolve();
window.seek = (t) => { g.fillStyle = '#eee'; g.fillRect(0, 0, 160, 96); g.fillStyle = '#c33'; g.fillRect(10 + 200 * t, 30, 30, 30); };
</script></body></html>`,
      );
      fs.writeFileSync(path.join(dir, 'blank.html'), '<!doctype html><html><body>nothing</body></html>');
      const ctx = { cwd: dir, model: { vision: true }, browser: () => browser, files: { recordWrite() {} }, checkpoints: { capture() {} }, turn: 't', progress() {} } as never;
      const missing = await filmTool.execute({ page: 'blank.html', size: [160, 96], fps: 12 }, ctx);
      expect(missing.isError).toBe(true);
      expect(missing.content).toMatch(/defines no seek\(t\)/);
      const sheet = await filmTool.execute({ page: 'anim.html', size: [160, 96], fps: 12, preview: true }, ctx);
      expect(sheet.isError).toBeFalsy();
      expect(sheet.images?.length).toBe(1);
      const made = await filmTool.execute({ page: 'anim.html', size: [160, 96], fps: 12 }, ctx);
      expect(made.isError, made.content).toBeFalsy();
      expect(made.content).toMatch(/Rendered anim\.mp4: 6 frames, 160x96 at 12 fps/);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', path.join(dir, 'anim.mp4')], { windowsHide: true });
      // Width, height and the frames decoded, whatever ffprobe puts around them.
      expect(probe.stdout.toString().replace(/[^0-9,]/g, '')).toContain('160,96,6');
    } finally {
      browser.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});
