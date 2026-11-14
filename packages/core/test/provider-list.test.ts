import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

// The provider list asked for a provider's discovery cache again for every model, three times over: with the file
// missing and 1,000 models configured that was 3,004 reads for one request (105 ms, 2026-11-11). One look a
// provider now; what the list says must be what the separate questions said.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-provider-list-'));
process.env.FAVILLA_HOME = home;
const { Catalog } = await import('../src/catalog/catalog');

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const relay = { api: 'openai-chat' as const, baseUrl: 'https://relay.example.net/v1', auth: 'none' as const, discover: false as const };
const models = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`model-${i}`, { contextWindow: 64000 + i }]));
const cacheReads = (run: () => void) => {
  const spy = vi.spyOn(fs, 'readFileSync');
  try {
    run();
    return spy.mock.calls.filter(([file]) => typeof file === 'string' && path.basename(file) === 'models-relay.json').length;
  } finally {
    spy.mockRestore();
  }
};

it('looks at a missing discovery cache once for the whole list of a provider', () => {
  const catalog = new Catalog({ providers: { relay: { ...relay, models } } });
  const p = catalog.provider('relay');
  let listing!: ReturnType<typeof catalog.providerListing>;
  expect(cacheReads(() => (listing = catalog.providerListing(p)))).toBe(1);
  expect(listing.models).toHaveLength(1000);
  expect(listing).toEqual({ configured: catalog.isConfigured(p), models: catalog.models('relay'), error: catalog.discoveryError('relay') });
});

it('says what the cache says once the file is there, and keeps the parsed file', () => {
  const catalog = new Catalog({ providers: { relay: { ...relay, models: { 'model-0': {} } } } });
  const p = catalog.provider('relay');
  fs.mkdirSync(path.join(home, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cache', 'models-relay.json'), JSON.stringify({ fetched: Date.now(), models: [{ id: 'found-1' }, { id: 'found-2' }] }));
  let listing!: ReturnType<typeof catalog.providerListing>;
  expect(cacheReads(() => (listing = catalog.providerListing(p)))).toBe(1);
  expect(listing.models.map((m) => m.id).sort()).toEqual(['found-1', 'found-2', 'model-0']);
  expect(listing).toEqual({ configured: catalog.isConfigured(p), models: catalog.models('relay'), error: catalog.discoveryError('relay') });
  expect(cacheReads(() => catalog.providerListing(p))).toBe(0);
});
