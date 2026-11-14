import { describe, expect, it } from 'vitest';
import type { Part } from '../src/types';
import { estimateMessageTokens, estimatePartTokens, estimateTokens } from '../src/util/tokens';

describe('the token estimate of a text', () => {
  it('counts ASCII at 3.7 characters a token, CJK at about one a character, and the rest at two', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('x'.repeat(370))).toBe(100);
    expect(estimateTokens('func main() {}\n'.repeat(100))).toBe(Math.ceil(1500 / 3.7));
    expect(estimateTokens('连接池满了')).toBe(Math.ceil(5 * 1.05));
    expect(estimateTokens(`${'a'.repeat(37)}连接池满了é`)).toBe(Math.ceil(37 / 3.7 + 5 * 1.05 + 1 / 2));
  });
});

describe("a part's token estimate, kept between requests", () => {
  it('is counted again when the part changes in place, and not otherwise', () => {
    const part = { type: 'tool_result', callId: 'c1', name: 'read', content: 'x'.repeat(37_000) } as Part;
    const first = estimatePartTokens(part);
    expect(first).toBe(estimateTokens('x'.repeat(37_000)) + 8);
    expect(estimatePartTokens(part)).toBe(first);
    // Light compaction turns an old output into its stub, in the message it is in.
    Object.assign(part, { content: '[read output pruned]', pruned: true });
    expect(estimatePartTokens(part)).toBe(estimateTokens('[read output pruned]') + 8);
    // A caption joins it.
    Object.assign(part, { content: '[read output pruned]\nThe file defines the parser.' });
    expect(estimatePartTokens(part)).toBe(estimateTokens('[read output pruned]\nThe file defines the parser.') + 8);
  });

  it('counts a message from its parts, a part added later included', () => {
    const m = { id: 'm1', role: 'user', time: 0, parts: [{ type: 'text', text: 'a'.repeat(370) }] } as never as Parameters<typeof estimateMessageTokens>[0];
    const before = estimateMessageTokens(m);
    m.parts.push({ type: 'text', text: 'b'.repeat(740) });
    expect(estimateMessageTokens(m)).toBe(before + estimateTokens('b'.repeat(740)));
  });
});
