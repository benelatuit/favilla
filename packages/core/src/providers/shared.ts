import pkg from '../../package.json';
import type { ImagePart, Message, Part } from '../types';

/**
 * Favilla's User-Agent for model servers, before the provider's own headers so a user can set another. Without one
 * undici sends "undici", which relays behind Cloudflare refuse as a bot with a 403.
 */
export const USER_AGENT = `favilla/${pkg.version}`;

/** Provider headers that name the client, not secrets: they stay readable in error messages. */
export const PUBLIC_HEADERS = new Set(['user-agent', 'http-referer', 'referer', 'x-title', 'accept', 'content-type']);

/** Anthropic and some compatible servers only accept [A-Za-z0-9_-] in tool ids. */
export function safeToolId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return clean.length ? clean.slice(0, 64) : 'call';
}

/** The detail field of a picture, for protocols that have one. */
export function imageDetail(image: ImagePart): { detail?: 'high' } {
  return image.detail ? { detail: image.detail } : {};
}

export function dataUrl(image: ImagePart): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** JSON Schema keywords Gemini's OpenAPI-style schema understands. */
const GEMINI_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'properties',
  'required',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'propertyOrdering',
  'title',
  'minLength',
  'maxLength',
  'pattern',
]);

/** Reduce a JSON Schema to the subset accepted by Gemini function declarations. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!GEMINI_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === 'items' || k === 'anyOf') {
      out[k] = toGeminiSchema(v);
    } else if (k === 'type' && Array.isArray(v)) {
      const types = v.filter((t) => t !== 'null');
      out.type = types[0];
      if (types.length < v.length) out.nullable = true;
    } else if (k === 'format' && typeof v === 'string' && !['enum', 'date-time'].includes(v)) {
      continue;
    } else {
      out[k] = v;
    }
  }
  if ('const' in src && !('enum' in out)) out.enum = [src.const];
  return out;
}

/** Strip keywords that strict validators reject while keeping the schema meaningful. */
export function plainSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = schema;
  return rest;
}
