import hljs from 'highlight.js/lib/common';

const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Code coloured for its file's language, as markup; plain escaped text when the language is not known. */
export function highlightCode(code: string, path?: string): string {
  const ext = path?.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', py: 'python', rs: 'rust', go: 'go', md: 'markdown', yml: 'yaml', sh: 'bash', ps1: 'powershell', cs: 'csharp', kt: 'kotlin', rb: 'ruby' };
  const lang = ext ? (map[ext] ?? ext) : undefined;
  try {
    return lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : escapeHtml(code);
  } catch {
    return escapeHtml(code);
  }
}
