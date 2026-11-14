import { describe, expect, it } from 'vitest';
import { parseToolArgs } from '../src/util/json';

describe('parseToolArgs', () => {
  it('parses valid JSON', () => {
    expect(parseToolArgs('{"a":1}').value).toEqual({ a: 1 });
  });

  it('repairs raw newlines inside strings', () => {
    expect(parseToolArgs('{"content":"line1\nline2"}').value).toEqual({ content: 'line1\nline2' });
  });

  it('repairs a missing closing brace', () => {
    expect(parseToolArgs('{"file_path":"a.ts","limit":20').value).toEqual({ file_path: 'a.ts', limit: 20 });
  });

  it('strips code fences and trailing commas', () => {
    expect(parseToolArgs('```json\n{"a":[1,2,],}\n```').value).toEqual({ a: [1, 2] });
  });

  it('reports what cannot be repaired', () => {
    expect(parseToolArgs('not json at all').error).toBeTruthy();
  });

  it('treats empty arguments as an empty object', () => {
    expect(parseToolArgs('').value).toEqual({});
  });
});
