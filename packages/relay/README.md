# Favilla relay

Remote control lets a phone use Favilla on your computer from anywhere: the computer and the phone each keep one connection to a relay, which forwards what they send each other. Everything is sealed end to end before it leaves either side (`packages/core/src/remote/e2e.ts`), so the relay passes on messages it cannot read. It also serves the page the phone opens.

Favilla has no relay of its own built in. This folder is one you run yourself, on Cloudflare Workers. A phone on the same Wi-Fi as the computer needs none: Settings > Remote pairs it directly, and the computer serves the page itself (`packages/core/src/remote/lan.ts`).

## Run your own

You need a Cloudflare account; the Workers Free plan is enough. One Durable Object per computer holds its connections and sleeps while they are idle, so an idle phone costs nothing. Past the free plan's daily limits the relay turns connections away until the next day, and nothing is billed.

1. Build the page the phones open (the relay serves `packages/web/dist`):

   ```bash
   pnpm --filter @favilla/web build
   ```

2. In `wrangler.jsonc`, give the relay an address. Either put a domain of yours that is on Cloudflare in `routes`, or remove `routes` and set `"workers_dev": true` to use `favilla-relay.<your account>.workers.dev`.

3. Deploy it from this folder:

   ```bash
   npx wrangler login
   npx wrangler deploy
   ```

4. In Favilla, open Settings > Remote, enter the relay's `https://` address, turn remote control on and press "Pair a phone". Scan the code with the phone's camera.

A build of Favilla can carry a relay address so that nobody has to enter it: set `FAVILLA_DEFAULT_RELAY` while building (`packages/core/scripts/build-defines.mjs`).

## What it does

| Path | |
|---|---|
| `/ws/pc/<id>` | the computer: proves it holds the signing key its id is the hash of, then stays connected |
| `/ws/phone/<id>` | a phone paired with that computer; at most 8 at once, and 30 new connections a minute |
| anything else | the Favilla page, marked so it knows it runs remotely |

The page is served with a strict content security policy and is never shown inside another site's frame, so nobody can trick a tap on an approval.
