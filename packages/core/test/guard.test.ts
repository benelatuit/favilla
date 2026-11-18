import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { checkCommand, outsideArgs, outsidePath, type GuardContext } from '../src/guard/guard';

const ws = path.join(os.tmpdir(), 'favilla-guard-ws', 'project');
const ctx = { cwd: ws, workspace: ws };
const verdict = (cmd: string) => checkCommand(cmd, ctx).action;

describe('guard: commands that must ask first', () => {
  it.each([
    'rm -rf /',
    'rm -rf ~',
    'rm -rf ~/',
    'sudo rm -rf /usr',
    'rm -rf .',
    'rm -rf *',
    'rm -rf ./*',
    'rm -rf ..',
    'rm -rf ../other-project',
    'rm -rf "$DIR"/',
    'rm -rf .git',
    'rm ~/.ssh/id_ed25519',
    'git reset --hard HEAD~3',
    'git clean -fdx',
    'git checkout -- .',
    'git restore src/app.ts',
    'git push --force origin main',
    'git push -f',
    'git stash clear',
    'git branch -D feature',
    'mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/sda',
    'shutdown -h now',
    'taskkill /F /IM node.exe',
    'pkill python',
    'npm publish',
    'psql -c "DROP TABLE users"',
    'cd src && rm -rf ../..',
    'bash -c "rm -rf ~"',
    'echo $(rm -rf /)',
    'find / -name "*.log" -delete',
    'docker system prune -a',
  ])('%s', (cmd) => {
    expect(verdict(cmd)).toBe('confirm');
  });
});

describe('guard: ordinary work runs without asking', () => {
  it.each([
    'rm -rf node_modules',
    'rm -rf dist build',
    'rm src/old.ts',
    'rm -rf /tmp/favilla-test',
    'git status',
    'git diff HEAD~1',
    'git commit -am "fix"',
    'git push origin feature',
    'git checkout -b feature',
    'git restore --staged src/app.ts',
    'git clean -n',
    'npm test',
    'pnpm install',
    'python -m pytest -q',
    'kill 12345',
    'taskkill /PID 4242 /F',
    'grep -rn "rm -rf" docs/',
    'echo "rm -rf /" > notes.txt',
    'cargo build --release',
    'psql -c "select * from users"',
  ])('%s', (cmd) => {
    expect(verdict(cmd)).toBe('allow');
  });

  it('honours user allow rules', () => {
    expect(checkCommand('git push --force', { ...ctx, allow: ['^git push --force$'] }).action).toBe('allow');
  });
});

