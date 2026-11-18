import type { ToolDef } from './types';
import type { WebFetchInput } from './web';
import type { WebSearchInput } from './websearch';

/** Copies of other sites' pages (mostly Stack Overflow and CSDN threads, often machine-translated): left out. */
export const COPY_SITES = [
  'qastack.com', 'qastack.ru', 'qastack.com.br', 'qastack.mx', 'qastack.cn', 'qastack.jp', 'qastack.fr', 'qastack.it', 'qastack.kr', 'qastack.vn', 'qastack.id', 'qastack.in.th', 'qastack.info.tr', 'qastack.com.de', 'qastack.com.ua',
  'it-swarm.com', 'it-swarm.dev', 'it-swarm.net', 'it-swarm.xyz', 'it-swarm.asia', 'it-swarm-fr.com', 'it-swarm-es.com', 'it-swarm.com.de', 'it-swarm-ja.tech', 'it-swarm-vi.com',
  'stackovernet.com', 'stackovernet.xyz', 'stackoom.com', 'exchangetuts.com', 'itcodar.com', 'newbedev.com', 'solveforum.com', 'answerbun.com', 'devcodetutorial.com', 'codeleading.com',
  'programmerall.com', 'titanwolf.org', 'quabr.com', 'py4u.net', 'py4u.org', 'pythonfixing.com', 'javaer101.com', 'stackguides.com', 'coder.social', 'programmersought.com', 'pianshen.com',
  'icode9.com', 'codenong.com',
];

export const webFetchTool: ToolDef<WebFetchInput> = {
  kind: 'web',
  readOnly: true,
  title: (i) => `Fetch ${i.url}`,
  async execute(input, ctx) { return (await import('./web')).execute(input, ctx); },
};

export const webSearchTool: ToolDef<WebSearchInput> = {
  kind: 'web',
  readOnly: true,
  title: (i) => `Search the web for "${i.query}"`,
  async execute(input, ctx) { return (await import('./websearch')).execute(input, ctx); },
};
