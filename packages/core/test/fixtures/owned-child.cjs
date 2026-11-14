const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [mode, root, kind = '', size = '0'] = process.argv.slice(2);
const file = (name) => path.join(root, name);
const mark = (name) => fs.writeFileSync(file(name), String(process.pid));
function start(mode, detached = false) {
  const child = spawn(process.execPath, [__filename, mode, root, kind], { detached, windowsHide: true, stdio: 'ignore' });
  child.unref();
}

function hold() {
  // Finite even when used on a runner whose containment failed.
  setTimeout(() => process.exit(0), 20_000).unref();
  const poll = setInterval(() => {
    if (fs.existsSync(file('finish'))) {
      mark('finished');
      clearInterval(poll);
    }
  }, 20);
}

switch (mode) {
  case 'root':
    start('middle');
    mark('root');
    hold();
    break;
  case 'middle':
    start('leaf', kind !== 'ignores');
    mark('middle');
    if (kind !== 'orphan') hold();
    break;
  case 'leaf':
    process.on('SIGTERM', () => {});
    mark('leaf');
    hold();
    break;
  case 'gate':
    mark(kind || 'job');
    hold();
    break;
  case 'mcp':
    mark('mcp');
    process.stdin.resume();
    hold();
    break;
  case 'watch': {
    const watcher = fs.watch(file('many'), { recursive: true }, () => {});
    setTimeout(() => watcher.close(), 20_000).unref();
    mark('watch');
    break;
  }
  case 'flood': {
    if (kind === 'hold') {
      hold();
      process.stdin.once('data', () => {
        process.stderr.end('\nstderr: 通过\n');
        process.stdin.destroy();
      });
    }
    let left = Number(size);
    const chunk = Buffer.alloc(64 * 1024, 120);
    const write = () => {
      while (left > 0) {
        const count = Math.min(chunk.length, left);
        left -= count;
        if (!process.stdout.write(chunk.subarray(0, count))) return process.stdout.once('drain', write);
      }
      process.stdout.end('\nOutput complete.\n');
    };
    write();
    break;
  }
}
