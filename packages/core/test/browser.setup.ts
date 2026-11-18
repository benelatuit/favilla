import { vi } from 'vitest';
import { checkBrowser } from './check-browser';

// Also cover browser discovery inside a session or image tool invoked by a test.
vi.mock(import('../src/tools/browser'), async (original) => {
  const browser = await original();
  return { ...browser, findBrowser: (override?: string) => checkBrowser(browser.findBrowser(override)) };
});
