import path from 'node:path';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import { capture, which } from '../util/proc';
import { debug } from '../util/log';

const LOADERS: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
};

let python: string | null | undefined;

/**
 * Cheap syntax check run after every edit. Catching a broken bracket or indentation right away
 * saves the model a failing build later and keeps the error next to the edit that caused it.
 */
export async function syntaxCheck(file: string, content: string): Promise<string[]> {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file).toLowerCase();
  try {
    if (LOADERS[ext]) return await checkScript(content, LOADERS[ext], ext);
    if (ext === '.json' || ext === '.jsonc') return checkJson(content, ext === '.jsonc' || /^(tsconfig|jsconfig).*\.json$|settings\.json$|devcontainer\.json$/.test(base) || file.includes('.vscode'));
    if (ext === '.yaml' || ext === '.yml') return checkYaml(content);
    if (ext === '.py' || ext === '.pyi') return await checkPython(content);
  } catch (e) {
    debug('diagnostics', `could not check ${file}`, String((e as Error)?.message ?? e));
    return [];
  }
  return [];
}

async function checkScript(content: string, loader: 'ts' | 'tsx' | 'js' | 'jsx', ext: string): Promise<string[]> {
  // Loaded on first use: esbuild reads ESBUILD_BINARY_PATH when it loads, and the desktop app sets it at startup.
  const { transform } = await import('esbuild');
  try {
    await transform(content, { loader, logLevel: 'silent', format: ext === '.cjs' ? 'cjs' : 'esm', target: 'esnext' });
    return [];
  } catch (e) {
    const errors = (e as { errors?: { text: string; location?: { line: number; column: number; lineText?: string } }[] }).errors;
    // No parse errors means esbuild itself failed (missing binary, stopped service): not the file's fault.
    if (!errors?.length) throw e;
    return errors.slice(0, 5).map((er) => (er.location ? `line ${er.location.line}:${er.location.column + 1}: ${er.text}` : er.text));
  }
}

function checkJson(content: string, allowComments: boolean): string[] {
  const errors: ParseError[] = [];
  parseJsonc(content, errors, { allowTrailingComma: allowComments, disallowComments: !allowComments });
  return errors.slice(0, 5).map((er) => `offset ${er.offset} (line ${lineAt(content, er.offset)}): ${printParseErrorCode(er.error)}`);
}

function checkYaml(content: string): string[] {
  const doc = parseDocument(content, { prettyErrors: false });
  return doc.errors.slice(0, 5).map((er) => `line ${(er.linePos?.[0]?.line ?? 0) || '?'}: ${er.message.split('\n')[0]}`);
}

async function checkPython(content: string): Promise<string[]> {
  if (python === undefined) python = which('python') ?? which('python3');
  if (!python) return [];
  const script =
    'import ast,sys\nsrc=sys.stdin.buffer.read()\ntry:\n ast.parse(src)\nexcept SyntaxError as e:\n print(f"line {e.lineno}:{e.offset or 0}: {e.msg}")';
  const r = await capture(python, ['-c', script], { input: content, timeoutMs: 8000 });
  return r.stdout.trim() ? [r.stdout.trim()] : [];
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function formatDiagnostics(file: string, errors: string[]): string {
  if (!errors.length) return '';
  return `\n\nSyntax errors in ${file} after this change:\n${errors.map((e) => `  ${e}`).join('\n')}\nFix them before moving on.`;
}
