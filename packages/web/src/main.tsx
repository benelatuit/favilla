import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/400-italic.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './themes/drafting.css';
import './themes/nightshift.css';
import './themes/kiln.css';
import './themes/porcelain.css';
import './themes/plain.css';
import './themes/daylight.css';
import './styles/base.css';
import './styles/controls.css';
import './styles/shell.css';
import './styles/settings.css';
import './styles/timeline.css';
import './styles/composer.css';
import { FORMER_NAME } from '@favilla/core/former-name';
import { App } from './App';

/**
 * What this window kept under the app's former name (the theme, the composer's drafts, the last model picked) is moved
 * to the present one once, before anything reads it, so the first start after the rename keeps the user's drafts and
 * choices. A value already kept under the new name wins.
 */
try {
  for (const key of FORMER_NAME ? Object.keys(localStorage) : []) {
    if (!key.startsWith(`${FORMER_NAME}.`)) continue;
    const now = `favilla.${key.slice(`${FORMER_NAME}.`.length)}`;
    if (localStorage.getItem(now) === null) localStorage.setItem(now, localStorage.getItem(key) ?? '');
    localStorage.removeItem(key);
  }
} catch {
  /* storage unavailable or full: those values start over */
}

/**
 * The theme the window had last time, on the document before the first paint: the start screen and the first frame
 * are in the user's colours, not in the light theme until the settings arrive. A first start follows the system.
 */
try {
  const theme = localStorage.getItem('favilla.theme') ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'nightshift' : null);
  if (theme) document.documentElement.dataset.theme = theme;
} catch {
  /* storage unavailable: the settings set it once they arrive */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
