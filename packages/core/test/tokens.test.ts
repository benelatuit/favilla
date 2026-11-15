import { describe, expect, it } from 'vitest';
import type { Part } from '../src/types';
import { estimateImageTokens, estimateMessageTokens, estimatePartTokens, estimateTokens, IMAGE_TOKENS } from '../src/util/tokens';

function pngHeaderBase64(width: number, height: number): string {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

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

  it('estimates image tokens from pixel dimensions or header bytes, and drops to zero when image data is stripped', () => {
    expect(estimateImageTokens({ width: 320, height: 120, data: 'x' })).toBe(255); // 1x1 tile
    expect(estimateImageTokens({ width: 1280, height: 800, data: 'x' })).toBe(1105); // 3x2 tiles
    expect(estimateImageTokens({ width: 1920, height: 1080, data: 'x' })).toBe(2125); // 4x3 tiles
    // 4K scales into a 2048px box (2048x1152 -> 4x3 tiles).
    expect(estimateImageTokens({ width: 3840, height: 2160, data: 'x' })).toBe(2125);
    // Base64 PNG header parsed automatically when width/height fields are absent.
    expect(estimateImageTokens({ data: pngHeaderBase64(2560, 1440) })).toBe(2125);
    // Synthetic test payload without valid image header falls back to IMAGE_TOKENS.
    expect(estimateImageTokens({ data: 'aGk=' })).toBe(IMAGE_TOKENS);
    // Stripped image bytes cost 0 tokens, and in-place clearing invalidates the cached part estimate.
    const toolPart = {
      type: 'tool_result',
      callId: 'img1',
      name: 'read',
      content: 'Image shot.png is attached.',
      images: [{ type: 'image', mediaType: 'image/png', data: pngHeaderBase64(1920, 1080) }],
    } as Part;
    expect(estimatePartTokens(toolPart)).toBe(estimateTokens('Image shot.png is attached.') + 2125 + 8);
    (toolPart as Extract<Part, { type: 'tool_result' }>).images![0].data = '';
    expect(estimatePartTokens(toolPart)).toBe(estimateTokens('Image shot.png is attached.') + 8);
  });
});
