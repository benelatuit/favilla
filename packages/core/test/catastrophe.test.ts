import { describe, expect, it } from 'vitest';
import { checkCatastrophe, checkFileCatastrophe, explicitlyRequested, type CatastropheContext } from '../src/guard/catastrophe';

const unix: CatastropheContext = { cwd: '/work/project', workspace: '/work/project', home: '/home/me', data: '/home/me/.favilla' };
const win: CatastropheContext = { cwd: 'C:\\work\\project', workspace: 'C:\\work\\project', home: 'C:\\Users\\me', data: 'C:\\Users\\me\\.favilla' };
const check = (command: string, ctx = unix) => checkCatastrophe(command, ctx).risks;

describe('catastrophe backstop', () => {
  it.each([
    'rm -rf /', 'rm -rf /*', 'rm -rf ~', 'rm -rf ~/*', 'rm -rf "$HOME"', 'rm -rf "${HOME}/"',
    'rm -rf /home', 'rm -rf /home/me', 'rm -rf /home/me/.favilla', 'rm -rf .', 'rm -rf ./*', 'rm -rf *', 'rm -rf ..',
    'rm -rf /work/project', 'rm -rf /work', 'sudo rm -rf /usr', 'rm -rf /etc', 'rm -rf /usr/bin',
    'rm -rf .git', 'rm -rf nested/.git', 'rm -rf .git/objects', 'rm .git/HEAD',
    'rm -rf "$DIR"/', 'rm -rf "${DIR}"/*', 'DIR=""; rm -rf "$DIR"/',
    'cd src && rm -rf ..', 'cd /home && rm -rf me',
    'cd missing; rm -rf *', 'pushd dist && popd && rm -rf .', 'cd dist && cd - && rm -rf .',
    'bash -lc "rm -rf /"', "sh -c 'rm -rf /'", 'find / -delete', 'find / -type f -delete', 'find / -exec rm -rf {} \\;',
    'sudo -u root rm -rf /', '/usr/bin/sudo rm -rf /',
    'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda', 'cat image > /dev/nvme0n1', 'cat image>/dev/sdb',
    'tee /dev/sda < image', 'wipefs -a /dev/sdb', 'parted /dev/sda mklabel gpt', 'fdisk /dev/sdb',
    'psql -c "DROP DATABASE production"', 'dropdb production', 'mysql -e "DROP SCHEMA production"',
    "psql -c 'DROP DATABASE \"live-data\";'", 'sqlcmd -Q "DROP DATABASE [live data]"',
    'redis-cli FLUSHALL', 'redis-cli -h cache -n 2 FLUSHDB',
    'mongosh mongodb://localhost/production --eval "db.dropDatabase()"',
    'mongosh --eval "db.getSiblingDB(\'production\').dropDatabase()"',
    'echo "DROP DATABASE production" | psql',
    'psql -c "SELECT 1" -c "DROP DATABASE production"',
    'mysqladmin -h live --force drop production', 'shred /dev/sda', 'cp image /dev/sdb', 'blkdiscard /dev/nvme0n1',
    'parted -s /dev/sda print mklabel gpt', 'wipefs -a -l /dev/sda',
  ])('holds %s', (command) => {
    expect(check(command), command).not.toHaveLength(0);
    expect(check(command).every((r) => r.reason.includes(r.target))).toBe(true);
  });

  it.each([
    'Remove-Item -LiteralPath C:\\ -Recurse -Force', 'Remove-Item -Recurse -Force $env:USERPROFILE',
    'Remove-Item -Recurse -Force ${env:USERPROFILE}', 'Remove-Item -Recurse -Force ~',
    'Remove-Item -Recurse -Force C:\\Users', 'Remove-Item -Recurse -Force C:\\Windows\\System32',
    'rd /s /q C:\\', 'rmdir /s /q "%USERPROFILE%"', 'del /s /q C:\\Users\\me\\*',
    'rm -rf /c/', 'rm -rf /c/Users/me', 'rm -rf /c/work/project', 'rm -rf /c/work/project/.git',
    'rd /s /q \\Users\\me', 'cmd /c rd /s /q C:\\',
    'powershell -Command "Remove-Item -Recurse -Force C:\\Users\\me"',
    'Set-Location C:\\Users; Remove-Item me -Recurse -Force',
    'Format-Volume -DriveLetter D', 'Clear-Disk -Number 2 -RemoveData', 'format D: /Q',
    'Initialize-Disk -Number 2', 'Remove-Partition -DiskNumber 2 -PartitionNumber 1',
    'dd if=image of=\\\\.\\PhysicalDrive0',
    'rd /s /q \\\\server\\share', 'rm -rf //server/share',
  ])('holds Windows: %s', (command) => expect(check(command, win), command).not.toHaveLength(0));

  it.each([
    'rm -rf node_modules dist build', 'rm -rf /tmp/favilla-test /var/tmp/cache', 'rm src/old.ts',
    'rm -rf ~/.cache/tool', 'rm -rf /home/me/.favilla/cache', 'rm -rf /work/project-old',
    'rm -rf ../other-project', 'rm -rf /var/log/old', 'rm .gitignore', 'rm -rf .git/hooks',
    'git clean -fdX', 'git reset --hard', 'git push --force', 'docker system prune -a',
    'echo "rm -rf /"', 'rg "DROP DATABASE" src', 'echo "cat > /dev/sda"',
    "cat > sample.sh <<'EOF'\nrm -rf /\nEOF", 'rm -rf "$CACHE"/tool',
    'DIR=/tmp/cache; rm -rf "$DIR"/', 'cd dist && rm -rf *', 'find / -name "*.log" -delete',
    'dd if=/dev/zero of=image.bin bs=1M count=2', 'cat > /dev/null', 'fdisk -l', 'parted /dev/sda print',
    'wipefs /dev/sdb', 'mkfs.ext4 --help', 'mkfs.ext4 -n /dev/sdb', 'mkfs.ext4 image.img', 'parted image.img mklabel gpt', 'psql -c "DROP TABLE scratch"',
    'psql -c "TRUNCATE TABLE scratch"', 'psql -c "SELECT \'DROP DATABASE live\'"', 'redis-cli GET x',
    'Remove-Item -Recurse -Force node_modules,dist,build', 'Remove-Item C:\\Users\\me\\AppData\\Local\\Temp\\cache -Recurse',
    'rd /s /q C:\\temp\\cache', 'Remove-Item C:\\ -Recurse -WhatIf', 'Clear-Disk -Number 2 -WhatIf',
  ])('leaves ordinary work alone: %s', (command) => {
    expect(check(command), command).toEqual([]);
    expect(check(command, win), command).toEqual([]);
  });

  it('reads a variable this process has, so emptying the temp folder is ordinary, and holds one it does not have', () => {
    process.env.FAVILLA_TEST_TEMP = 'C:\\Users\\me\\AppData\\Local\\Temp';
    try {
      expect(check('Remove-Item -Recurse -Force $env:FAVILLA_TEST_TEMP\\*', win)).toEqual([]);
      expect(check('rmdir /s /q %FAVILLA_TEST_TEMP%', win)).toEqual([]);
    } finally {
      delete process.env.FAVILLA_TEST_TEMP;
    }
    expect(check('Remove-Item -Recurse -Force $env:FAVILLA_TEST_TEMP\\*', win).map((r) => r.kind)).toEqual(['variable']);
    // A script's own $tmp is not the environment's TMP, whatever Windows does with the case of process.env.
    process.env.FAVILLA_TEST_TMP = 'C:\\work';
    try {
      expect(check('tmp=$(mktemp -d); rm -rf "$favilla_test_tmp"', win)).toEqual([]);
    } finally {
      delete process.env.FAVILLA_TEST_TMP;
    }
  });

  it('keeps every target in a destructive command', () => {
    expect(check('rm -rf /home/me /work/project .git').map((r) => r.target)).toEqual(['/home/me', '/work/project', '/work/project/.git']);
    expect(check('psql -c "DROP DATABASE one; DROP DATABASE two"').map((r) => r.target)).toEqual(['one', 'two']);
    expect(check('psql -c "DROP SCHEMA one, two CASCADE"').map((r) => r.target)).toEqual(['one', 'two']);
    expect(check("psql <<'SQL'\nDROP DATABASE one;\nDROP DATABASE two;\nSQL").map((r) => r.target)).toEqual(['one', 'two']);
  });

  it('protects a relocated data folder and the shell workdir', () => {
    expect(check('rm -rf /srv/favilla', { ...unix, data: '/srv/favilla' })).toHaveLength(1);
    expect(check('rm -rf ../..', { ...unix, cwd: '/work/project/src/nested' })).toHaveLength(1);
  });

  it('names the Redis endpoint and selected database without credentials', () => {
    expect(check('redis-cli FLUSHDB')[0].target).toBe('redis://localhost:6379/0');
    expect(check('redis-cli -u redis://user:password@cache:6379/3 FLUSHDB')[0].target).toBe('redis://cache:6379/3');
    expect(check('redis-cli -h cache -n 3 FLUSHALL')[0].target).toBe('redis://cache:6379/*');
  });

  it('recognizes only creation with a useful success status, on the same database connection', () => {
    const created = checkCatastrophe('createdb -h localhost scratch', unix).created[0];
    expect(check('dropdb -h localhost scratch')[0].databaseKey).toBe(created);
    expect(check('dropdb -h production scratch')[0].databaseKey).not.toBe(created);
    const schema = checkCatastrophe('psql scratch -c "CREATE SCHEMA test"', unix).created[0];
    expect(check('psql production -c "DROP SCHEMA test"')[0].databaseKey).not.toBe(schema);
    expect(checkCatastrophe('psql -c "CREATE DATABASE IF NOT EXISTS scratch"', unix).created).toEqual([]);
    expect(checkCatastrophe('createdb scratch || true', unix).created).toEqual([]);
    expect(check('PGHOST=production dropdb scratch')[0].databaseKey).not.toBe(checkCatastrophe('PGHOST=localhost createdb scratch', unix).created[0]);
    expect(check('psql postgres://production/db -c "DROP DATABASE scratch"')[0].databaseKey).not.toBe(checkCatastrophe('psql postgres://localhost/db -c "CREATE DATABASE scratch"', unix).created[0]);
    expect(check('mysql --defaults-file=prod.cnf -e "DROP DATABASE scratch"')[0].databaseKey).not.toBe(checkCatastrophe('mysql --defaults-file=test.cnf -e "CREATE DATABASE scratch"', unix).created[0]);
    expect(checkCatastrophe('psql -c "CREATE DATABASE scratch" -c "SELECT 1"', unix).created).toEqual([]);
    expect(checkCatastrophe('createdb --help scratch', unix).created).toEqual([]);
    expect(checkCatastrophe('mysql --force -e "CREATE DATABASE scratch"', unix).created).toEqual([]);
  });

  it('checks file destinations, including moves, without treating ordinary file edits as a folder wipe', () => {
    for (const kind of ['write', 'edit']) {
      expect(checkFileCatastrophe(kind, { path: '.git/HEAD' }, unix)).toHaveLength(1);
      expect(checkFileCatastrophe(kind, { path: '/dev/sda' }, unix)).toHaveLength(1);
      expect(checkFileCatastrophe(kind, { path: 'src/main.ts' }, unix)).toEqual([]);
    }
    expect(checkFileCatastrophe('patch', { patch: '*** Begin Patch\n*** Delete File: .git\n*** End Patch' }, unix)).toHaveLength(1);
    expect(checkFileCatastrophe('patch', { patch: '*** Begin Patch\n*** Update File: x\n*** Move to: .git/HEAD\n*** End Patch' }, unix)).toHaveLength(1);
    expect(checkFileCatastrophe('read', { path: '.git/HEAD' }, unix)).toEqual([]);
    expect(checkFileCatastrophe('patch', { patch: '*** Begin Patch\n*** Delete File: old.ts\n*** End Patch' }, unix)).toEqual([]);
  });
});

