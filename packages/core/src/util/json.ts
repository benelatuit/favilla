import fs from 'node:fs';

/** Like a missing entry, an unreadable file leaves the choice to its caller. */
export function readJsonFile<T>(file: () => string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Parse tool-call arguments. Frontier models emit valid JSON; small local models sometimes
 * wrap it in fences, leave trailing commas, put raw newlines inside strings or stop before
 * the closing brace. Repairing those cases costs nothing and saves a whole round trip.
 *
 * `cut` says repair had to close something: the value ended inside a string, or before its last brackets. What is
 * there is only what arrived, which is fine for a read and not for a write.
 */
export function parseToolArgs(raw: string): { value: Record<string, unknown>; error?: string; cut?: 'string' | 'structure' } {
  const text = raw.trim();
  if (!text) return { value: {} };
  const direct = tryParse(text);
  if (direct.ok) return asObject(direct.value);

  let fixed = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  fixed = escapeRawNewlinesInStrings(fixed);
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  const closed = closeOpenStructures(fixed);
  const repaired = tryParse(closed.text);
  if (repaired.ok) return { ...asObject(repaired.value), ...(closed.cut ? { cut: closed.cut } : {}) };
  return { value: {}, error: `Invalid JSON arguments: ${direct.error}` };
}

function asObject(value: unknown): { value: Record<string, unknown>; error?: string } {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { value: value as Record<string, unknown> };
  if (typeof value === 'string') {
    const inner = tryParse(value);
    if (inner.ok && inner.value && typeof inner.value === 'object') return { value: inner.value as Record<string, unknown> };
  }
  return { value: {}, error: 'Tool arguments must be a JSON object' };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function escapeRawNewlinesInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') inString = false;
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') continue;
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

function closeOpenStructures(text: string): { text: string; cut?: 'string' | 'structure' } {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if ((ch === '}' || ch === ']') && stack.length) stack.pop();
  }
  const cut = inString ? ('string' as const) : stack.length ? ('structure' as const) : undefined;
  let out = text;
  if (inString) out += '"';
  while (stack.length) out += stack.pop();
  return { text: out, cut };
}

/** Stable stringify (sorted keys) so equal inputs compare equal. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
