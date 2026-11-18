import path from 'node:path';

/** Tests and evals use local Chrome or Chromium and never fall back to Edge. */
export function checkBrowser(executable: string | null): string | null {
  if (!executable) return null;
  const name = path.basename(executable).toLowerCase();
  return /^(?:chrome|google chrome|google-chrome(?:-stable)?|chromium(?:-browser)?|chrome-headless-shell)(?:\.exe)?$/.test(name) ? executable : null;
}
