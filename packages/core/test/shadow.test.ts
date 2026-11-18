import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Checkpoints } from '../src/agent/checkpoints';
import { Shadow } from '../src/agent/shadow';
import { BlobStore } from '../src/store/blobs';

const top = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-shadow-'));
afterAll(() => fs.rmSync(top, { recursive: true, force: true, maxRetries: 3 }));

function folder(name: string): { work: string; points: Checkpoints; shadow: Shadow } {
  const work = path.join(top, name, 'work');
  fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(work, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(work, 'a.txt'), 'a before\n');
  fs.writeFileSync(path.join(work, 'sub', 'b.txt'), 'b before\n');
  fs.writeFileSync(path.join(work, 'd.txt'), 'd at the start\n');
  fs.writeFileSync(path.join(work, 'node_modules', 'pkg', 'index.js'), 'x');
  const shadow = new Shadow(work, path.join(top, name, 'shadow.git'));
  return { work, shadow, points: new Checkpoints(path.join(top, name, 'checkpoints'), new BlobStore(path.join(top, name, 'blobs')), true, shadow) };
}

describe("the folder's own snapshots", () => {
  it('see what commands changed in a turn, and undo it: changed back, made since deleted, deleted since back', async () => {
    const { work, points } = folder('commands');
    // The user's own repository is there and must be left alone.
    execFileSync('git', ['init', '--quiet'], { cwd: work });
    const userHead = fs.readFileSync(path.join(work, '.git', 'HEAD'), 'utf8');
    await points.begin('t1');
    // What a turn's commands did: sed -i, rm, a generator, an install.
    fs.writeFileSync(path.join(work, 'a.txt'), 'a after\n');
    fs.rmSync(path.join(work, 'sub', 'b.txt'));
    fs.writeFileSync(path.join(work, 'c.txt'), 'made by a script\n');
    fs.writeFileSync(path.join(work, 'node_modules', 'pkg', 'new.js'), 'installed');
    const seen = await points.end('t1');
    const rel = (fs: string[]) => fs.map((f) => path.relative(work, f).split(path.sep).join('/')).sort();
    expect(rel(seen)).toEqual(['a.txt', 'c.txt', 'sub/b.txt']);
    expect(points.turns()).toEqual(['t1']);
    expect(points.changes('t1').find((c) => c.path.endsWith('a.txt'))).toMatchObject({ before: 'a before\n', after: 'a after\n' });

    const restored = points.revertFrom('t1');
    expect(rel(restored)).toEqual(['a.txt', 'c.txt', 'sub/b.txt']);
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('a before\n');
    expect(fs.readFileSync(path.join(work, 'sub', 'b.txt'), 'utf8')).toBe('b before\n');
    expect(fs.existsSync(path.join(work, 'c.txt'))).toBe(false);
    // Installs are not snapshotted, so not undone either; the user's .git is as it was.
    expect(fs.existsSync(path.join(work, 'node_modules', 'pkg', 'new.js'))).toBe(true);
    expect(fs.readFileSync(path.join(work, '.git', 'HEAD'), 'utf8')).toBe(userHead);
  }, 60_000);

  it('undoes to the folder as the turn found it, though a file tool first touched the file after a command had', async () => {
    const { work, points } = folder('mixed');
    await points.begin('t1');
    fs.writeFileSync(path.join(work, 'd.txt'), 'd after a command\n');
    // The file tool's copy is taken now, after the command.
    points.capture('t1', path.join(work, 'd.txt'));
    fs.writeFileSync(path.join(work, 'd.txt'), 'd after the edit\n');
    await points.end('t1');
    // A second turn, by file tool only.
    await points.begin('t2');
    points.capture('t2', path.join(work, 'a.txt'));
    fs.writeFileSync(path.join(work, 'a.txt'), 'a edited\n');
    await points.end('t2');
    expect(points.turns()).toEqual(['t1', 't2']);
    points.revertFrom('t1');
    expect(fs.readFileSync(path.join(work, 'd.txt'), 'utf8')).toBe('d at the start\n');
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('a before\n');
    // Reading the index again (a restart) gives the same turns.
    const again = new Checkpoints(path.join(top, 'mixed', 'checkpoints'), new BlobStore(path.join(top, 'mixed', 'blobs')), true, new Shadow(work, path.join(top, 'mixed', 'shadow.git')));
    expect(again.turns()).toEqual(['t1', 't2']);
  }, 60_000);

  it('keeps the bytes of a file an LFS rule covers, as they are, and puts them back as they were', async () => {
    const { work, points } = folder('lfs');
    fs.writeFileSync(path.join(work, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    const bytes = Buffer.from([0, 1, 2, 3, 13, 10, 255, 254]);
    fs.writeFileSync(path.join(work, 'model.bin'), bytes);
    await points.begin('t1');
    fs.writeFileSync(path.join(work, 'model.bin'), Buffer.from('overwritten by a script'));
    await points.end('t1');
    expect((await points.changesAsync('t1'))[0]).toMatchObject({ via: 'command', before: { bytes: bytes.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }, after: 'overwritten by a script' });
    points.revertFrom('t1');
    expect(fs.readFileSync(path.join(work, 'model.bin')).equals(bytes)).toBe(true);
    // Nothing went through LFS: no objects of its own in the snapshot store.
    expect(fs.existsSync(path.join(top, 'lfs', 'shadow.git', 'lfs'))).toBe(false);
  }, 60_000);

  it.skipIf(process.platform !== 'win32')('keeps the first undo independent of the project object store', async () => {
    const { work, points, shadow } = folder('cold');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: work, windowsHide: true });
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    for (let i = 0; i < 401; i++) fs.writeFileSync(path.join(work, `tracked-${i}.txt`), `already in Git ${i % 4}\n`);
    git('add', 'a.txt', 'tracked-*.txt');
    const file = path.join(work, 'a.txt');
    const original = Buffer.from('unstaged\r\nworking tree\r\n');
    fs.writeFileSync(file, original);
    await points.begin('turn');
    expect(fs.readdirSync(path.join(shadow.dir, 'objects', 'pack')).some((name) => name.endsWith('.pack'))).toBe(true);
    expect(fs.existsSync(path.join(shadow.dir, 'objects', 'info', 'alternates'))).toBe(false);

    // Only the shadow store can supply the bytes from this point on.
    fs.renameSync(path.join(work, '.git'), path.join(path.dirname(work), 'project.git'));
    fs.writeFileSync(file, 'own change\n');
    fs.writeFileSync(path.join(work, 'tracked-0.txt'), 'another own change\n');
    await points.end('turn');
    expect(points.revertFrom('turn').map((f) => path.basename(f)).sort()).toEqual(['a.txt', 'tracked-0.txt']);
    expect(fs.readFileSync(file)).toEqual(original);
    expect(fs.readFileSync(path.join(work, 'tracked-0.txt'), 'utf8')).toBe('already in Git 0\n');
  }, 60_000);

  it.skipIf(process.platform !== 'win32')('does not publish a seeded index while another Git holds the index lock', async () => {
    const { work, shadow } = folder('locked-seed');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: work, windowsHide: true });
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    for (let i = 0; i < 401; i++) fs.writeFileSync(path.join(work, `tracked-${i}.txt`), 'kept\n');
    git('add', 'tracked-*.txt');
    git('init', '--bare', '--quiet', shadow.dir);

    const lock = path.join(shadow.dir, 'index.lock');
    fs.writeFileSync(lock, 'another Git is writing');
    expect(await shadow.snapshot('locked')).toBeNull();
    expect(fs.existsSync(path.join(shadow.dir, 'index'))).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe('another Git is writing');
    fs.unlinkSync(lock);

    const at = await shadow.snapshot('unlocked');
    expect(at && shadow.show(at, 'tracked-0.txt')?.toString('utf8')).toBe('kept\n');
  }, 60_000);

  it('takes no new snapshot when nothing changed, and leaves files over 20 MB out', async () => {
    const { work, shadow } = folder('quiet');
    const a = await shadow.snapshot('one');
    const b = await shadow.snapshot('two');
    expect(a).toBeTruthy();
    expect(b).toBe(a);
    fs.writeFileSync(path.join(work, 'huge.bin'), Buffer.alloc(21 * 1024 * 1024, 1));
    const c = await shadow.snapshot('three');
    expect(await shadow.changed(a!, c!)).toEqual([]);
  }, 60_000);
  it('reads many files of a snapshot in one go, as one by one would: past a batch, spaces, bytes, files not there', async () => {
    const { work, shadow, points } = folder('many');
    fs.writeFileSync(path.join(work, 'with space.txt'), 'spaced\n');
    fs.writeFileSync(path.join(work, 'bytes.dat'), Buffer.from([0, 1, 2, 255, 10, 13, 10]));
    const at = await shadow.snapshot('before');
    expect(at).toBeTruthy();
    const rels = ['a.txt', 'with space.txt', 'bytes.dat', 'sub/b.txt', 'never.txt', ...Array.from({ length: 420 }, (_, i) => `gone${i}.txt`)];
    const one = new Map(rels.map((r) => [r, shadow.show(at!, r)]));
    for (const many of [shadow.showManySync(at!, rels), await shadow.showMany(at!, rels)]) {
      expect([...many.keys()].sort()).toEqual([...rels].sort());
      for (const r of rels) expect(many.get(r), r).toEqual(one.get(r));
    }
    expect(one.get('bytes.dat')).toEqual(Buffer.from([0, 1, 2, 255, 10, 13, 10]));
    expect(one.get('never.txt')).toBeNull();

    // A command's turn read both ways gives the same changes, and again from what was read before.
    await points.begin('t1');
    for (let i = 0; i < 420; i++) fs.writeFileSync(path.join(work, `made${i}.txt`), `made ${i}\n`);
    fs.writeFileSync(path.join(work, 'a.txt'), 'a after\n');
    fs.rmSync(path.join(work, 'with space.txt'));
    await points.end('t1');
    const sync = points.changes('t1');
    expect(sync.find((c) => c.path.endsWith('a.txt'))).toMatchObject({ before: 'a before\n', after: 'a after\n' });
    expect(sync.find((c) => c.path.endsWith('with space.txt'))).toMatchObject({ before: 'spaced\n', after: null });
    expect(sync.find((c) => c.path.endsWith('made7.txt'))).toMatchObject({ before: null, after: 'made 7\n' });
    expect(await points.changesAsync('t1')).toEqual(sync);
    expect(points.changes('t1')).toEqual(sync);
  }, 120_000);

  // An undo whose snapshot is gone (pruned after 30 days, or the folder's snapshots switched off and wiped) had read
  // every path as absent then and deleted it, while it said it had put them back (2026-11-06).
  it('touches nothing it cannot read back when the snapshot is gone, and puts back what the file tools kept', async () => {
    const { work, points, shadow } = folder('gone');
    await points.begin('t1');
    points.capture('t1', path.join(work, 'a.txt'));
    fs.writeFileSync(path.join(work, 'a.txt'), 'a by the edit tool\n');
    fs.writeFileSync(path.join(work, 'd.txt'), 'd by a command\n');
    await points.end('t1');
    // The snapshot is gone: its repository wiped.
    fs.rmSync(shadow.dir, { recursive: true, force: true });
    const restored = points.revertFrom('t1').map((f) => path.basename(f));
    expect(restored).toEqual(['a.txt']);
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('a before\n');
    expect(fs.readFileSync(path.join(work, 'd.txt'), 'utf8')).toBe('d by a command\n');
  });

  // A process killed while it wrote a line of the index leaves the line torn: one torn line had hidden every restore
  // point after it once the session was opened again, and the next line ran into it (2026-11-06).
  it('keeps every restore point after a torn line of its index, and starts the next line on a line of its own', () => {
    const dir = path.join(top, 'torn', 'checkpoints');
    const blobs = new BlobStore(path.join(top, 'torn', 'blobs'));
    const file = path.join(top, 'torn', 'x.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'v1');
    const points = new Checkpoints(dir, blobs, true, null);
    points.capture('t1', file);
    fs.appendFileSync(path.join(dir, 'index.jsonl'), '{"turn":"t2","path":"C:/x","bl');
    for (const t of ['t3', 't4']) points.capture(t, file);
    expect(new Checkpoints(dir, blobs, true, null).turns()).toEqual(['t1', 't3', 't4']);
  });

  // Two sessions in one folder: a turn's paths are all that changed in the folder while it ran, and undoing one
  // session's turn had put back the other's file and deleted the one it had made (2026-11-06).
  it("leaves another session's work alone when it undoes a turn, and undoes its own", async () => {
    const { work, points: a, shadow } = folder('two');
    const b = new Checkpoints(path.join(top, 'two', 'checkpoints-b'), new BlobStore(path.join(top, 'two', 'blobs')), true, new Shadow(work, shadow.dir));
    await a.begin('tA');
    await b.begin('tB');
    a.capture('tA', path.join(work, 'a.txt'));
    fs.writeFileSync(path.join(work, 'a.txt'), 'a by session A\n');
    b.capture('tB', path.join(work, 'sub', 'b.txt'));
    fs.writeFileSync(path.join(work, 'sub', 'b.txt'), 'b by session B\n');
    fs.writeFileSync(path.join(work, 'c.txt'), 'made by session B\n');
    await a.end('tA');
    await b.end('tB');
    expect(a.revertFrom('tA').map((f) => path.basename(f))).toEqual(['a.txt']);
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('a before\n');
    expect(fs.readFileSync(path.join(work, 'sub', 'b.txt'), 'utf8')).toBe('b by session B\n');
    expect(fs.readFileSync(path.join(work, 'c.txt'), 'utf8')).toBe('made by session B\n');
  });

  // A branch keeps its source's restore points for the turns before the branch point: what the source did then is the
  // branch's own work, what it does after is another session's.
  it("undoes a turn kept from the session it branched off, and leaves that session's later work alone", async () => {
    const { work, points: src, shadow } = folder('adopt');
    await src.begin('t1');
    src.capture('t1', path.join(work, 'a.txt'));
    fs.writeFileSync(path.join(work, 'a.txt'), 'a in t1\n');
    fs.writeFileSync(path.join(work, 'c.txt'), 'made by a command in t1\n');
    await src.end('t1');
    const dir = path.join(top, 'adopt', 'checkpoints-branch');
    const blobs = new BlobStore(path.join(top, 'adopt', 'blobs'));
    new Checkpoints(dir, blobs, true, new Shadow(work, shadow.dir)).adopt(src, new Set(['t1']));
    // From its own index, after a restart.
    const branch = new Checkpoints(dir, blobs, true, new Shadow(work, shadow.dir));
    expect(branch.turns()).toEqual(['t1']);
    expect(branch.changes('t1').map((c) => path.basename(c.path)).sort()).toEqual(['a.txt', 'c.txt']);
    // Nothing else since: the turn is undone whole, the command's file too.
    expect(branch.revertFrom('t1').map((f) => path.basename(f)).sort()).toEqual(['a.txt', 'c.txt']);
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('a before\n');
    expect(fs.existsSync(path.join(work, 'c.txt'))).toBe(false);

    // The source goes on after the branch: its new work is left as it is.
    fs.writeFileSync(path.join(work, 'a.txt'), 'a in t1\n');
    await new Promise((r) => setTimeout(r, 5));
    await src.begin('t2');
    src.capture('t2', path.join(work, 'sub', 'b.txt'));
    fs.writeFileSync(path.join(work, 'sub', 'b.txt'), 'b by the source after the branch\n');
    await src.end('t2');
    expect(branch.revertFrom('t1').map((f) => path.basename(f))).toEqual(['a.txt']);
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('a before\n');
    expect(fs.readFileSync(path.join(work, 'sub', 'b.txt'), 'utf8')).toBe('b by the source after the branch\n');
  });
});

describe('pruning the snapshots', () => {
  // Snapshot refs carry the app's name as it was when they were written; those of a former name age like any.
  it('drops refs past the cutoff under any name, and keeps the recent ones', async () => {
    const { work, points, shadow } = folder('prune');
    await points.begin('t1');
    fs.writeFileSync(path.join(work, 'a.txt'), 'a after\n');
    await points.end('t1');
    const git = (...args: string[]) => execFileSync('git', ['--git-dir', shadow.dir, ...args], { encoding: 'utf8' }).trim();
    const refs = () => git('for-each-ref', '--format=%(refname)').split('\n').filter(Boolean).sort();
    const recent = refs();
    expect(recent.length).toBeGreaterThan(0);
    const commit = git('rev-parse', recent[0]);
    git('update-ref', `refs/older/1000-${commit.slice(0, 8)}`, commit);
    git('update-ref', `refs/favilla/2000-${commit.slice(0, 8)}`, commit);
    await shadow.prune(30);
    expect(refs()).toEqual(recent);
  }, 60_000);
});
