import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export async function requireRunAsNode(executable, configured) {
  const reason = 'Favilla background jobs require Electron to honor ELECTRON_RUN_AS_NODE (the RunAsNode fuse).';
  // electron-builder applies the configured fuses after afterPack, so check both the setting and the binary.
  if (configured === false) throw new Error(reason);
  const builder = createRequire(require.resolve('electron-builder'));
  const { getCurrentFuseWire, FuseVersion, FuseV1Options } = createRequire(builder.resolve('app-builder-lib'))('@electron/fuses');
  const wire = await getCurrentFuseWire(executable).catch((cause) => { throw new Error(reason, { cause }); });
  if (wire.version !== FuseVersion.V1 || wire[FuseV1Options.RunAsNode] !== '1'.charCodeAt(0)) throw new Error(reason);
}
