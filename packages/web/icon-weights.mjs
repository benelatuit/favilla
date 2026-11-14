/**
 * Phosphor ships six weights of every icon in one module. The interface draws regular, bold, fill and duotone
 * (STYLE.md: regular unless a state calls for another); thin and light were a third of every icon's bytes in the
 * page's first script. This drops their entries from each icon's module as the page is built.
 */
const DROP = ['thin', 'light'];

/** The end of the bracketed entry that starts at `open` (a `[`), skipping over strings. */
function closing(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++;
      continue;
    }
    if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** An icon module without the dropped weights; any other code comes back as it was. */
export function dropWeights(code) {
  let out = code;
  for (const weight of DROP) {
    const at = out.search(new RegExp(`\\[\\s*"${weight}",`));
    if (at < 0) continue;
    const end = closing(out, at);
    if (end < 0) return code;
    // The entry and the comma that separates it from the next one.
    const next = out.slice(end + 1).match(/^\s*,/);
    out = out.slice(0, at) + out.slice(end + 1 + (next ? next[0].length : 0));
  }
  return out;
}

export function iconWeights() {
  return {
    name: 'favilla-icon-weights',
    enforce: 'pre',
    transform(code, id) {
      if (!/@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/][^\\/]+\.es\.js$/.test(id.split('?')[0])) return null;
      return { code: dropWeights(code), map: null };
    },
  };
}
