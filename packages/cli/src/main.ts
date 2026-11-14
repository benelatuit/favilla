#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import {
  createRuntime as makeRuntime,
  startServer,
  openInBrowser,
  updateGlobalConfig,
  globalConfigPath,
  keyPath,
  loadConfig,
  appPath,
  exitProcess,
  VERSION,
  type Effort,
  type Mode,
} from '@favilla/core';
import { runHeadless } from './headless';
import { promptWordsLast } from './args';
import { SettingsError } from '@favilla/core/config/document';
import { printSettingError, printSettingNotice, setLanguage } from './tui/i18n';

function createRuntime(...args: Parameters<typeof makeRuntime>) {
  const rt = makeRuntime(...args);
  setLanguage(rt.config.language);
  for (const notice of rt.settingsNotices) printSettingNotice(notice);
  rt.subscribeSettings(printSettingNotice);
  return rt;
}

const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// A stray error from a socket or a library must not end a long run without a trace: log it and keep going.
function logStray(kind: string, e: unknown): void {
  try {
    const file = appPath('logs', 'cli.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${kind}: ${(e as Error)?.stack ?? String(e)}\n`);
  } catch {
    /* logging must not fail the run */
  }
  process.stderr.write(`\n[favilla] ${kind}: ${(e as Error)?.message ?? String(e)} (details in ${appPath('logs', 'cli.log')})\n`);
}
process.on('uncaughtException', (e) => logStray('uncaught exception', e));
process.on('unhandledRejection', (e) => logStray('unhandled rejection', e));

function webDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.FAVILLA_WEB, path.join(here, 'web'), path.resolve(here, '../../web/dist'), path.resolve(here, '../web/dist')];
  return candidates.find((c) => c && fs.existsSync(path.join(c, 'index.html')));
}

/**
 * Piped input joins the prompt. When the prompt came as arguments and the pipe stays silent (a script or
 * scheduler that leaves stdin open), the run does not wait on it: three seconds without a first byte and
 * stdin is ignored. With no prompt in the arguments, stdin is the prompt, so it is read however long it takes.
 */
async function readStdin(havePrompt: boolean): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(idle);
      process.stdin.off('data', onData);
      process.stdin.off('end', finish);
      process.stdin.off('error', finish);
      if (!chunks.length) process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (c: Buffer) => {
      clearTimeout(idle);
      chunks.push(c);
    };
    const idle = havePrompt ? setTimeout(finish, 3000) : undefined;
    process.stdin.on('data', onData);
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
  });
}

const program = new Command();
program
  .name('favilla')
  .description('A general-purpose AI agent for the terminal, the browser and the desktop.')
  .version(VERSION)
  .argument('[prompt...]', 'start with this prompt')
  .option('-p, --print', 'run the prompt without the interactive UI and print the answer')
  .option('-m, --model <provider/model>', 'model to use, e.g. openai/gpt-6-luna')
  .addOption(new Option('-e, --effort <level>', 'reasoning effort').choices(EFFORTS))
  .addOption(new Option('--mode <mode>', 'start in build or plan mode').choices(['build', 'plan']))
  .option('-C, --cwd <dir>', 'working directory')
  .option('-r, --resume <id>', 'continue a saved session')
  .option('-c, --continue', 'continue the most recent session in this folder')
  .addOption(new Option('--output <format>', 'output for --print').choices(['text', 'json', 'stream-json']).default('text'))
  .option('--yolo', 'run every command without asking, including destructive ones')
  .option('-q, --quiet', 'print only the answer')
  .option('--summary-file <path>', 'write a JSON summary of the run to this file')
  .action(async (words: string[], o) => {
    const cwd = path.resolve(o.cwd ?? process.cwd());
    const rt = createRuntime(cwd);
    if (o.yolo) rt.config.guard = { ...(rt.config.guard ?? {}), mode: 'off' };
    let resume: string | undefined = o.resume;
    if (o.continue) resume = rt.store.list({ cwd, limit: 1 })[0]?.id;
    // Open in another Favilla (the app, another terminal): two writers would interleave its turns.
    const holder = resume ? rt.store.locks.holder(resume) : null;
    if (resume && holder) {
      console.error(`Session ${resume} is open in another Favilla (process ${holder.pid}): two at once would mix their turns. The app lets a session go after 15 minutes unused; or start a new session without -c.`);
      exitProcess(1);
      return;
    }
    const stdin = await readStdin(words.join(' ').trim().length > 0);
    const prompt = [words.join(' '), stdin].filter((s) => s.trim()).join('\n\n');
    if (o.print || !process.stdout.isTTY) {
      if (!prompt) {
        console.error('Nothing to do: give a prompt.');
        exitProcess(2);
        return;
      }
      const code = await runHeadless(rt, { prompt, cwd, model: o.model, effort: o.effort as Effort, mode: o.mode as Mode, output: o.output, resume, quiet: o.quiet, summaryFile: o.summaryFile });
      await rt.shutdown();
      exitProcess(code);
      return;
    }
    const { runTui } = await import('./tui/app');
    await runTui(rt, { cwd, prompt, model: o.model, effort: o.effort as Effort, mode: o.mode as Mode, resume });
  });

