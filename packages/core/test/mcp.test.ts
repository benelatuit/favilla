import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpHub, mcpConfigFrom, mcpConfigsIn } from '../src/mcp/hub';
import type { ToolContext } from '../src/tools/types';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-server.mjs');
const ctx = { signal: new AbortController().signal, outputChars: 10_000, model: { vision: false } } as unknown as ToolContext;

describe('MCP servers', () => {
  it('keeps long and sanitized names distinct and stable on the read-only surface', async () => {
    const hub = new McpHub(Object.fromEntries(['a.b', 'a_b', 'long'.repeat(20)].map((name) => [name, { command: process.execPath, args: [fixture] }])));
    try {
      await hub.start();
      const names = hub.bindings().map((b) => b.spec.name);
      expect(new Set(names).size).toBe(6);
      expect(names.every((n) => n.length <= 64)).toBe(true);
      expect(hub.bindings(true).map((b) => b.spec.name)).toEqual([names[0], names[2], names[4]]);
    } finally {
      await hub.close();
    }
  });
  it('connects over stdio, names tools for the providers, and runs them', async () => {
    const hub = new McpHub({ fixture: { command: process.execPath, args: [fixture] }, off: { command: 'nothing', enabled: false } });
    try {
      await hub.start();
      expect(hub.status()).toEqual([
        { name: 'fixture', state: 'ready', tools: ['add', 'fail'], error: undefined },
        { name: 'off', state: 'off', tools: [], error: undefined },
      ]);
      const all = hub.bindings();
      expect(all.map((b) => b.spec.name)).toEqual(['mcp__fixture__add', 'mcp__fixture__fail']);
      expect(all[0].spec.parameters).toMatchObject({ type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } });
      // Research sub-agents only get tools that declare they only read.
      expect(hub.bindings(true).map((b) => b.spec.name)).toEqual(['mcp__fixture__add']);

      const add = await all[0].def.execute(all[0].normalize({ a: 2, b: 3 }), ctx);
      expect(add).toMatchObject({ content: '5', isError: false });
      const fail = await all[1].def.execute({}, ctx);
      expect(fail).toMatchObject({ content: 'nope', isError: true });
    } finally {
      await hub.close();
    }
  }, 30_000);

  it('reports a server that cannot start instead of failing the session', async () => {
    const hub = new McpHub({ broken: { command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutMs: 5000 } });
    await hub.start();
    expect(hub.status()[0]).toMatchObject({ name: 'broken', state: 'failed' });
    expect(hub.bindings()).toEqual([]);
    await hub.close();
  }, 30_000);

  it('takes new settings without a restart: added servers connect, removed ones close, the rest go on', async () => {
    const hub = new McpHub({ kept: { command: process.execPath, args: [fixture] } });
    try {
      await hub.start();
      const before = hub.bindings()[0];
      hub.update({ kept: { command: process.execPath, args: [fixture] }, added: { command: process.execPath, args: [fixture] } });
      expect(hub.status().map((s) => [s.name, s.state])).toEqual([
        ['kept', 'ready'],
        ['added', 'connecting'],
      ]);
      await hub.ready();
      expect(hub.status().map((s) => s.state)).toEqual(['ready', 'ready']);
      // The server that stayed is the same connection: a session holding its tools goes on using them.
      expect(await before.def.execute({ a: 1, b: 1 }, ctx)).toMatchObject({ content: '2' });
      hub.update({ added: { command: process.execPath, args: [fixture] } });
      expect(hub.status().map((s) => s.name)).toEqual(['added']);
      expect(await before.def.execute({ a: 1, b: 1 }, ctx)).toMatchObject({ isError: true });
    } finally {
      await hub.close();
    }
  }, 30_000);
});

describe('MCP settings from the settings page and from pasted text', () => {
  it('reads the blocks READMEs and other apps show', () => {
    expect(mcpConfigsIn('{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "t" } }, }, }')).toEqual([['github', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 't' } }]]);
    expect(mcpConfigsIn('{ "servers": { "docs": { "type": "http", "url": "https://mcp.example.com/mcp" } } }')).toEqual([['docs', { url: 'https://mcp.example.com/mcp' }]]);
    expect(mcpConfigsIn('{ "command": "uvx mcp-server-fetch" }')).toEqual([['', { command: 'uvx', args: ['mcp-server-fetch'] }]]);
    expect(mcpConfigsIn('{ "a b": { "serverUrl": "https://x.dev/sse", "disabled": true } }')).toEqual([['a-b', { url: 'https://x.dev/sse', enabled: false }]]);
    expect(mcpConfigsIn('not json')).toEqual([]);
    expect(mcpConfigsIn('{ "x": { "url": "file:///etc/passwd" } }')).toEqual([]);
  });

  it('keeps a saved secret the page never saw when its name comes back without a value', () => {
    const old = { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'secret', OLD: 'gone' } };
    expect(mcpConfigFrom({ kind: 'command', command: 'npx', args: `-y pkg --dir 'C:\\My Files'`, env: [{ name: 'TOKEN' }, { name: 'NEW', value: 'v' }] }, old)).toEqual({ command: 'npx', args: ['-y', 'pkg', '--dir', 'C:\\My Files'], env: { TOKEN: 'secret', NEW: 'v' } });
    expect(() => mcpConfigFrom({ kind: 'url', url: 'ftp://x' })).toThrow();
    expect(() => mcpConfigFrom({ kind: 'command', command: ' ' })).toThrow();
  });
});
