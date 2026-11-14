import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { iconWeights } from './icon-weights.mjs';

// In development the UI talks to a running `favilla web --port 4317`; FAVILLA_TOKEN authorises the proxy.
const target = process.env.FAVILLA_API ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [iconWeights(), react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5317,
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        headers: process.env.FAVILLA_TOKEN ? { Authorization: `Bearer ${process.env.FAVILLA_TOKEN}` } : {},
      },
    },
  },
});
