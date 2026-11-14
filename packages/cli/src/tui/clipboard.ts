import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImagePart } from '@favilla/core';
import { resolvePath } from '@favilla/core';

/** Images a provider takes without complaint; a larger screenshot is re-encoded as JPEG first. */
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

type ClipboardImage = { image: ImagePart } | { files: string[] } | { none: true } | { error: string };

function run(cmd: string, args: string[], timeout = 15_000): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'buffer', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: stdout ?? Buffer.alloc(0), stderr: String(stderr ?? '') });
    });
  });
}

/** PowerShell's clipboard reader: a picture is saved (as JPEG when the PNG is too big), copied files are listed. */
export function windowsScript(png: string, jpg: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return [
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    'if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
    '  $img = [System.Windows.Forms.Clipboard]::GetImage()',
    `  $img.Save(${q(png)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    `  if ((Get-Item ${q(png)}).Length -gt ${Math.floor(MAX_IMAGE_BYTES)}) {`,
    "    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    '    $p = New-Object System.Drawing.Imaging.EncoderParameters 1',
    '    $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 88L',
    `    $img.Save(${q(jpg)}, $enc, $p)`,
    "    'jpeg'",
    "  } else { 'png' }",
    '} elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
    '  [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { "file:$_" }',
    "} else { 'none' }",
  ].join('\n');
}

/**
 * The picture on the system clipboard (a screenshot, an image copied from a page), or the image files copied in
 * a file manager. Terminals paste only text, so this asks the system itself: PowerShell on Windows, osascript
 * on macOS, wl-paste or xclip on Linux.
 */
export async function readClipboardImage(): Promise<ClipboardImage> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-paste-'));
  const png = path.join(dir, 'clipboard.png');
  const jpg = path.join(dir, 'clipboard.jpg');
  try {
    if (process.platform === 'win32') {
      const encoded = Buffer.from(windowsScript(png, jpg), 'utf16le').toString('base64');
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded]);
      const out = r.stdout.toString('utf8').trim();
      if (r.code && !out) return { error: r.stderr.trim().split('\n')[0] || `powershell exited ${r.code}` };
      if (out === 'png' || out === 'jpeg') return { image: fromFile(out === 'png' ? png : jpg, 'clipboard') };
      const files = out.split(/\r?\n/).filter((l) => l.startsWith('file:')).map((l) => l.slice(5).trim());
      return files.length ? { files } : { none: true };
    }
    if (process.platform === 'darwin') {
      const r = await run('osascript', [
        '-e', `set p to POSIX file "${png.replace(/"/g, '\\"')}"`,
        '-e', 'try',
        '-e', 'set d to (the clipboard as «class PNGf»)',
        '-e', 'on error',
        '-e', 'return "none"',
        '-e', 'end try',
        '-e', 'set f to open for access p with write permission',
        '-e', 'write d to f',
        '-e', 'close access f',
        '-e', 'return "png"',
      ]);
      const out = r.stdout.toString('utf8').trim();
      if (out === 'png' && fs.existsSync(png)) return { image: fromFile(png, 'clipboard') };
      return r.code ? { error: r.stderr.trim() || 'osascript failed' } : { none: true };
    }
    // Linux: Wayland first, then X11.
    for (const [cmd, args] of [
      ['wl-paste', ['--no-newline', '--type', 'image/png']],
      ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
    ] as const) {
      const r = await run(cmd, [...args]);
      if (!r.code && r.stdout.length > 8 && r.stdout.subarray(0, 4).toString('hex') === '89504e47') {
        fs.writeFileSync(png, r.stdout);
        return { image: fromFile(png, 'clipboard') };
      }
    }
    return { none: true };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Put text on the system clipboard. Falls back to OSC 52, which asks the terminal itself to do it (Windows
 * Terminal, iTerm2, kitty and most terminals over SSH).
 */
export async function copyText(text: string): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-copy-'));
  const file = path.join(dir, 'text.txt');
  fs.writeFileSync(file, text, 'utf8');
  try {
    let ok = false;
    if (process.platform === 'win32') {
      const q = file.replace(/'/g, "''");
      const script = `Set-Clipboard -Value ([IO.File]::ReadAllText('${q}', [Text.Encoding]::UTF8))`;
      ok = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])).code === 0;
    } else {
      for (const [cmd, args] of [
        ['pbcopy', []],
        ['wl-copy', []],
        ['xclip', ['-selection', 'clipboard']],
      ] as const) {
        if (await pipeTo(cmd, [...args], text)) {
          ok = true;
          break;
        }
      }
    }
    if (!ok && process.stdout.isTTY) {
      process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
      ok = true;
    }
    return ok;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pipeTo(cmd: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
      child.stdin?.end(input);
    } catch {
      resolve(false);
    }
  });
}

function fromFile(file: string, name?: string): ImagePart {
  const ext = path.extname(file).toLowerCase();
  return { type: 'image', mediaType: TYPES[ext] ?? 'image/png', data: fs.readFileSync(file).toString('base64'), name: name ? `${name}${ext}` : path.basename(file) };
}

/** An image file by path, if it is one Favilla can send. */
export function imageFile(file: string): ImagePart | { error: string } | null {
  const ext = path.extname(file).toLowerCase();
  if (!TYPES[ext]) return null;
  let size: number;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }
  if (size > MAX_IMAGE_BYTES) return { error: path.basename(file) };
  return fromFile(file);
}

/**
 * Pasted text that is nothing but paths to image files, as a terminal pastes a file dragged onto it: quoted
 * when it has spaces, sometimes as a file:// address. Returns those paths, or null for ordinary text.
 */
export function pastedImagePaths(text: string, cwd: string): string[] | null {
  const t = text.trim();
  if (!t || t.length > 4000 || t.includes('\n')) return null;
  const parts = t.match(/"[^"]+"|'[^']+'|(?:\\ |\S)+/g) ?? [];
  const paths: string[] = [];
  for (const raw of parts) {
    let p = raw.replace(/^["']|["']$/g, '');
    if (p.startsWith('file://')) {
      try {
        p = decodeURIComponent(new URL(p).pathname).replace(/^\/([a-zA-Z]:)/, '$1');
      } catch {
        return null;
      }
    }
    // Shells escape spaces in a dragged path with a backslash on macOS and Linux.
    if (process.platform !== 'win32') p = p.replace(/\\ /g, ' ');
    const abs = resolvePath(cwd, p);
    if (!TYPES[path.extname(abs).toLowerCase()] || !fs.existsSync(abs)) return null;
    paths.push(abs);
  }
  return paths.length ? paths : null;
}
