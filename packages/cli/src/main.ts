#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
  displayPath,
  exitProcess,
  MAX_RAW_INPUT_BYTES,
  normalizeIngressImage,
  sniffImageMediaType,
  VERSION,
  type Effort,
  type ImagePart,
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
const IMAGE_TYPES: Record<string, ImagePart['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

async function loadCliImage(raw: string, cwd: string): Promise<ImagePart> {
  const abs = path.resolve(cwd, raw);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`Image file not found: ${raw}`);
  const st = fs.statSync(abs);
  if (st.size > MAX_RAW_INPUT_BYTES) throw new Error(`Image ${raw} is ${(st.size / 1048576).toFixed(1)} MB (limit is 40 MB).`);
  const buf = fs.readFileSync(abs);
  const declared = IMAGE_TYPES[path.extname(abs).toLowerCase()] ?? sniffImageMediaType(buf);
  if (!declared) throw new Error(`Unsupported image format: ${raw} (expected .png, .jpg, .jpeg, .gif, .webp, or .bmp)`);
  const norm = await normalizeIngressImage(buf, declared);
  const rel = displayPath(cwd, abs);
  const inWorkspace = !path.isAbsolute(rel) && !rel.startsWith('..');
  return {
    type: 'image',
    mediaType: norm.mediaType,
    data: norm.buf.toString('base64'),
    name: path.basename(abs),
    ...(norm.width && norm.height ? { width: norm.width, height: norm.height } : {}),
    ...(inWorkspace ? { sourcePath: rel, sourceSha256: createHash('sha256').update(buf).digest('hex') } : {}),
  };
}

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
  .option('-i, --image <path>', 'attach an image file to the prompt (repeatable)', (v: string, prev: string[]) => [...prev, v], [])
  .option('--summary-file <path>', 'write a JSON summary of the run to this file')
  .option('--mcp-only <url>', 'with --print: use only the tools of this loopback MCP server')
  .option('--token-limit <count>', 'with --print: stop when reported cumulative input plus output exceeds this limit')
  .option('--wait-jobs', 'with --print: after the turn, wait for background commands the agent started and carry on when they end')
  .option('--wait-jobs-limit <minutes>', 'most minutes --wait-jobs waits in all', '480')
  .action(async (words: string[], o) => {
    const cwd = path.resolve(o.cwd ?? process.cwd());
    const images = await Promise.all(((o.image ?? []) as string[]).map((f) => loadCliImage(f, cwd)));
    if (o.mcpOnly) {
      const u = new URL(o.mcpOnly);
      if (!o.print || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.protocol !== 'http:' || u.username || u.password || u.search || u.hash)
        throw new Error('--mcp-only requires --print and a local HTTP address without inline credentials.');
    }
    const tokenLimit = o.tokenLimit === undefined ? undefined : Number(o.tokenLimit);
    if (tokenLimit !== undefined && (!o.print || !Number.isSafeInteger(tokenLimit) || tokenLimit <= 0))
      throw new Error('--token-limit requires --print and a positive integer.');
    const rt = createRuntime(cwd, o.mcpOnly ? { exclusiveMcp: o.mcpOnly } : {});
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
    const stdin = await readStdin(words.join(' ').trim().length > 0 || images.length > 0);
    const prompt = [words.join(' '), stdin].filter((s) => s.trim()).join('\n\n');
    if (o.print || !process.stdout.isTTY) {
      if (!prompt && !images.length) {
        console.error('Nothing to do: give a prompt.');
        exitProcess(2);
        return;
      }
      const waitJobs = o.waitJobs ? Number(o.waitJobsLimit) : undefined;
      if (waitJobs !== undefined && !(waitJobs > 0)) {
        console.error(`--wait-jobs-limit takes a number of minutes above 0, not "${o.waitJobsLimit}".`);
        exitProcess(2);
        return;
      }
      const code = await runHeadless(rt, { prompt, images: images.length ? images : undefined, cwd, model: o.model, effort: o.effort as Effort, mode: o.mode as Mode, output: o.output, resume, quiet: o.quiet, summaryFile: o.summaryFile, waitJobsMinutes: waitJobs, tokenLimit });
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
    let listed = 0;
    for (const p of rt.catalog.providers()) {
      if (provider && p.id !== provider) continue;
      const ready = rt.catalog.isConfigured(p);
      if (!ready && !provider) continue;
      listed++;
      const models = ready ? await rt.catalog.discover(p.id, !!o.refresh) : [];
      console.log(`\n${p.name} (${p.id})${ready ? '' : ' — not configured'}${rt.catalog.discoveryError(p.id) ? ` — ${rt.catalog.discoveryError(p.id)}` : ''}`);
      for (const m of models) console.log(`  ${m.ref.padEnd(46)} ${String(Math.round(m.contextWindow / 1000)).padStart(5)}k  ${m.efforts.join('/') || '-'}`);
    }
    if (listed) return;
    console.error(provider ? `No provider "${provider}". \`favilla models\` lists the ones set up.` : `No provider is set up. Add an API key in ${globalConfigPath()}.`);
    process.exitCode = 1;
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
    const list = rt.store.list({ cwd: o.all ? undefined : process.cwd(), limit: 40 });
    if (!list.length) return console.log(o.all ? 'No saved sessions.' : 'No saved sessions in this folder. `favilla sessions -a` lists every folder.');
    for (const m of list) console.log(`${m.id}  ${new Date(m.updated).toLocaleString()}  ${m.model.padEnd(24)} ${m.title || 'untitled'}`);
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
