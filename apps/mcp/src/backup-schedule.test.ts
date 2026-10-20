import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from 'vitest';

test.skipIf(process.platform !== 'linux')('Linux backup schedule preserves the previous archive on failure and advances only after success', () => {
  const root = mkdtempSync(join(tmpdir(), 'navocms-backup-schedule-'));
  try {
    const bin = join(root, 'bin'), backups = join(root, 'private backups');
    mkdirSync(bin); mkdirSync(backups);
    writeFileSync(join(backups, 'before.navo'), 'previous encrypted backup');
    symlinkSync('before.navo', join(backups, 'latest.navo'));
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(process.env.ARGUMENT_LOG,JSON.stringify(process.argv.slice(2)));
if(process.env.FAIL_BACKUP==='true')process.exit(7);
fs.writeFileSync(path.join(process.env.NAVOCMS_BACKUP_DIRECTORY,path.basename(process.argv.at(-1))),'synthetic archive');
`, { mode: 0o700 });
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH, NAVOCMS_BACKUP_DIRECTORY: backups, NAVOCMS_COMPOSE_FILE: 'deploy/self-host/operations.compose.yml', ARGUMENT_LOG: join(root, 'args.json') };
    const failed = spawnSync('/bin/sh', [resolve('deploy/self-host/backup.sh')], { env: { ...env, FAIL_BACKUP: 'true' }, encoding: 'utf8' });
    expect(failed.status).toBe(7);
    expect(readlinkSync(join(backups, 'latest.navo'))).toBe('before.navo');
    const success = spawnSync('/bin/sh', [resolve('deploy/self-host/backup.sh')], { env, encoding: 'utf8' });
    expect(success.status).toBe(0);
    const latest = readlinkSync(join(backups, 'latest.navo'));
    expect(latest).toMatch(/^backup-\d{8}T\d{6}Z\.navo$/);
    expect(readFileSync(join(backups, latest), 'utf8')).toBe('synthetic archive');
    expect(readFileSync(join(backups, 'before.navo'), 'utf8')).toBe('previous encrypted backup');
    expect(JSON.parse(readFileSync(env.ARGUMENT_LOG, 'utf8'))).toContain('deploy/self-host/operations.compose.yml');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
