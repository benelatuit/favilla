import { highlightCode } from '../../lib/markdown';
import type { ToolDisplay, ToolResultPart } from '../../lib/types';
import { Images } from './MediaViewer';

export function CodePreview({ text, start, path }: { text: string; start: number; path: string }) {
  const lines = text.split('\n');
  return (
    <div className="plate">
      <div className="lines">
        {lines.map((l, i) => (
          <div key={i} className="ln ctx is-single">
            <span className="ln-n">{start + i}</span>
            <code dangerouslySetInnerHTML={{ __html: highlightCode(l, path) || ' ' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function FileReadView({ result, d }: { result: ToolResultPart; d: Extract<ToolDisplay, { kind: 'file' }> }) {
  if (d.image) return <Images result={result} />;
  return <CodePreview text={d.preview} start={d.startLine} path={d.path} />;
}

export function FileListView({ d }: { d: Extract<ToolDisplay, { kind: 'list' }> }) {
  return (
    <pre className="plate plain mono">
      {d.items.join('\n')}
      {d.total > d.items.length ? `\n… ${d.total - d.items.length}` : ''}
    </pre>
  );
}