program
  .command('login')
  .description('show where to set the API key of a provider')
  .argument('<provider>', 'provider id')
  .action((provider: string) => {
    console.log(`Set an API key for ${provider} in ${globalConfigPath()} (providers.${provider}.apiKey) or its environment variable.`);
  });

program
  .command('models')
  .description('list available models')
  .argument('[provider]', 'only this provider')
  .option('--refresh', 'ask providers again instead of using the cache')
  .action(async (provider: string | undefined, o) => {
    const rt = createRuntime();
    for (const p of rt.catalog.providers()) {
      if (provider && p.id !== provider) continue;
      const ready = rt.catalog.isConfigured(p);
      if (!ready && !provider) continue;
      const models = ready ? await rt.catalog.discover(p.id, !!o.refresh) : [];
      console.log(`\n${p.name} (${p.id})${ready ? '' : ' — not configured'}${rt.catalog.discoveryError(p.id) ? ` — ${rt.catalog.discoveryError(p.id)}` : ''}`);
      for (const m of models) console.log(`  ${m.ref.padEnd(46)} ${String(Math.round(m.contextWindow / 1000)).padStart(5)}k  ${m.efforts.join('/') || '-'}`);
    }
  });

program
  .command('mcp')
  .description('connect the MCP servers in the config and list their tools')
  .action(async () => {
    const rt = createRuntime();
    if (!rt.mcp.configured) {
      console.log(`No MCP servers configured. Add them under "mcpServers" in ${globalConfigPath()}.`);
      return;
    }
    await rt.mcp.start();
    for (const s of rt.mcp.status()) {
      const state = s.state === 'ready' ? `${s.tools.length} tools` : s.state === 'failed' ? `failed: ${s.error}` : s.state;
      console.log(`${s.name.padEnd(24)} ${state}`);
      if (s.state === 'ready') for (const t of s.tools) console.log(`  mcp__${s.name}__${t}`);
    }
    await rt.mcp.close();
    exitProcess(0);
  });

program
  .command('sessions')
  .description('list saved sessions')
  .option('-a, --all', 'all folders')
  .action((o) => {
    const rt = createRuntime();
    for (const m of rt.store.list({ cwd: o.all ? undefined : process.cwd(), limit: 40 })) {
      console.log(`${m.id}  ${new Date(m.updated).toLocaleString()}  ${m.model.padEnd(24)} ${m.title}`);
    }
  });

program
  .command('web')
  .description('open the browser UI')
  .option('--port <port>', 'port', '0')
  .option('--host <host>', 'interface to listen on', '127.0.0.1')
  .option('--no-open', 'do not open a browser')
  .option('--token <token>', 'access token (default: random)')
  .action(async (o) => {
    const rt = createRuntime(process.cwd(), { interactive: true });
    const server = await startServer({ runtime: rt, port: Number(o.port), host: o.host, webDir: webDir(), version: VERSION, token: o.token ?? process.env.FAVILLA_TOKEN });
    rt.housekeeping({ evictAfterMs: 15 * 60_000 });
    const url = `${server.url}?token=${server.token}`;
    console.log(`Favilla is running at ${url}`);
    if (o.open) openInBrowser(url);
    const stop = async () => {
      await server.close();
      await rt.shutdown();
      exitProcess(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

program
  .command('config')
  .description('read or change settings in config.json')
  .argument('[key]', 'dotted key, e.g. model or providers.local.baseUrl; quote a new key with dots: models."gpt-6.1-sol"')
  .argument('[value]', 'new value (JSON or text)')
  .action((key?: string, value?: string) => {
    if (!key) return console.log(globalConfigPath());
    if (value === undefined) {
      const cfg = createRuntime().config as Record<string, unknown>;
      const v = keyPath(cfg, key).reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], cfg);
      return console.log(JSON.stringify(v, null, 2));
    }
    let parsed: unknown = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      /* plain string */
    }
    const config = loadConfig();
    setLanguage(config.language);
    updateGlobalConfig({}, [[keyPath(config, key), parsed]]);
    console.log(`${key} = ${JSON.stringify(parsed)}`);
  });

const takesValue = (flag: string) => program.options.some((o) => (o.short === flag || o.long === flag) && (o.required || o.optional));
const isCommand = (word: string) => program.commands.some((c) => c.name() === word || c.aliases().includes(word));
program.parseAsync([...process.argv.slice(0, 2), ...promptWordsLast(process.argv.slice(2), takesValue, isCommand)]).catch((e) => {
  if (e instanceof SettingsError) printSettingError(e.problem);
  else console.error(e instanceof Error ? e.message : e);
  exitProcess(1);
});
