import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// Windows refuses to open a file for the moment another process replaces it. A settings read that failed there gave
// an empty configuration: a folder opened then kept no providers, and its sessions said "Unknown model" for a model
// its provider serves, until the settings file changed again.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-config-busy-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
const other = path.join(home, 'other');
for (const dir of [process.env.FAVILLA_HOME, project, other]) fs.mkdirSync(dir);
const configFile = path.join(process.env.FAVILLA_HOME, 'config.json');
fs.writeFileSync(
  configFile,
  JSON.stringify({
    model: 'relay/m1',
    modelRegistry: false,
    languageServers: false,
    providers: { relay: { api: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', auth: 'none', local: true, discover: false, models: { m1: {}, 'swe-max': {} } } },
  }),
);

const { loadConfig } = await import('../src/config/config');
const { createRuntime } = await import('../src/runtime');
const real = fs.readFileSync;
const busy = (times: number) => {
  let left = times;
  return vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (path.resolve(String(file)) === path.resolve(configFile) && left-- > 0) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return (real as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync);
};

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a settings file being replaced', () => {
  it('is read again a moment later', () => {
    busy(3);
    expect(Object.keys(loadConfig(project, { report: () => {} }).providers ?? {})).toEqual(['relay']);
  });

  it('that stays unreadable leaves the settings as last read, not empty', () => {
    loadConfig(project, { report: () => {} });
    const notices: unknown[] = [];
    busy(Infinity);
    expect(Object.keys(loadConfig(other, { report: (n) => notices.push(n) }).providers ?? {})).toEqual(['relay']);
    expect(notices).toHaveLength(1);
  });

  it('while a folder is first opened still finds the folder’s models', async () => {
    const rt = createRuntime(project, { interactive: false });
    try {
      busy(Infinity);
      const s = await rt.start({ cwd: other, model: 'relay/swe-max' });
      expect(s.meta.model).toBe('swe-max');
    } finally {
      vi.restoreAllMocks();
      rt.dispose();
    }
  });
});
