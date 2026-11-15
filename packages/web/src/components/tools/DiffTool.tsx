import { memo } from 'react';
import { absolutePath } from '../../lib/desktop';
import { diffOp } from '../../lib/format';
import { highlightCode } from '../../lib/markdown';
import type { DiffFile } from '../../lib/types';

export function DiffView({ files, compact, cwd, bare }: { files: DiffFile[]; compact?: boolean; cwd?: string; bare?: boolean }) {
  return (
    <div className="diff">
      {files.map((f) => (
        <div key={f.path + (f.movedTo ?? '')} className="diff-file plate">
          {!bare && (
            <div className="diff-name" {...(cwd ? { 'data-ctx': 'file', 'data-path': absolutePath(cwd, f.movedTo ?? f.path) } : {})}>
              <span className={`diff-op is-${f.op}`}>{diffOp(f.op)}</span>
              <span className="mono diff-path">{f.movedTo ? `${f.path} → ${f.movedTo}` : f.path}</span>
              <span className="step-meta num">
                <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
              </span>
            </div>
          )}
          <DiffLines patch={f.patch} path={f.movedTo ?? f.path} compact={compact} />
        </div>
      ))}
    </div>
  );
}

const DiffLines = memo(function DiffLines({ patch, path, compact }: { patch: string; path: string; compact?: boolean }) {
  const rows: { cls: string; old?: number; neu?: number; html: string }[] = [];
  let o = 0;
  let n = 0;
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      if (rows.length) rows.push({ cls: 'hunk', html: '' });
      continue;
    }
    if (line.startsWith('@@') || line.startsWith('\\')) continue;
    const body = highlightCode(line.slice(1), path);
    if (line.startsWith('+')) rows.push({ cls: 'ins', neu: n++, html: body });
    else if (line.startsWith('-')) rows.push({ cls: 'rem', old: o++, html: body });
    else rows.push({ cls: 'ctx', old: o++, neu: n++, html: body });
  }
  const shown = compact ? rows.slice(0, 80) : rows;
  return (
    <div className="lines">
      {shown.map((r, i) =>
        r.cls === 'hunk' ? (
          <div key={i} className="ln hunk" aria-hidden>
            ⋯
          </div>
        ) : (
          <div key={i} className={`ln ${r.cls}`}>
            <span className="ln-n">{r.old ?? ''}</span>
            <span className="ln-n">{r.neu ?? ''}</span>
            <span className="ln-m">{r.cls === 'ins' ? '+' : r.cls === 'rem' ? '−' : ''}</span>
            <code dangerouslySetInnerHTML={{ __html: r.html || ' ' }} />
          </div>
        ),
      )}
      {compact && rows.length > shown.length && <div className="ln hunk">+{rows.length - shown.length}</div>}
    </div>
  );
});
