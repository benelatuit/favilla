import { translateCatastropheReason } from '@favilla/core/guard/i18n';

/**
 * Why the guard asks before a command (core/src/guard/guard.ts), in the window's language. Whole sentences are
 * translated by their text; the ones built around a path or a rule by their pattern, the path or rule kept as the
 * guard gave it and the clause after the colon translated the same way. A sentence not known here stays in English.
 */
const PATTERNS: [RegExp, string][] = [
  [/^Deletes (.+): (.+)\.$/, 'Deletes {a}: {b}.'],
  [/^Recursively deletes (.+), outside the workspace\.$/, 'Recursively deletes {a}, outside the workspace.'],
  [/^Changes permissions recursively on (.+): (.+)\.$/, 'Changes permissions recursively on {a}: {b}.'],
  [/^find … -delete under (.+), outside the workspace\.$/, 'find … -delete under {a}, outside the workspace.'],
  [/^find … -delete under (.+): (.+)\.$/, 'find … -delete under {a}: {b}.'],
  [/^Matches your rule \/(.+)\/\.$/, 'Matches your rule /{a}/.'],
  [/^it targets the system folder (.+)$/, 'it targets the system folder {a}'],
  [/^it targets (.+), which holds keys and app data$/, 'it targets {a}, which holds keys and app data'],
  [/^"(.+)" depends on a variable that may be empty$/, '"{a}" depends on a variable that may be empty'],
];

export function guardReason(t: (key: string) => string, reason: string): string {
  const catastrophe = translateCatastropheReason(reason, t);
  if (catastrophe !== null) return catastrophe;
  for (const [re, key] of PATTERNS) {
    const m = re.exec(reason);
    if (m) return t(key).replace('{a}', m[1]).replace('{b}', m[2] === undefined ? '' : guardReason(t, m[2]));
  }
  return t(reason);
}
