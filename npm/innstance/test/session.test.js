'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { clearSession, deviceName, loadSession, saveSession, sessionPath, validToken } = require('../lib/session');
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

test('the session is saved owner-only and round-trips', async (t) => {
  const home = tempHome(t);
  const ctx = { home };
  assert.equal(loadSession(ctx), null);
  const session = {
    server: 'https://innstance.impossibuild.ai',
    email: 'dev@example.com',
    token: 'imp_' + 'b'.repeat(64),
    deviceName: 'npx-mac-studio-7f3a',
    deviceId: '7f3a',
  };
  await saveSession(ctx, session);
  assert.deepEqual(loadSession(ctx), session);
  if (process.platform !== 'win32') assert.equal(mode(sessionPath(ctx)), 0o600);
  assert.equal(clearSession(ctx), true);
  assert.equal(clearSession(ctx), false);
});

test('a damaged session file reads as no session, and a bad token is dropped', (t) => {
  const home = tempHome(t);
  const ctx = { home };
  fs.mkdirSync(require('node:path').dirname(sessionPath(ctx)), { recursive: true });
  fs.writeFileSync(sessionPath(ctx), '{not json');
  assert.equal(loadSession(ctx), null);
  fs.writeFileSync(sessionPath(ctx), JSON.stringify({ server: 'https://x.example', token: 'has spaces in it ok?', device_id: 'zz' }));
  const loaded = loadSession(ctx);
  assert.equal(loaded.token, '');
  assert.equal(loaded.deviceId, '');
});
