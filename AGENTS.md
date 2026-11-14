# Working on Favilla

Favilla is a pnpm workspace in TypeScript (Node 22+):

- `packages/core` is the engine: providers (`src/providers`), tools and their per-family surfaces (`src/tools`, `profiles.ts`), the agent loop (`src/agent/session.ts`), context budget and compaction, the session store, the HTTP + SSE server for the GUI. Prompts are markdown in `packages/core/assets/prompts`; provider and model defaults are data in `src/catalog/*.json`.
- `packages/cli` is the `favilla` command: headless runs (`-p`), the Ink terminal UI (`src/tui`), `login`, `models`, `web`.
- `packages/web` is the React UI served by the core server; colours live only in `src/themes/*.css`.
- `packages/desktop` wraps core + web in Electron; `node build.mjs --dist` makes the Windows installers.
- `packages/relay` is the Cloudflare Worker that remote control goes through.

Checks before calling a change done:

- `pnpm typecheck` and `pnpm test` (vitest, `packages/*/test`).
- For provider changes, add a conversion test in `packages/core/test/convert.test.ts`: replayed reasoning (signatures, encrypted content, thought signatures) must come back exactly as received.
- For prompt or tool changes, also try them in a real run on a small task (`pnpm favilla -p "..."`) and read what the model did.
- The session history is append-only: never edit or drop earlier messages except through compaction; add notes as new text parts after tool results.

Style: match the surrounding code, comments explain why, no colours or user-facing strings hardcoded outside themes and `i18n.ts`.
