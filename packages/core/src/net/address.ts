function userInfo(value: string) {
  const match = /^(\s*[a-z][\w+.-]*:\/\/)?([^/?#]*)@/i.exec(value);
  if (!match) return undefined;
  const start = match[1]?.length ?? 0;
  const at = match[0].length - 1;
  const colon = match[2].indexOf(':');
  return {
    start,
    at,
    name: match[2].slice(0, colon < 0 ? undefined : colon),
    password: colon < 0 ? '' : match[2].slice(colon + 1),
    colon: colon >= 0,
  };
}

function decoded(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function encoded(value: string): string {
  try { return encodeURIComponent(value); }
  catch { return value; }
}

const secretParam = /(?:^|[-_])(?:api[-_]?key|(?:access|refresh|id)[-_]?token|key|token|password|client[-_]?secret|secret|auth|authorization|signature|sig)$/i;

/** Do not normalize the rest of an address when hiding the credentials a settings page cannot edit in place. */
export function addressView(value: string, hideQuery = false): { address: string; passwordSaved: boolean; hidden: string[] } {
  const user = userInfo(value);
  const hidden = user?.password ? [user.password] : [];
  let address = user?.colon ? value.slice(0, user.start + user.name.length) + value.slice(user.at) : value;
  if (hideQuery) {
    const at = address.indexOf('?');
    const hash = address.indexOf('#');
    if (at >= 0 && (hash < 0 || at < hash)) {
      const params = address.slice(at + 1, hash < 0 ? undefined : hash).split('&');
      const keep = params.filter((param) => {
        const eq = param.indexOf('=');
        if (eq < 0 || !secretParam.test(decoded(param.slice(0, eq)))) return true;
        hidden.push(param.slice(eq + 1), decoded(param.slice(eq + 1).replace(/\+/g, ' ')));
        return false;
      });
      if (keep.length !== params.length) address = address.slice(0, at) + (keep.length ? '?' + keep.join('&') : '') + (hash < 0 ? '' : address.slice(hash));
    }
  }
  return { address, passwordSaved: !!user?.password, hidden };
}

export function keepProxyPassword(value: string, stored: string | undefined): string {
  const old = userInfo(stored ?? '');
  const next = userInfo(value);
  if (!old?.password || !next || next.password || decoded(next.name) !== decoded(old.name)) return value;
  return value.slice(0, next.start + next.name.length) + ':' + old.password + value.slice(next.at);
}

/** An unchanged address in a form is the one the engine had, including anything the form could not see. */
export function keepSavedAddress(value: string, stored: string | undefined): string {
  return stored && value === addressView(stored, true).address ? stored : value;
}

export function redactSecrets(text: string | undefined, values: string[]): string | undefined {
  if (text === undefined) return undefined;
  const secrets = new Set(values.flatMap((v) => {
    if (!v) return [];
    const token = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(v)?.[1];
    return [v, decoded(v), encoded(v), ...(token ? [token] : [])];
  }));
  for (const value of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(value, '••••');
  return text;
}
