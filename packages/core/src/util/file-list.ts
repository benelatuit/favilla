import fs from 'node:fs';
import path from 'node:path';
import { isProbablyBinary } from './text';

/** Metadata for the displayed entries only. Sample a bounded prefix of plain text, never a link or device. */
export function fileListLabels(cwd: string, names: string[]): string[] {
  let remaining = 256 * 1024;
  return names.map((name) => {
    if (name.endsWith('/')) return name;
    const file = path.resolve(cwd, name);
    let size = '';
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) return name;
      size = `  ${st.size} B`;
      if (!/\.(?:txt|md|csv|tsv|log|jsonl?|ndjson|[cm]?[jt]sx?|py|rs|go|java|c|cpp|h|css|html|sql|ya?ml|toml)$/i.test(name)) return name + size;
      const bytes = Math.min(st.size, remaining, 8192);
      if (!bytes) return name + size + (st.size ? '' : ', 0 lines');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
      try {
        const buf = Buffer.allocUnsafe(bytes);
        remaining -= bytes;
        const n = fs.readSync(fd, buf, 0, bytes, 0);
        if (!n || isProbablyBinary(buf.subarray(0, n))) return name + size;
        let lines = 0;
        for (let i = 0; i < n; i++) if (buf[i] === 10) lines++;
        if (buf[n - 1] !== 10) lines++;
        return `${name}${size}, ${lines}${n < st.size ? '+' : ''} ${lines === 1 && n === st.size ? 'line' : 'lines'}`;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return name + size;
    }
  });
}
