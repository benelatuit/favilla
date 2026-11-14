import type { AddressInfo, Server } from 'node:net';

// Ports a browser refuses to open (Chromium's restricted list, which Firefox, Electron and fetch share) that an OS can
// hand out for port 0. Windows starts that range at 1024 on some machines, so a page served on a random port could
// land on 1720 or 6000 and never load: the browser answers ERR_UNSAFE_PORT, fetch "bad port", without asking the server.
const REFUSED = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

export function browserRefuses(port: number): boolean {
  return port < 1024 || REFUSED.has(port);
}

/** Listens on a free port that a browser will open, and gives the port. */
export async function listenForBrowser(server: Server, host = '127.0.0.1'): Promise<number> {
  for (let tries = 1; ; tries++) {
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
    if (!browserRefuses(port) || tries >= 20) return port;
    await new Promise<void>((r) => server.close(() => r()));
  }
}
