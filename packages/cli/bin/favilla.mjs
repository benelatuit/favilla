#!/usr/bin/env node
// Node keeps the compiled bundle on disk between starts: --version went from 290 to 212 ms (2026-11-02). The cache
// must be on before the bundle loads, so the bundle is imported after it.
import module from 'node:module';

module.enableCompileCache?.();
await import('../dist/favilla.mjs');