describe('the user asked for this target', () => {
  const folder = check('rm -rf /home/me')[0];
  it.each(['Delete /home/me.', 'Please wipe "/home/me".', 'Can you remove ~?', '请删除 /home/me', '把 /home/me 删掉', '请清空~', 'Run `rm -rf ~`', '请执行以下命令：```bash\nrm -rf ~\n```'])('%s', (text) => expect(explicitlyRequested(text, folder, unix)).toBe(true));
  it.each([
    'My home is /home/me. Clean up the build.', 'Do not delete /home/me.', "Please don't delete /home/me.",
    'Explain why rm -rf /home/me is dangerous.', 'If necessary, delete /home/me.', 'Delete /home/me/cache.',
    'Delete /home/me-old', 'Delete build. The home is /home/me.', '请不要删除 /home/me',
    'Example:\n```\nDelete /home/me\n```', '> Delete /home/me',
    'Delete logs from /home/me.', 'Delete cache and inspect /home/me.', 'Delete /home/me after I confirm.',
    'Delete cache but preserve /home/me.',
  ])('does not infer permission from %s', (text) => expect(explicitlyRequested(text, folder, unix)).toBe(false));

  it('matches normalized Windows paths and exact database names', () => {
    expect(explicitlyRequested('Please remove C:\\USERS\\me.', check('rm -rf /c/Users/me', win)[0], win)).toBe(true);
    const db = check('dropdb production')[0];
    expect(explicitlyRequested('Drop the database `production`.', db, unix)).toBe(true);
    expect(explicitlyRequested('Drop production_backup.', db, unix)).toBe(false);
    expect(explicitlyRequested('Use production while deleting scratch.', db, unix)).toBe(false);
    expect(explicitlyRequested('删除数据库 production', db, unix)).toBe(true);
  });

  it('does not authorize extra targets or an unknown variable', () => {
    const risks = check('rm -rf /home/me /work/project "$DIR"/');
    expect(risks.map((r) => explicitlyRequested('Delete /home/me.', r, unix))).toEqual([true, false, false]);
  });
});
