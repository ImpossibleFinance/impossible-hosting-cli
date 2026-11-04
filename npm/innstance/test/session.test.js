'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { clearSession, deviceName, loadSession, machineDeviceId, saveSession, savedOrigins, sessionPath, validToken } = require('../lib/session');
const { mode, tempHome } = require('./helpers');

test('deviceName is npx-<os>-<host>-<id> and fits the server slug', () => {
  const cases = [
    { platform: 'darwin', host: 'Studio.local', id: '7f3a', want: 'npx-mac-studio-local-7f3a' },
    { platform: 'linux', host: 'james', id: '0001', want: 'npx-linux-james-0001' },
    { platform: 'win32', host: 'DESKTOP-ABC123', id: 'beef', want: 'npx-windows-desktop-abc123-beef' },
    // Hostnames with nothing usable, or shared by everyone, drop out.
    { platform: 'darwin', host: '李的电脑', id: 'a1b2', want: 'npx-mac-a1b2' },
    { platform: 'linux', host: 'localhost', id: 'a1b2', want: 'npx-linux-a1b2' },
    { platform: 'linux', host: '--odd__name..', id: 'a1b2', want: 'npx-linux-odd-name-a1b2' },
    // Long hostnames are cut so the id survives the server's 32-char slug.
    {
      platform: 'win32',
      host: 'a-very-long-workstation-hostname-in-the-office',
      id: 'c0de',
      want: 'npx-windows-a-very-long-wor-c0de',
    },
    { platform: 'freebsd', host: 'box', id: 'a1b2', want: 'npx-freebsd-box-a1b2' },
  ];
  for (const c of cases) {
    const got = deviceName(c.platform, c.host, c.id);
    assert.equal(got, c.want, `${c.platform}/${c.host}`);
    assert.ok(got.length <= 32, `${got} is longer than the server keeps`);
    assert.ok(got.endsWith('-' + c.id));
  }
});

test('validToken accepts bearer token68 values and nothing that could break a config file', () => {
  const cases = [
    { token: 'imp_' + 'a'.repeat(64), ok: true },
    { token: 'abcDEF0123456789-._~+/==', ok: true },
    { token: 'short', ok: false },
    { token: 'imp_abc"def0123456789', ok: false },
    { token: 'imp_abc\ndef0123456789', ok: false },
    { token: 'imp_abc def0123456789', ok: false },
    { token: "imp_abc'def0123456789", ok: false },
    { token: 'imp_abc\\def0123456789', ok: false },
    { token: 'x'.repeat(1025), ok: false },
    { token: 1234567890123456789, ok: false },
    { token: undefined, ok: false },
  ];
  for (const c of cases) assert.equal(validToken(c.token), c.ok, String(c.token).slice(0, 30));
});

test('sessions are saved owner-only, one per control plane', async (t) => {
  const home = tempHome(t);
  const ctx = { home };
  const prod = 'https://innstance.impossibuild.ai';
  const staging = 'https://staging.example';
  assert.equal(loadSession(ctx, prod), null);
  assert.equal(machineDeviceId(ctx), '');
  const session = { server: prod, email: 'dev@example.com', token: 'imp_' + 'b'.repeat(64), deviceName: 'npx-mac-studio-7f3a', deviceId: '7f3a' };
  await saveSession(ctx, session);
  assert.deepEqual(loadSession(ctx, prod), session);
  if (process.platform !== 'win32') assert.equal(mode(sessionPath(ctx)), 0o600);

  // Signing in to a second control plane keeps the first.
  const other = { ...session, server: staging, token: 'imp_' + 'c'.repeat(64) };
  await saveSession(ctx, other);
  assert.deepEqual(loadSession(ctx, prod), session);
  assert.deepEqual(loadSession(ctx, staging), other);
  assert.deepEqual(savedOrigins(ctx).sort(), [prod, staging]);
  assert.equal(machineDeviceId(ctx), '7f3a');

  assert.equal(await clearSession(ctx, staging), true);
  assert.equal(loadSession(ctx, staging), null);
  assert.deepEqual(loadSession(ctx, prod), session, 'ending one keeps the other');
  assert.equal(await clearSession(ctx, staging), false);
  assert.equal(await clearSession(ctx, prod), true);
  assert.equal(fs.existsSync(sessionPath(ctx)), false, 'the file goes with the last session');
});

test('a version 1 session file is still read', (t) => {
  const ctx = { home: tempHome(t) };
  fs.mkdirSync(path.dirname(sessionPath(ctx)), { recursive: true });
  const token = 'imp_' + 'e'.repeat(64);
  fs.writeFileSync(sessionPath(ctx), JSON.stringify({ version: 1, server: 'https://innstance.impossibuild.ai', email: 'a@b.c', token, device_name: 'npx-mac-x-0a0b', device_id: '0a0b' }));
  assert.deepEqual(loadSession(ctx, 'https://innstance.impossibuild.ai'), {
    server: 'https://innstance.impossibuild.ai',
    email: 'a@b.c',
    token,
    deviceName: 'npx-mac-x-0a0b',
    deviceId: '0a0b',
  });
});

test('a damaged session file reads as no session, and bad values are dropped', (t) => {
  const home = tempHome(t);
  const ctx = { home };
  fs.mkdirSync(path.dirname(sessionPath(ctx)), { recursive: true });
  fs.writeFileSync(sessionPath(ctx), '{not json');
  assert.equal(loadSession(ctx, 'https://x.example'), null);
  fs.writeFileSync(
    sessionPath(ctx),
    JSON.stringify({ version: 2, device_id: 'zz', sessions: { 'https://x.example': { token: 'has spaces in it ok?' }, 'https://x.example/path': { token: 'imp_' + 'a'.repeat(64) } } }),
  );
  assert.equal(loadSession(ctx, 'https://x.example').token, '');
  assert.equal(machineDeviceId(ctx), '');
  assert.deepEqual(savedOrigins(ctx), ['https://x.example'], 'a key that is not an origin is ignored');
});
