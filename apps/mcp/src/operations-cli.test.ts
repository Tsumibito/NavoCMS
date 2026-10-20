import { spawnSync } from 'node:child_process';
import { test, expect } from 'vitest';
test('operator CLI journals requested and failed actions without bypassing event policy', () => {
  const result = spawnSync(process.execPath, ['apps/mcp/dist/operations-cli.js', 'install'], {
    encoding: 'utf8',
    env: { ...process.env, NAVOCMS_TENANT_ID: 'a2af348f-58b8-4efe-b873-8bd032ecbc5c', NAVOCMS_SITE_ID: '2e0bcd4f-6780-470c-844b-d72abb6737ca', NAVOCMS_RUNTIME_PRINCIPAL_ID: '016ef382-bf28-406b-9321-1fc580b6ea00' }
  });
  expect(result.status).toBe(1);
  const requested = JSON.parse(result.stdout.trim());
  const [failed, diagnostic] = result.stderr.trim().split('\n').map(line => JSON.parse(line));
  expect(requested.type).toBe('io.navocms.operations.install-requested.v1');
  expect(failed.type).toBe('io.navocms.operations.install-failed.v1');
  expect(failed.navocorrelationid).toBe(requested.navocorrelationid);
  expect(failed.navoidempotencykey).not.toBe(requested.navoidempotencykey);
  expect(diagnostic.code).toBe('INSTALL_CONFIG_REQUIRED');
});
