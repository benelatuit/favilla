import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { projectConfigPath } from '../src/config/config';
import { FORMER_NAME } from '../src/former-name';
import { appHome, homePath, isWindows, oldVariableNames, resolvePath, toForward } from '../src/util/paths';

describe('paths the model writes', () => {
  it.runIf(isWindows)('reads Git Bash paths as Git Bash means them, /tmp included', () => {
    expect(resolvePath('C:\\work', '/c/Users/x/a.txt')).toBe('C:\\Users\\x\\a.txt');
    expect(resolvePath('C:\\work', '/tmp/x.py')).toBe(path.join(os.tmpdir(), 'x.py'));
    expect(resolvePath('C:\\work', '/tmp')).toBe(path.resolve(os.tmpdir()));
    expect(resolvePath('C:\\work', '/tmpfile')).not.toContain(os.tmpdir());
  });
});

describe('the data folder and the project settings folder', () => {
  it('are FAVILLA_HOME, else ~/.favilla, and .favilla in a project, whatever else is beside them', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-paths-'));
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    vi.stubEnv('FAVILLA_HOME', undefined);
    try {
      expect(appHome()).toBe(path.join(tmp, '.favilla'));
      // A folder under another name is never read, whether or not the app's own exists: two candidates were how a
      // folder a test run made took over from the user's own.
      fs.mkdirSync(path.join(tmp, `.${FORMER_NAME ?? 'older'}`));
      expect(appHome()).toBe(path.join(tmp, '.favilla'));
      fs.mkdirSync(path.join(tmp, '.favilla'));
      expect(appHome()).toBe(path.join(tmp, '.favilla'));

      vi.stubEnv('FAVILLA_HOME', path.join(tmp, 'elsewhere'));
      expect(appHome()).toBe(path.join(tmp, 'elsewhere'));

      const proj = path.join(tmp, 'proj');
      fs.mkdirSync(path.join(proj, `.${FORMER_NAME ?? 'older'}`), { recursive: true });
      fs.writeFileSync(path.join(proj, `.${FORMER_NAME ?? 'older'}`, 'config.json'), '{}');
      expect(projectConfigPath(proj)).toBe(path.join(proj, '.favilla', 'config.json'));
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.runIf(FORMER_NAME)('names the variables still set under the former name, which the app refuses to start with', () => {
    const former = FORMER_NAME!.toUpperCase();
    expect(oldVariableNames({ FAVILLA_HOME: 'x', PATH: 'y' })).toEqual([]);
    expect(oldVariableNames({ [`${former}_HOME`]: 'x', [`${former}_CONFINE`]: '1', FAVILLA_HOME: 'y', [`${former}R`]: 'z' })).toEqual([`${former}_HOME`, `${former}_CONFINE`]);
  });
});

describe('folders as a person reads them', () => {
  it('writes a folder under the home as ~ and leaves any other as it is', () => {
    const home = path.join(os.tmpdir(), 'someone');
    expect(homePath(path.join(home, 'code', 'ledger-api'), home)).toBe('~/code/ledger-api');
    expect(homePath(home, home)).toBe('~');
    expect(homePath(`${home}-else`, home)).toBe(toForward(`${home}-else`));
  });
});
