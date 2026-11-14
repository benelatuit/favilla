import { defineConfig } from 'vitest/config';
import { testSettings } from './vitest.shared';

export default defineConfig({
  // An extension's tests are in its own folder (packages/core/extensions/<name>/test), so they go with it.
  test: { ...testSettings, include: ['packages/*/test/**/*.test.{ts,tsx}', 'packages/core/extensions/*/test/**/*.test.ts'] },
});
