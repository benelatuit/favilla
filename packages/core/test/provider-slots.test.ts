import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// A provider on this computer is taken to answer one request at a time unless its settings say more. A proxy on
// 127.0.0.1 to a cloud service was made local by its address when it was added, and its sessions never had
// their summary written in the background (2026-11-05).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-slots-'));
process.env.FAVILLA_HOME = home;
const { Catalog } = await import('../src/catalog/catalog');

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('how many requests a provider answers at once', () => {
  it('one for a server on this computer, unless its settings say more; any number for the rest', () => {
    const catalog = new Catalog({
      providers: {
        llama: { name: 'llama', api: 'openai-chat', baseUrl: 'http://127.0.0.1:8090/v1', auth: 'none', local: true },
        relay: { name: 'relay', api: 'openai-chat', baseUrl: 'http://127.0.0.1:8787/v1', auth: 'none', local: true, slots: 4 },
        single: { name: 'single', api: 'openai-chat', baseUrl: 'http://127.0.0.1:8091/v1', auth: 'none', local: true, slots: 1 },
        cloud: { name: 'cloud', api: 'openai-chat', baseUrl: 'https://llm.example.com/v1', apiKey: 'k' },
      },
    } as ConstructorParameters<typeof Catalog>[0]);
    expect(catalog.provider('llama').serial).toBe(true);
    expect(catalog.provider('relay').serial).toBe(false);
    expect(catalog.provider('single').serial).toBe(true);
    expect(catalog.provider('cloud').serial).toBe(false);
    // Still local: connected to directly, never through a proxy.
    expect(catalog.provider('relay').local).toBe(true);
    expect(catalog.provider('relay').proxy).toBe(false);
  });
});
