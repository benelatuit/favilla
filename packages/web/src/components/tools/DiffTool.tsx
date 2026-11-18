import { memo, useMemo, useRef } from 'react';
import { absolutePath } from '../../lib/desktop';
import { diffRows } from '../../lib/diff';
import { diffOp } from '../../lib/format';
import type { DiffFile } from '../../lib/types';
import { CodeRows } from '../code/CodeRows';

/**
 * The files a step changed. One file is named by the step's own line already, so only several, or a move, get a
 * name above each. `all` draws every row at once, for Find.
 */
export function DiffView({ files, cwd, bare, all }: { files: DiffFile[]; cwd?: string; bare?: boolean; all?: boolean }) {
  const named = !bare && (files.length > 1 || !!files[0]?.movedTo);
  return (
    <div className="diff">
      {files.map((f) => (
        <div key={f.path + (f.movedTo ?? '')} className="diff-file">
          {named && (
            <div className="diff-name" {...(cwd ? { 'data-ctx': 'file', 'data-path': absolutePath(cwd, f.movedTo ?? f.path) } : {})}>
              <span className={`diff-op is-${f.op}`}>{diffOp(f.op)}</span>
              <span className="mono diff-path">{f.movedTo ? `${f.path} → ${f.movedTo}` : f.path}</span>
              <span className="step-meta num">
                <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
              </span>
            </div>
          )}
          <DiffLines patch={f.patch} path={f.movedTo ?? f.path} all={all} />
        </div>
      ))}
    </div>
  );
}

/** One file's diff in a box of its own that scrolls. */
export const DiffLines = memo(function DiffLines({ patch, path, all }: { patch: string; path: string; all?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const d = useMemo(() => diffRows(patch, path), [patch, path]);
  return (
    <div className="dl-box" ref={box}>
      <CodeRows rows={d.rows} widest={d.widest} digits={d.digits} sides={2} root={box} all={all} />
    </div>
  );
});
