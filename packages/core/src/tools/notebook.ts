import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { displayPath, resolvePath } from '../util/paths';
import { makeDiff } from './diffutil';
import { readText, renderNotebook, writeText } from './fs-tools';
import type { ToolDef } from './types';

export interface NotebookEditInput {
  path: string;
  /** A cell id, or a 1-based cell number as Read shows it. For insert: the new cell goes after it (first when absent). */
  cell?: string;
  source: string;
  cellType?: 'code' | 'markdown';
  mode: 'replace' | 'insert' | 'delete';
}

interface Cell {
  id?: string;
  cell_type: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

/** nbformat stores source as lines that keep their newline, except the last. */
function toLines(source: string): string[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  return lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l)).filter((l, i, all) => !(i === all.length - 1 && l === ''));
}

function findCell(cells: Cell[], ref: string): number {
  const byId = cells.findIndex((c) => c.id === ref);
  if (byId >= 0) return byId;
  const n = /^(?:cell[\s-]*)?(\d+)$/i.exec(ref.trim());
  return n ? Number(n[1]) - 1 : -1;
}

/**
 * Edits one cell of a Jupyter notebook: replace its source (a code cell loses its stale outputs), insert a
 * new cell after it, or delete it. The notebook keeps its own indentation, metadata and the other cells.
 */
export const notebookEditTool: ToolDef<NotebookEditInput> = {
  kind: 'edit',
  readOnly: false,
  title: (i, cwd) => `${i.mode === 'insert' ? 'Insert a cell into' : i.mode === 'delete' ? 'Delete a cell of' : 'Edit a cell of'} ${displayPath(cwd, resolvePath(cwd, i.path))}`,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, abs);
    if (!/\.ipynb$/i.test(abs)) return { content: `${shown} is not a notebook (.ipynb). Use the file editing tools for other files.`, isError: true };
    if (!fs.existsSync(abs)) return { content: `File not found: ${shown}.`, isError: true };
    const why = ctx.mayChange?.(abs) ?? ctx.files.checkEditable(abs);
    if (why) return { content: why, isError: true };
    const before = readText(abs);
    let nb: { cells?: Cell[]; nbformat?: number; nbformat_minor?: number; metadata?: { language_info?: { name?: string } } };
    try {
      nb = JSON.parse(before.text);
    } catch (e) {
      return { content: `${shown} is not valid notebook JSON: ${(e as Error).message}`, isError: true };
    }
    const cells = (nb.cells ??= []);
    const at = input.cell === undefined ? -1 : findCell(cells, input.cell);
    if (input.cell !== undefined && (at < 0 || at >= cells.length)) {
      return { content: `No cell "${input.cell}" in ${shown}; it has ${cells.length} cells (numbers 1-${cells.length}, or the ids Read shows).`, isError: true };
    }
    let summary: string;
    if (input.mode === 'delete') {
      if (at < 0) return { content: 'Say which cell to delete.', isError: true };
      cells.splice(at, 1);
      summary = `Deleted cell ${at + 1}`;
    } else if (input.mode === 'insert') {
      const type = input.cellType ?? 'code';
      const cell: Cell = { cell_type: type, metadata: {}, source: toLines(input.source) };
      if (type === 'code') Object.assign(cell, { execution_count: null, outputs: [] });
      // Cell ids exist from nbformat 4.5 on.
      if ((nb.nbformat ?? 4) > 4 || (nb.nbformat_minor ?? 0) >= 5) cell.id = randomBytes(4).toString('hex');
      cells.splice(at + 1, 0, cell);
      summary = `Inserted a ${type} cell as cell ${at + 2}`;
    } else {
      if (at < 0) return { content: 'Say which cell to replace.', isError: true };
      const cell = cells[at];
      if (input.cellType && input.cellType !== cell.cell_type) {
        cell.cell_type = input.cellType;
        if (input.cellType === 'markdown') {
          delete cell.outputs;
          delete cell.execution_count;
        }
      }
      cell.source = toLines(input.source);
      if (cell.cell_type === 'code') Object.assign(cell, { execution_count: null, outputs: [] });
      summary = `Replaced cell ${at + 1}`;
    }
    const indent = /^\{\r?\n(\s+)"/.exec(before.text)?.[1] ?? ' ';
    const out = `${JSON.stringify(nb, null, indent)}${before.text.endsWith('\n') ? '\n' : ''}`;
    ctx.checkpoints.capture(ctx.turn, abs);
    writeText(abs, out, before.bom, before.encoding);
    ctx.files.recordWrite(abs);
    return {
      content: `${summary} of ${shown} (${cells.length} cells now). Run the notebook to refresh its outputs.`,
      display: { kind: 'diff', files: [makeDiff(shown, renderNotebook(before.text), renderNotebook(out), 'update')] },
    };
  },
};

const SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'venv', '__pycache__', 'vendor']);

/** Whether the project has notebooks, looked for breadth first over its first few thousand entries. */
export function hasNotebooks(root: string, budget = 4000): boolean {
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < budget) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > budget) return false;
      if (e.isFile() && e.name.endsWith('.ipynb')) return true;
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) queue.push(path.join(dir, e.name));
    }
  }
  return false;
}
