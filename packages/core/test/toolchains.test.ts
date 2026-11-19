import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// Every process the probes would start is answered here, so the test sees what was started and how.
const started: { cmd: string; args: string[] }[] = [];
let finishNode!: () => void;
const nodeVersion = new Promise<void>((resolve) => { finishNode = resolve; });
vi.mock('../src/util/proc', async (original) => ({
  ...(await original<typeof import('../src/util/proc')>()),
  capture: async (cmd: string, args: string[]) => {
    started.push({ cmd, args });
    if (cmd === 'node') await nodeVersion;
    if (cmd === 'python' && args[0] === '-c') return { code: 0, stdout: 'docx PIL\n', stderr: '', timedOut: false };
    // Finish early probes last so completion order reverses PROBES order unless sorted canonically.
    const slow = cmd === 'node' || cmd === 'cmd.exe' || cmd === 'npm' || cmd === 'pnpm';
    await new Promise((r) => setTimeout(r, slow ? 45 : 4));
    if (cmd === 'git' && args[0] === 'rev-parse') return { code: 128, stdout: '', stderr: 'not a repository', timedOut: false };
    return { code: 0, stdout: '1.2.3\n', stderr: '', timedOut: false };
  },
}));

const { cachedDocumentToolchains, environmentSection, projectFacts } = await import('../src/prompt/env');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-toolchains-'));

beforeAll(() => {
  vi.stubEnv('FAVILLA_HOME', home);
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

it('probes the toolchains once when a session start asks for them twice at once', async () => {
  const shell = { label: 'test shell' } as Parameters<typeof environmentSection>[0]['shell'];
  const ready = Promise.all([environmentSection({ shell, modelName: 'm', contextWindow: 1000 }), projectFacts({ cwd: home })]);
  try {
    await vi.waitFor(() => expect(started.some((s) => s.cmd === 'python' && s.args[0] === '-c')).toBe(true));
  } finally {
    finishNode();
  }
  const [env] = await ready;
  expect(env).toContain('Python packages: python-docx, Pillow');
  const probes = started.filter((s) => !(s.cmd === 'git' && s.args[0] !== '--version'));
  const java = probes.filter((s) => s.cmd === 'java');
  expect(java).toHaveLength(1);
  // A small first heap: a plain -version commits a 64th of the machine's memory.
  expect(java[0].args).toEqual(['-Xms8m', '-XX:+UseSerialGC', '-version']);
  expect(probes.filter((s) => s.cmd === 'node')).toHaveLength(1);
  const npm = probes.filter((s) => /^npm(?:\.cmd)?$/.test(s.cmd) || /^npm\.cmd /.test(s.args.at(-1) ?? ''));
  expect(npm).toHaveLength(1);
  if (process.platform === 'win32') expect(npm[0]).toEqual({ cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd --version'] });
  expect(env).toMatch(/Installed: node 1\.2\.3, npm 1\.2\.3, pnpm 1\.2\.3.*pandoc 1\.2\.3/);
  // The next start reads the cache the probes wrote.
  const before = started.length;
  await environmentSection({ shell, modelName: 'm', contextWindow: 1000 });
  expect(started.length).toBe(before);

  // Even a previously cached file with scrambled object keys formats in canonical PROBES order.
  const cacheFile = path.join(home, 'cache', 'toolchains2.json');
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({
      at: Date.now(),
      versions: {
        pandoc: '3.1.0',
        ffmpeg: '7.0.1',
        ImageMagick: '7.1.1',
        exiftool: '12.99',
        rustc: '1.84.0',
        node: '24.0.0',
        'python packages': 'openpyxl, python-docx, Pillow',
      },
    }),
  );
  const fromScrambled = await environmentSection({ shell, modelName: 'm', contextWindow: 1000 });
  expect(fromScrambled).toContain('Installed: node 24.0.0, rustc 1.84.0, ffmpeg 7.0.1, ImageMagick 7.1.1, exiftool 12.99, pandoc 3.1.0');
  expect(fromScrambled).toContain('Python packages: openpyxl, python-docx, Pillow');

  const inCode = await environmentSection({ shell, modelName: 'm', contextWindow: 1000, code: true });
  expect(inCode).toContain('Installed: node 24.0.0, rustc 1.84.0');
  expect(inCode).not.toMatch(/ffmpeg|ImageMagick|exiftool|pandoc/);
  expect(inCode).not.toContain('Python packages:');

  expect(cachedDocumentToolchains()).toBe(
    'Installed document and media tools: ffmpeg 7.0.1, ImageMagick 7.1.1, exiftool 12.99, pandoc 3.1.0\nPython packages: openpyxl, python-docx, Pillow',
  );
});
