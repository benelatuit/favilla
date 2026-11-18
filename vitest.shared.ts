import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One data folder for the run, made fresh and removed at the end, so no test reaches the user's own ~/.favilla. The
 * tests ran with the user's folder whenever a file did not set FAVILLA_HOME itself, and from a package's own folder
 * they ran without these settings at all: such a run made the ~/.favilla that took over from the user's data
 * (2026-11-13). Each package's vitest.config.ts takes the same settings, so a run from any folder gets them.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-tests-'));
process.once('exit', () => fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }));

export const testSettings = {
  // Many tests start shells and browsers: one worker per core made them time out by turns, and took longer than five.
  testTimeout: 20_000,
  maxWorkers: 5,
  setupFiles: [path.join(import.meta.dirname, 'packages/core/test/browser.setup.ts')],
  env: {
    FAVILLA_HOME: home,
    // Sessions sealed at rest take a fixed test key, so no test asks Windows (DPAPI) for one or leaves key files behind.
    FAVILLA_TEST_DATA_KEY: Buffer.alloc(32, 1).toString('base64'),
    // Folder snapshots (a git process after every turn, still running as a test removes its folder) are tested on
    // their own in shadow.test.ts and stay off elsewhere.
    FAVILLA_FOLDER_SNAPSHOTS: '0',
  },
};
