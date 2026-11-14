import { defineConfig } from 'vitest/config';
import { testSettings } from '../../vitest.shared';

// The workspace's test settings when the tests are run from this folder (vitest.shared.ts says why).
export default defineConfig({ test: { ...testSettings, include: ['test/**/*.test.{ts,tsx}', 'extensions/*/test/**/*.test.ts'] } });
