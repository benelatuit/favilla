import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildDpapi(dist) {
  if (process.platform !== 'win32') return;
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework/v4.0.30319/csc.exe');
  if (!fs.existsSync(compiler)) {
    throw new Error(`Windows packaging needs the .NET Framework C# compiler at ${compiler} to build native/dpapi.exe. Install the .NET Framework build tools before packaging.`);
  }
  const native = path.join(dist, 'native');
  fs.mkdirSync(native, { recursive: true });
  execFileSync(compiler, ['/nologo', '/optimize+', '/reference:System.Security.dll', `/out:${path.join(native, 'dpapi.exe')}`,
    fileURLToPath(new URL('./dpapi.cs', import.meta.url))], { windowsHide: true });
}