describe('guard: what the line itself makes certain', () => {
  const scratch = path.join(os.homedir(), '.favilla', 'projects', 'project-1a2b', 'scratch');
  const bash = { ...ctx, shell: 'posix' as const, own: [scratch] };
  const s = scratch.replace(/\\/g, '/');
  const asks = (cmd: string, c: GuardContext = bash) => checkCommand(cmd, c).action === 'confirm';

  it('does not let a comment or a here-document with an apostrophe hide the commands after it', () => {
    expect(asks("# don't touch the rest\nrm -rf /")).toBe(true);
    expect(asks("echo hi # it's fine\nrm -rf ~")).toBe(true);
    expect(asks("cat > notes.md <<EOF\nDon't run this twice.\nEOF\nrm -rf /")).toBe(true);
    expect(asks("git status # what's left\ngit reset --hard HEAD~2")).toBe(true);
    // The shell is not named: read both ways, so the comment hides nothing there either.
    expect(asks("# don't touch the rest\nrm -rf /", ctx)).toBe(true);
    // cmd has no comments: the rest of the line runs.
    expect(asks('echo # & rd /s /q C:\\', { ...ctx, shell: 'cmd' as const })).toBe(true);
    // What is only said in a comment, or only written into a file, asks nothing.
    expect(asks('ls # rm -rf / would be bad; rm -rf ~ too')).toBe(false);
    expect(asks("python - <<'PY'\nprint('rm -rf / is what we never do'); x = 1 # don't\nPY\nls")).toBe(false);
    expect(asks('echo "#1; done" && rm -rf dist')).toBe(false);
  });

  it("lets the agent delete in Favilla's own scratch folder, and only there outside the project", () => {
    expect(asks(`rm -rf "${s}/smoke"`)).toBe(false);
    expect(asks(`rm -f "${s}/e2e/parceld.exe" "${s}/e2e/parcelctl.exe"`)).toBe(false);
    expect(asks(`rm -rf ${s}/*`)).toBe(false);
    expect(asks(`find ${s} -name "*.log" -delete`)).toBe(false);
    expect(asks(`rm -rf "${s}/smoke"`, { ...ctx, shell: 'posix' as const })).toBe(true);
    expect(asks(`rm -rf "${path.dirname(s)}"`)).toBe(true);
    expect(asks(`rm "${path.dirname(path.dirname(path.dirname(s)))}/auth.json"`)).toBe(true);
  });

  it('reads a variable the line gave a plain value', () => {
    expect(asks(`cd src && S=${s}/smoke && rm -rf "$S" && mkdir -p "$S" && go build -o "$S/app.exe" ./cmd/app`)).toBe(false);
    expect(asks(`set -e\nD=${s}/e2e\nrm -rf "$D" && mkdir -p "$D"\ngo build -o "$D/app.exe" ./cmd/app`)).toBe(false);
    expect(asks('OUT=build/tmp; go test ./... 2>&1 | tail -3; rm -rf "$OUT"/*')).toBe(false);
    expect(asks('B=build\nD="$B/tmp"\nrm -rf "${D}"')).toBe(false);
    expect(asks('export KEEP=dist/cache && rm -rf $KEEP')).toBe(false);
    // The value is read, so a dangerous one is seen for what it is.
    expect(asks('T=/ && rm -rf "$T"')).toBe(true);
    expect(asks('T=.. && rm -rf "$T/other-project"')).toBe(true);
    expect(asks('T=$HOME; rm -rf "$T"/')).toBe(true);
  });

  it('does not take a value the command may run without', () => {
    for (const cmd of [
      'test -d x && S=build; rm -rf "$S"/*',
      'S=build; false && S=; rm -rf "$S"/*',
      'false || S=build; rm -rf "$S"/*',
      'S=build & rm -rf "$S"/*',
      'S=build &\nrm -rf "$S"/*',
      'S=build | cat; rm -rf "$S"/*',
      'S=build rm -rf "$S"/*',
      'S=build; S=$(mktemp -d); rm -rf "$S"/*',
      'S=build; unset S; rm -rf "$S"/*',
      'S=build; read S; rm -rf "$S"/*',
      'S=build; S+=x; rm -rf "$S"/*',
      'S=build; if false; then S=; fi; rm -rf "$S"/*',
      'S=build; f() { S=; }; f; rm -rf "$S"/*',
      'S=build; (S=; rm -rf "$S"/*)',
      'S=build; . ./env.sh; rm -rf "$S"/*',
      'S=build; eval "S="; rm -rf "$S"/*',
      'S=build; readonly S; S=other; rm -rf "$S"/*',
      'S=; rm -rf "$S"/*',
      "S='$X'; rm -rf \"$S\"/*",
      'S=build; IFS=b; rm -rf $S/*',
      'S=~; rm -rf "$S"/*',
      'S=build; cat <<EOF\nS=\nEOF\nrm -rf "$S"/*',
      "S=build; rm -rf '$S'/*",
      'S=build; rm -rf "${S:-}"/*',
    ])
      expect(asks(cmd), cmd).toBe(true);
  });

  it('reads a delete in the folder a cd joined by && has entered', () => {
    expect(asks('cd dist && rm -rf *')).toBe(false);
    expect(asks('cd build/out && rm -rf ./* && cd ../.. && ls')).toBe(false);
    expect(asks(`mkdir -p ${s}/e2e && cd ${s}/e2e && rm -rf * && ls`)).toBe(false);
    expect(asks(`D=${s}/e2e; cd "$D" && rm -rf *`)).toBe(false);
    expect(asks(`mkdir -p ${s}/e2e && cd ${s}/e2e && rm -rf * && export PYTHONPATH=x && python - <<'PY'\nprint((1, 2))\nPY`)).toBe(false);
    // After a statement that changed folder the next one starts somewhere unknown: a relative cd is not followed
    // there (it read "cd .." as leaving the project, when it came back into it), a full path is.
    expect(asks('mkdir -p .tmp-demo && cd .tmp-demo && ls; echo "exit=$?"; cd .. && rm -rf .tmp-demo')).toBe(false);
    expect(asks('cd dist && ls; cd /usr/local && rm -rf *')).toBe(true);
    // Up and out of the project, or back onto it.
    expect(asks('cd .. && rm -rf project')).toBe(true);
    expect(asks('cd src && rm -rf ..')).toBe(true);
    expect(asks('cd src && cd .. && rm -rf *')).toBe(true);
    expect(asks('cd /usr/local && rm -rf *')).toBe(true);
    expect(asks('cd .git && rm -rf *')).toBe(true);
    // A cd that may have failed, or leads where the line does not say, changes nothing: the delete is read where the line started.
    for (const cmd of ['cd dist; rm -rf *', 'cd dist\nrm -rf *', 'cd dist || true; rm -rf *', 'cd dist | cat && rm -rf *', 'cd "$WHERE" && rm -rf *', 'cd - && rm -rf *', 'cd && rm -rf *', 'cd dist && popd && rm -rf *', '(cd dist) && rm -rf *', 'cd dist && true; rm -rf *'])
      expect(asks(cmd), cmd).toBe(true);
  });

  it('works nothing out for a shell that is not POSIX or not named', () => {
    expect(asks('cd dist && rm -rf *', ctx)).toBe(true);
    expect(asks('S=build && rm -rf "$S"', { ...ctx, shell: 'powershell' as const })).toBe(true);
  });
});

