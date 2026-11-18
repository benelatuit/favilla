export * from './types';
export { Session, fitEffort, type SessionDeps, type StartOptions } from './agent/session';
export { Catalog, familyDefaults, type ModelInfo, type ResolvedProvider } from './catalog/catalog';
export { loadConfig, loadGlobalConfigRaw, keyPath, updateGlobalConfig, globalConfigPath, DEFAULTS, type FavillaConfig, type ProviderSettings, type ModelSettings } from './config/config';
export { SessionStore, type SessionRecord } from './store/sessions';
export { openInBrowser } from './auth/browser';
export { readAuthFile, updateAuthFile } from './auth/store';
export { checkCommand, type GuardVerdict } from './guard/guard';
export { computeBudget, type Budget } from './context/budget';
export { detectShell, runShell, agentEnv } from './tools/shell';
export { ProviderError } from './providers/errors';
export { appHome, appPath, displayPath, homePath, resolvePath, toForward, isWindows } from './util/paths';
export { newId, randomToken } from './util/id';
export { exitProcess } from './util/proc';
export { fullContent, fullDisplay } from './store/pack';
export { estimateTokens } from './util/tokens';
export { expandMentions } from './prompt/mentions';
export { ATTACHED, attach, pastedBlock, typedPart } from './prompt/attached';
export { findRoot } from './prompt/instructions';
export { activePreset, copyPreset, deletePreset, globalChoice, importPreset, presetsView, setGlobalChoice, setWorkspaceChoice, workspaceChoice, type PresetReport, type PresetScope } from './prompt/preset';
export {
  activePersona,
  deletePersona,
  folderChoice as personaFolderChoice,
  globalChoice as personaGlobalChoice,
  importPersona,
  parseCharacterCard,
  personaText,
  personasView,
  readPersona,
  setFolderChoice as setPersonaFolderChoice,
  setGlobalChoice as setPersonaGlobalChoice,
  writePersona,
  type Persona,
  type PersonaReport,
} from './prompt/persona';
export { runRipgrep } from './tools/ripgrep';
export { oneLine } from './util/text';
export { sameContent, type FileContent } from './util/file-content';
export { makeDiff } from './tools/diffutil';
export { createRuntime, type Runtime } from './runtime';
export { startServer, type ServerHandle, type ServerOptions } from './server/server';
export { withImages } from './store/pack';
export { imageSize, MAX_INGRESS_IMAGE_BYTES, MAX_RAW_INPUT_BYTES, normalizeIngressImage, sniffImageMediaType } from './tools/image';
export { openLines, sealLine } from './store/seal';
export { extensionString, loadExtensions } from './extensions/registry';
export { slowSince } from './util/slow';
export { watchStalls, type Stall } from './util/stall';
export type { Extension, ExtensionSetting } from './extensions/types';
// The package's own version, so a build can never report an older one.
import pkg from '../package.json';
export const VERSION: string = pkg.version;
