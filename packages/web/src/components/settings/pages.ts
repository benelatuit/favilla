import type { Icon } from '@phosphor-icons/react';
import type { SettingsPage } from '../../lib/store';
import { ChartBar, Cpu, DeviceMobile, EnvelopeSimple, HardDrives, Key, Plug, Ruler, SlidersHorizontal, Stack, UserCircle, Wrench } from '../icons';

/**
 * The pages in the order of the nav, in groups by what people come for: the app and its models; what the agent is
 * told; what it can reach; this computer.
 */
export const PAGES: { id: SettingsPage; label: string; icon: Icon; group: number }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, group: 0 },
  { id: 'providers', label: 'Providers', icon: Key, group: 0 },
  { id: 'models', label: 'Models', icon: Cpu, group: 0 },
  { id: 'rules', label: 'Rules', icon: Ruler, group: 1 },
  { id: 'personas', label: 'Personas', icon: UserCircle, group: 1 },
  { id: 'presets', label: 'Presets', icon: Stack, group: 1 },
  { id: 'tools', label: 'Tools', icon: Wrench, group: 2 },
  { id: 'mcp', label: 'MCP servers', icon: Plug, group: 2 },
  { id: 'mail', label: 'Mail', icon: EnvelopeSimple, group: 2 },
  { id: 'remote', label: 'Remote', icon: DeviceMobile, group: 3 },
  { id: 'usage', label: 'Usage', icon: ChartBar, group: 3 },
  { id: 'storage', label: 'Storage', icon: HardDrives, group: 3 },
];

export const pageOf = (id: SettingsPage) => PAGES.find((p) => p.id === id)!;

/** A setting the search can find: the row it is on (data-setting), its page, its name, and other words for it. */
export interface Findable {
  id: string;
  page: SettingsPage;
  label: string;
  terms?: string;
}

/** Every fixed setting; the providers and the extensions' settings are added from what the server says. */
export const FINDABLE: Findable[] = [
  { id: 'theme', page: 'general', label: 'Theme', terms: 'dark light night kiln drafting daylight porcelain plain white blue colour color appearance' },
  { id: 'language', page: 'general', label: 'Language', terms: 'english chinese locale' },
  { id: 'memory', page: 'general', label: 'Memory', terms: 'graphics gpu hardware acceleration low-memory' },
  { id: 'permissions', page: 'general', label: 'Permissions', terms: 'safety guard destructive ask confirm full access' },
  { id: 'add-provider', page: 'providers', label: 'Add a provider', terms: 'custom openai compatible gateway base url' },
  { id: 'proxy', page: 'providers', label: 'HTTPS proxy', terms: 'network proxy' },
  { id: 'model', page: 'models', label: 'Model', terms: 'default model' },
  { id: 'effort', page: 'models', label: 'Reasoning effort', terms: 'thinking effort' },
  { id: 'subagent-model', page: 'models', label: 'Sub-agent model', terms: 'subagent' },
  { id: 'shadow-tests', page: 'models', label: 'Shadow tests', terms: 'tests go' },
  { id: 'compact-at', page: 'models', label: 'Compact when the context reaches', terms: 'compaction context summary' },
  { id: 'context-window', page: 'models', label: 'Context window', terms: 'tokens window' },
  { id: 'vision', page: 'models', label: 'Reads pictures', terms: 'vision images screenshots' },
  { id: 'rules-global', page: 'rules', label: 'Every project', terms: 'agents.md instructions global rules' },
  { id: 'rules-project', page: 'rules', label: 'This project', terms: 'agents.md instructions project rules' },
  { id: 'notes-project', page: 'rules', label: 'Notes on this project', terms: 'memory remember notes' },
  { id: 'notes-user', page: 'rules', label: 'Notes about you', terms: 'memory remember notes' },
  { id: 'persona-here', page: 'personas', label: 'This folder uses', terms: 'persona character default' },
  { id: 'persona-library', page: 'personas', label: 'Persona library', terms: 'character card sillytavern import' },
  { id: 'preset-here', page: 'presets', label: 'This folder uses', terms: 'preset default' },
  { id: 'preset-library', page: 'presets', label: 'Preset library', terms: 'sillytavern import prompts prefill' },
  { id: 'tool-style', page: 'tools', label: 'Tool style', terms: 'file shell patch tools' },
  { id: 'terminal', page: 'tools', label: 'Terminal', terms: 'shell bash powershell cmd' },
  { id: 'skills', page: 'tools', label: 'Skills', terms: 'skills' },
  { id: 'web-search', page: 'tools', label: 'Web search', terms: 'search internet' },
  { id: 'browser', page: 'tools', label: 'Browser', terms: 'chrome edge logins' },
  { id: 'browser-path', page: 'tools', label: 'Browser program', terms: 'chrome edge chromium path exe 浏览器 路径' },
  { id: 'computer', page: 'tools', label: 'Computer control', terms: 'mouse keyboard screen desktop' },
  { id: 'mcp-add', page: 'mcp', label: 'Add an MCP server', terms: 'mcp server plugin paste configuration' },
  { id: 'mail-add', page: 'mail', label: 'Add a mailbox', terms: 'email imap smtp gmail outlook' },
  { id: 'mail-send', page: 'mail', label: 'Before an email is sent', terms: 'email send ask' },
  { id: 'remote', page: 'remote', label: 'Remote control', terms: 'phone relay pair' },
  { id: 'awake', page: 'remote', label: 'Staying awake', terms: 'sleep' },
  { id: 'usage', page: 'usage', label: 'Usage', terms: 'tokens usage cost spend models requests statistics chart 用量 统计 费用' },
  { id: 'space', page: 'storage', label: 'Space', terms: 'disk sessions scratch cache clear compress' },
  { id: 'encryption', page: 'storage', label: 'Encryption', terms: 'seal encrypt recovery key' },
  { id: 'recovery-key', page: 'storage', label: 'Recovery key', terms: 'seal encrypt import key' },
];