describe('a confined run stays in its folder', () => {
  // A real folder with a parent and a sibling, so that paths outside it exist on disk.
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-confine-'));
  const work = path.join(top, 'run', 'work');
  fs.mkdirSync(path.join(work, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(top, 'repo', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(top, 'run', 'wish.txt'), 'w');
  const out = (cmd: string) => outsidePath(cmd, work, work);
  afterAll(() => fs.rmSync(top, { recursive: true, force: true }));

  it('names the first path a command reaches outside the folder', () => {
    expect(out('ls -la; ls -la ..')).toBe('..');
    expect(out('cat ../wish.txt; echo ---')).toBe('../wish.txt');
    const repo = path.join(top, 'repo').split(path.sep).join('/');
    expect(out(`find ${repo} -iname "*skill*" -maxdepth 4 | head -50`)).toBe(repo);
    expect(out(`ls -R "${path.join(top, 'repo', 'skills')}"`)).toBe(path.join(top, 'repo', 'skills'));
    expect(out('bash -c "cat ../wish.txt"')).toBe('../wish.txt');
    expect(out('cp frames/a.png --target-directory=../')).toBe('../');
  });

  it('lets the work inside the folder, URLs, devices and search patterns through', () => {
    expect(out('ffmpeg -y -i frames/%04d.png -c:v libx264 out.mp4 2>/dev/null')).toBeNull();
    expect(out('ls frames && cat ./frames/../notes.md')).toBeNull();
    expect(out('curl -s https://example.com/a/b > page.html')).toBeNull();
    expect(out('rg "/api/users" src')).toBeNull();
    expect(out(`ls "${path.join(work, 'frames')}"`)).toBeNull();
  });

  it('reads a pattern right under a root as a pattern, and a file written there as a place', () => {
    // Right under a root the folder always exists: "\d+", "/api" and a lone "\" named the drive and stopped the run.
    expect(out('grep \\d+ notes.md')).toBeNull();
    expect(out('rg /api src')).toBeNull();
    expect(out("sed -n '1,5p' notes.md \\| head")).toBeNull();
    expect(out('grep -n "foo\\|bar" notes.md')).toBeNull();
    const nowhere = `/favilla-confine-${process.pid}.txt`;
    expect(out(`echo hi > ${nowhere}`)).toBe(nowhere);
    expect(out(`echo hi 2>${nowhere}`)).toBe(nowhere);
  });

  it('does not read the text a here-document gives a program as words of the command', () => {
    // A path joined with / and a floor division named the root of the disk; so did the comments of a file written by cat.
    expect(out('python - <<\'PY\'\nimport pathlib, tempfile\npath = pathlib.Path("frames") / "store.json"\nhours = 9 * (7 // 2)\nprint(path, hours)\nPY')).toBeNull();
    expect(out('cat > frames/main.go <<EOF\npackage main\n\n// main prints the ratio a / b.\nfunc main() {}\nEOF\ngo vet ./...')).toBeNull();
    expect(out('mkdir -p frames && cd frames && node - <<-"JS"\n\tconst half = 9 / 2; // rounded later\n\tJS')).toBeNull();
    // The command around the text is still read: where it is written, and what follows its closing line.
    expect(out('cat > ../wish.txt <<\'EOF\'\nnew wish\nEOF')).toBe('../wish.txt');
    expect(out('python - <<\'PY\'\nprint(1 / 2)\nPY\ncat ../wish.txt')).toBe('../wish.txt');
  });

  it('reads a here-document as commands when a shell runs it, and its command substitutions when the shell expands it', () => {
    expect(out('bash <<\'EOF\'\ncat ../wish.txt\nEOF')).toBe('../wish.txt');
    expect(out('eval "$(cat <<\'EOF\'\nls ..\nEOF\n)"')).toBe('..');
    expect(out('cat > notes.md <<EOF\nwish: $(cat ../wish.txt | head -1)\nEOF')).toBe('../wish.txt');
    expect(out('cat > notes.md <<\'EOF\'\nwish: $(cat ../wish.txt | head -1)\nEOF')).toBeNull();
    expect(out('sudo tee notes.md <<\'EOF\' && /bin/sh <<\'SH\'\nplain / text\nEOF\ncat ../wish.txt\nSH')).toBe('/');
    // A shift in a quoted script opens nothing, and a here-string is one word.
    expect(out('python -c "print(1 << n)"\nls ..\nn')).toBe('..');
    expect(out('cat <<< "EOF"\nls ..\nEOF')).toBe('..');
  });

  it("checks a tool's own path arguments, a read's line range left aside", () => {
    expect(outsideArgs({ paths: ['frames', 'notes.md:1-40'] }, work, work)).toBeNull();
    expect(outsideArgs({ paths: ['notes.md:full', 'notes.md:-2'] }, work, work)).toBeNull();
    for (const view of ['full', '-2']) expect(outsideArgs({ paths: [`../wish.txt:${view}`] }, work, work)).toBe('../wish.txt');
    expect(outsideArgs({ paths: ['notes.md', '../wish.txt:1-5'] }, work, work)).toBe('../wish.txt');
    expect(outsideArgs({ path: path.join(top, 'repo') }, work, work)).toBe(path.join(top, 'repo'));
    // The folders a confined run may also read from (the skills Favilla ships).
    expect(outsideArgs({ paths: [path.join(top, 'repo', 'skills', 'motion', 'SKILL.md')] }, work, work, [path.join(top, 'repo', 'skills')])).toBeNull();
  });

  it('checks where a picture, a score, a film or a mail is written or read from', () => {
    const away = path.join(top, 'elsewhere');
    expect(outsideArgs({ doc: 'size: [64, 64]', out: 'art/icon.png' }, work, work)).toBeNull();
    expect(outsideArgs({ doc: 'size: [64, 64]', out: path.join(away, 'icon.png') }, work, work)).toBe(path.join(away, 'icon.png'));
    expect(outsideArgs({ cut: '../sprite.png', out: 'sprite-clean.png' }, work, work)).toBe('../sprite.png');
    expect(outsideArgs({ page: 'demo.html', sound: path.join(away, 'bed.wav') }, work, work)).toBe(path.join(away, 'bed.wav'));
    expect(outsideArgs({ action: 'read', id: '12@INBOX', saveTo: away }, work, work)).toBe(away);
    expect(outsideArgs({ action: 'draft', to: ['someone@example.com'], attachments: ['report.pdf', path.join(away, 'keys.txt')] }, work, work)).toBe(path.join(away, 'keys.txt'));
    // A page given as a web address is not a file.
    expect(outsideArgs({ page: 'http://127.0.0.1:5173/', out: 'demo.mp4' }, work, work)).toBeNull();
  });

  it('lets a command use the other folders it is given, its scratch folder, and nothing beside them', () => {
    const scratch = path.join(top, 'repo', 'skills');
    const s = scratch.split(path.sep).join('/');
    expect(outsidePath(`python ${s}/make_sheet.py > ${s}/log.txt`, work, work, [scratch])).toBeNull();
    expect(outsidePath(`python ${s}/make_sheet.py && cat ../wish.txt`, work, work, [scratch])).toBe('../wish.txt');
  });
});
