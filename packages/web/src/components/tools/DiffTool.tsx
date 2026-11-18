import { memo, useMemo, useRef, useState, type ReactNode } from 'react';
import { absolutePath } from '../../lib/desktop';
import { diffRows } from '../../lib/diff';
import { useT } from '../../lib/i18n';
import { diffOp } from '../../lib/format';
import type { DiffFile } from '../../lib/types';
import { CodeRows } from '../code/CodeRows';

export function BinarySize({ bytes }: { bytes: NonNullable<DiffFile['binary']> }) {
  const t = useT();
  return <span>{t('Binary file: {before} → {after} bytes').replace('{before}', String(bytes.before)).replace('{after}', String(bytes.after))}</span>;
}

export function PatchBody({ file, children, all }: { file: DiffFile; children: ReactNode; all?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (file.binary) return <p className="changes-note"><BinarySize bytes={file.binary} /></p>;
  if (all || (file.patch.length <= 100_000 && file.added + file.removed <= 3000)) return children;
  return <><button type="button" className="btn is-small changes-code-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{t(open ? 'Hide text changes' : 'Show text changes')}</button>{open && children}</>;
}

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
          {(named || f.binary) && (
            <div className="diff-name" {...(cwd ? { 'data-ctx': 'file', 'data-path': absolutePath(cwd, f.movedTo ?? f.path) } : {})}>
              <span className={`diff-op is-${f.op}`}>{diffOp(f.op)}</span>
              <span className="mono diff-path">{f.movedTo ? `${f.path} → ${f.movedTo}` : f.path}</span>
              {!f.binary && <span className="step-meta num">
                <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
              </span>}
            </div>
          )}
          <PatchBody file={f} all={all}><DiffLines patch={f.patch} path={f.movedTo ?? f.path} all={all} /></PatchBody>
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
