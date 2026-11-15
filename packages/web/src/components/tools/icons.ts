import type { ReactNode } from 'react';
import { commandText, mcpParts, stepWhat, toolKind, toolTarget, type ToolKind } from '../../lib/steps';
import {
  Binoculars,
  Camera,
  Compass,
  EnvelopeSimple,
  FilePlus,
  Files,
  FileText,
  Globe,
  ListChecks,
  MagnifyingGlass,
  NotePencil,
  PaintBrush,
  PencilSimpleLine,
  Plug,
  Pulse,
  Question,
  SealCheck,
  TerminalWindow,
  TreeStructure,
} from '../icons';

export type Kind = ToolKind;
export { commandText, mcpParts, stepWhat, toolKind, toolTarget };

export const ICONS: Record<Kind, (p: { size: number }) => ReactNode> = {
  read: FileText,
  write: FilePlus,
  edit: PencilSimpleLine,
  patch: PencilSimpleLine,
  shell: TerminalWindow,
  job: Pulse,
  grep: MagnifyingGlass,
  glob: Files,
  todo: ListChecks,
  task: TreeStructure,
  web: Globe,
  websearch: Binoculars,
  shot: Camera,
  mcp: Plug,
  ask: Question,
  plan: Compass,
  goal: ListChecks,
  check: SealCheck,
  note: NotePencil,
  mail: EnvelopeSimple,
  draw: PaintBrush,
  other: FileText,
};

export const VERB: Record<Kind, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  patch: 'Edit',
  shell: 'Run',
  job: 'Job',
  grep: 'Search',
  glob: 'Find',
  todo: 'Plan',
  task: 'Agent',
  web: 'Fetch',
  websearch: 'Search the web',
  shot: 'Screenshot',
  mcp: 'Tool',
  ask: 'Ask',
  plan: 'Plan',
  goal: 'Done when',
  check: 'Check',
  note: 'Note',
  mail: 'Mail',
  draw: 'Paint',
  other: 'Tool',
};

export const FILE_KINDS: readonly Kind[] = ['read', 'write', 'edit'];

/** "openai/gpt-6-luna" as "gpt-6-luna". */
export const shortModel = (ref: string) => ref.split('/').pop() ?? ref;
