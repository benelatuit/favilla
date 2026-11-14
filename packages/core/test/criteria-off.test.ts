import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// FAVILLA_GOAL=off, for benchmarks that measure what the criteria tool is worth.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-criteria-off-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project);

describe('FAVILLA_GOAL=off', () => {
  it('takes the criteria tool and every meets away', async () => {
    const { buildTools } = await import('../src/tools/profiles');
    const { DEFAULTS } = await import('../src/config/config');
    const pc = { role: 'main', cwd: project, config: { ...DEFAULTS }, shell: { label: 'bash' }, timeoutMs: 120000 } as never;
    const names = (list: { spec: { name: string; description: string; parameters: unknown } }[]) => list.map((t) => t.spec.name);
    const on = buildTools('favilla', pc);
    expect(names(on)).toContain('criteria');
    process.env.FAVILLA_GOAL = 'off';
    try {
      const off = buildTools('favilla', pc);
      expect(names(off)).not.toContain('criteria');
      for (const t of off) {
        expect(JSON.stringify(t.spec.parameters)).not.toContain('"meets"');
        expect(t.spec.description).not.toContain('meets:');
      }
    } finally {
      delete process.env.FAVILLA_GOAL;
    }
  });
});
