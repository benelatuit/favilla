import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n';
import { remote, remoteMode, type RemoteState } from '../lib/remote';

export function useRemoteState(): RemoteState | null {
  const [s, setS] = useState<RemoteState | null>(remoteMode ? remote.state : null);
  useEffect(() => (remoteMode ? remote.onState(setS) : undefined), []);
  return s;
}

/**
 * On a phone, what stands before the window: how to pair, why the computer turned it away, or that the computer is
 * not there. Once the channel is open the window takes over.
 */
export function RemoteGate({ state }: { state: RemoteState }) {
  const t = useT();
  const title = state === 'unpaired' ? t('Connect to your computer') : state === 'refused' ? t('The computer did not let this phone in') : state === 'offline' ? t('Your computer is not online') : t('Connecting to your computer…');
  const body =
    state === 'unpaired'
      ? t('On the computer, open Favilla, go to Settings > Remote, turn it on and press "Pair a phone". Then scan the QR with this phone’s camera.')
      : state === 'refused'
        ? `${remote.error} ${t('Pair this phone again from Settings > Remote on the computer.')}`
        : state === 'offline'
          ? t('It connects by itself once the computer is on and Favilla is open there.')
          : t('Everything between this phone and the computer is sealed end to end.');
  return (
    <div className="remote-gate">
      <img src="./icon.png" alt="" className="remote-gate-mark" />
      <h1>{title}</h1>
      <p>{body}</p>
      {state === 'connecting' && <span className="spindle" aria-hidden />}
    </div>
  );
}
