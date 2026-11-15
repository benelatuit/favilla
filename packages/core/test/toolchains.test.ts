import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// Every process the probes would start is answered here, so the test sees what was started and how.
const started: { cmd: string; args: string[] }[] = [];
vi.mock('../src/util/proc', async (original) => ({
  ...(await original<typeof import('../src/util/proc')>()),
  capture: async (cmd: string, args: string[]) => {
    started.push({ cmd, args });
    // Finish early probes last so completion order reverses PROBES order unless sorted canonically.
    const slow = cmd === 'node' || cmd === 'cmd.exe' || cmd === 'npm' || cmd === 'pnpm';
    await new Promise((r) => setTimeout(r, slow ? 45 : 4));
    if (cmd === 'git' && args[0] === 'rev-parse') return { code: 128, stdout: '', stderr: 'not a repository', timedOut: false };
    return { code: 0, stdout: '1.2.3\n', stderr: '', timedOut: false };
  },
}));

const { environmentSection, projectFacts } = await import('../src/prompt/env');

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
  const [env] = await Promise.all([environmentSection({ shell, modelName: 'm', contextWindow: 1000 }), projectFacts({ cwd: home })]);
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
  fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), versions: { pandoc: '3.1.0', rustc: '1.84.0', node: '24.0.0' } }));
  const fromScrambled = await environmentSection({ shell, modelName: 'm', contextWindow: 1000 });
  expect(fromScrambled).toContain('Installed: node 24.0.0, rustc 1.84.0, pandoc 3.1.0');
});
