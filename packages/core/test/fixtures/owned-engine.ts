import fs from 'node:fs';
import path from 'node:path';
import { createRuntime } from '../../src/runtime';

const root = process.argv[2];
const rt = createRuntime(root, { interactive: true });
const session = await rt.start({ cwd: root });
await session.send('Start the fixture job.');
rt.store.flushIndex();
fs.writeFileSync(path.join(root, 'session'), session.id);
setInterval(() => {}, 1000);
