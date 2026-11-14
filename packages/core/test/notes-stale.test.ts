import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { missingFiles } from '../src/prompt/system';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-notes-'));
fs.mkdirSync(path.join(dir, 'src', 'net'), { recursive: true });
fs.writeFileSync(path.join(dir, 'src', 'net', 'client.ts'), '');

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('a project note that names a file which is gone', () => {
  it('is told apart from one whose files are there, and from commands and links', () => {
    expect(missingFiles('The API client lives in src/net/client.ts.', dir)).toEqual([]);
    expect(missingFiles('Build with `scripts/build.sh` before the tests.', dir)).toEqual(['scripts/build.sh']);
    expect(missingFiles('Fixtures are in tests/unit/fixtures.json, the client in `src/net/client.ts`.', dir)).toEqual(['tests/unit/fixtures.json']);
    expect(missingFiles('Run `npm test`; docs at https://example.com/a/b.html.', dir)).toEqual([]);
    expect(missingFiles('Config is read from `config.json` in the home folder.', dir)).toEqual([]);
    expect(missingFiles('Never touch ../outside/thing.ts.', dir)).toEqual([]);
  });
});
