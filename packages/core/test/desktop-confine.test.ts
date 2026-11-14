import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FavillaConfig } from '../src/config/config';

// A confined run is an agent under test: it never gets the user's desktop, even when computer control is on.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-desk-confine-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(() => {
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', languageServers: false, computer: true, providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }),
  );
  rt = createRuntime(project, { interactive: true });
});

afterAll(async () => {
  rt.dispose();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe.skipIf(process.platform !== 'win32')('computer control in a confined run', () => {
  it.each([false, true])('is offered only outside confinement (confine %s)', async (confine) => {
    const s = await rt.start({ cwd: project, interactive: true });
    const access = s as unknown as { config: FavillaConfig; bindings: { spec: { name: string } }[]; rebuildTools(): void; computerOn: boolean };
    access.config.confine = confine;
    access.rebuildTools();
    expect(access.bindings.some((b) => b.spec.name === 'computer')).toBe(!confine);
    expect(access.computerOn).toBe(!confine);
  });
});
