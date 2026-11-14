const fs = require('node:fs');
const { fileURLToPath, pathToFileURL } = require('node:url');

const log = (line) => fs.appendFileSync(process.argv[2], line + '\n');
const closed = new Set();
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
};

function receive({ id, method, params }) {
  if (method === 'initialize') return send({ id, result: { capabilities: { textDocumentSync: 1 } } });
  if (!method.startsWith('textDocument/')) return;
  const { uri, version, text } = params.textDocument;
  const legacy = uri.endsWith('/legacy.py');
  const publication = uri.endsWith('/alias.py') ? pathToFileURL(fs.realpathSync(fileURLToPath(uri))).href : uri;
  const publish = (diagnostics, v = version) => send({
    method: 'textDocument/publishDiagnostics',
    params: { uri: publication, diagnostics, ...(legacy || v === undefined ? {} : { version: v }) },
  });
  log(method);
  if (method.endsWith('/didClose')) {
    closed.add(uri);
    setTimeout(() => { publish([]); log('late'); }, 20);
    return;
  }
  if (uri.endsWith('/never.py')) return;
  const source = text ?? params.contentChanges[0].text;
  const fresh = source.includes('wrong') ? [{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1, message: 'Fixture error',
  }] : [];
  if (closed.has(uri)) publish([]); // The old peer can also publish after a new didOpen.
  if (!legacy && version > 1) {
    publish([], version - 1);
    setTimeout(() => publish(fresh), 25);
  } else publish(fresh);
}

let pending = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const end = pending.indexOf('\r\n\r\n');
    if (end < 0) break;
    const length = Number(/Content-Length: (\d+)/.exec(pending.subarray(0, end).toString())[1]);
    if (pending.length < end + 4 + length) break;
    receive(JSON.parse(pending.subarray(end + 4, end + 4 + length).toString('utf8')));
    pending = pending.subarray(end + 4 + length);
  }
});
