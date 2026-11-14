// A small MCP server for the hub test: one read-only tool and one that always reports an error.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool(
  'add',
  { description: 'Adds two numbers.', inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
);
server.registerTool('fail', { description: 'Always fails.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }));
await server.connect(new StdioServerTransport());
