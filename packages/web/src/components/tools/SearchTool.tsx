import type { ReactNode } from 'react';
import { absolutePath } from '../../lib/desktop';
import { markRanges, parseMatches } from '../../lib/steps';

function Marked({ text, pattern }: { text: string; pattern: string }) {
  const ranges = markRanges(text, pattern);
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** Search results as files, each with its numbered lines and the matched text marked. */
export function MatchesView({ preview, pattern, cwd }: { preview: string; pattern: string; cwd: string }) {
  const files = parseMatches(preview);
  if (!files.length) return <pre className="plate plain mono">{preview}</pre>;
  return (
    <div className="plate matches">
      {files.map((file) => (
        <div key={file.path} className="match-file">
          <div className="match-path mono" data-ctx="file" data-path={absolutePath(cwd, file.path)}>
            {file.path}
          </div>
          {file.lines.map((l, i) =>
            l.n === undefined ? (
              <div key={i} className="match-line is-count num">
                {l.text}
              </div>
            ) : (
              <div key={i} className={`match-line ${l.context ? 'is-context' : ''}`}>
                <span className="ln-n num">{l.n}</span>
                <code>{l.context ? l.text : <Marked text={l.text} pattern={pattern} />}</code>
              </div>
            ),
          )}
        </div>
      ))}
    </div>
  );
}
