import type { FavillaConfig } from '../config/config';
import type { Mode } from '../types';
import type { ToolBinding } from '../tools/types';

/**
 * A part of Favilla kept in a folder of its own (packages/core/extensions/<name>) so that a build can leave it out:
 * the rest of Favilla names nothing of it, and works the same without it. It brings tools for the main agent, what a
 * message of the user's needs from them, its settings and the words of its cards.
 */
export interface Extension {
  /** A short name; its settings and words are known under it. */
  name: string;
  /** Tools of the main agent, the same on every surface. */
  tools?: ExtensionTool[];
  /** A message the user sent the main agent: held-back tools it needs loaded with it, and notes to send with it. */
  onMessage?(m: MessageFacts): { load?: string[]; notes?: string[] } | void;
  /** Choices in Settings > Tools, kept in the config under their own keys. */
  settings?: ExtensionSetting[];
  /** Its words in other languages, for its cards and settings: language (zh-CN) → English text → translation. */
  strings?: Record<string, Record<string, string>>;
}

export interface ExtensionTool {
  binding: ToolBinding;
  /** Placed right after the tool of this name; at the end when there is none. */
  after?: string;
  /** Listed in short until a message needs it (onMessage's load) or the model loads it. */
  deferred?: boolean;
}

export interface MessageFacts {
  text: string;
  mode: Mode;
  config: FavillaConfig;
  /** A tool of this name has been called in this conversation. */
  called(tool: string): boolean;
  /** True the first time this key is asked for in this session: for a note that comes once. */
  once(key: string): boolean;
}

export interface ExtensionSetting {
  /** The config key it is kept under (a top-level key of ~/.favilla/config.json). */
  key: string;
  label: string;
  note?: string;
  options: { value: string; label: string }[];
  /** What it is when the config does not set it. */
  value: string;
  /** Kept in the config as a number. */
  number?: boolean;
}

/** A config value an extension keeps under its own key. */
export function settingOf(config: FavillaConfig, key: string): unknown {
  return (config as unknown as Record<string, unknown>)[key];
}
