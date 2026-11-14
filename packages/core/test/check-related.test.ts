import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { relatedCommand } from '../src/tools/check';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-related-'));

describe('check, related tests only', () => {
  it('pytest: the test files named after a changed module or importing it', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'pkg'));
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'pkg', 'calc.py'), 'def add(a, b):\n    return a + b\n');
    fs.writeFileSync(path.join(root, 'tests', 'test_math.py'), 'from pkg.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n');
    fs.writeFileSync(path.join(root, 'tests', 'test_calc.py'), 'def test_nothing():\n    pass\n');
    fs.writeFileSync(path.join(root, 'tests', 'test_other.py'), 'import json\n\ndef test_json():\n    assert json.dumps(1) == "1"\n');
    const r = relatedCommand({ name: 'test', command: 'python -m pytest -q', runner: 'pytest' }, root, [path.join(root, 'pkg', 'calc.py')]);
    expect(r?.command).toMatch(/^python -m pytest -q /);
    expect(r?.command).toContain('"tests/test_math.py"');
    expect(r?.command).toContain('"tests/test_calc.py"');
    expect(r?.command).not.toContain('test_other');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('go: the changed packages; vitest and jest: their own related modes; others: none', () => {
    const root = path.resolve('/work/app');
    expect(relatedCommand({ name: 'test', command: 'go test ./...', runner: 'go' }, root, [path.join(root, 'store', 'db.go'), path.join(root, 'store', 'cache.go')])?.command).toBe('go test ./store');
    expect(relatedCommand({ name: 'test', command: 'npm run --silent test', runner: 'vitest' }, root, [path.join(root, 'src', 'a.ts')])?.command).toBe('npx --no-install vitest related --run "src/a.ts"');
    expect(relatedCommand({ name: 'test', command: 'npm run --silent test', runner: 'jest' }, root, [path.join(root, 'src', 'a.ts')])?.command).toBe('npx --no-install jest --findRelatedTests "src/a.ts" --passWithNoTests');
    expect(relatedCommand({ name: 'test', command: 'cargo test --quiet', runner: 'cargo' }, root, [path.join(root, 'src', 'lib.rs')])).toBeNull();
    expect(relatedCommand({ name: 'types', command: 'npx tsc --noEmit' }, root, [path.join(root, 'src', 'a.ts')])).toBeNull();
  });
});
