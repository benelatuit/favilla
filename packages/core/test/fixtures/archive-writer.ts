import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { SessionStore } from '../../src/store/sessions';
import { setSealing } from '../../src/store/seal';

const root = process.argv[2];
setSealing(false);
const store = new SessionStore(path.join(root, 'archive'));
const meta = store.metaOf('archive')!;
fs.writeFileSync(path.join(root, 'ready'), '');
for (const until = Date.now() + 5000; !fs.existsSync(path.join(root, 'publish')); ) {
  if (Date.now() >= until) throw new Error('Archive did not reach publication');
  await wait(5);
}
store.saveMessage(meta, { id: 'during', role: 'user', time: 2, parts: [{ type: 'text', text: 'Saved during publication.' }] });
fs.writeFileSync(path.join(root, 'written'), '');
