'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { checkGrant, signIn, validUserCode } = require('../lib/device');
const { makeContext, startFakeServer, tempHome } = require('./helpers');

const ORIGIN = 'https://innstance.impossibuild.ai';
const GOOD = {
  device_code: 'ab'.repeat(32),
  user_code: 'ABCD-EFGH',
  verification_url: ORIGIN + '/auth/device',
  interval: 5,
  expires_in: 600,
};

test('validUserCode matches the server alphabet and shape', () => {
  const cases = [
    ['ABCD-EFGH', true],
    ['2345-6789', true],
    ['ABCD-EFG0', false], // 0 is not in the alphabet
    ['ABCDEFGH', false],
    ['abcd-efgh', false],
    ['ABCD-EFGHI', false],
    [null, false],
  ];
  for (const [code, ok] of cases) assert.equal(validUserCode(code), ok, String(code));
});

test('checkGrant refuses anything the Go CLI would refuse', () => {
  const cases = [
    { name: 'not an object', grant: null, err: /could not read/ },
    { name: 'short device code', grant: { ...GOOD, device_code: 'abc' }, err: /invalid device code/ },
    { name: 'non-hex device code', grant: { ...GOOD, device_code: 'zz'.repeat(32) }, err: /invalid device code/ },
    { name: 'bad user code', grant: { ...GOOD, user_code: 'AB-CD' }, err: /invalid user code/ },
    { name: 'zero interval', grant: { ...GOOD, interval: 0 }, err: /unsafe polling/ },
    { name: 'slow interval', grant: { ...GOOD, interval: 31 }, err: /unsafe polling/ },
    { name: 'fractional interval', grant: { ...GOOD, interval: 1.5 }, err: /unsafe polling/ },
    { name: 'short expiry', grant: { ...GOOD, expires_in: 29 }, err: /unsafe polling/ },
    { name: 'long expiry', grant: { ...GOOD, expires_in: 1801 }, err: /unsafe polling/ },
    { name: 'other host', grant: { ...GOOD, verification_url: 'https://evil.example/auth/device' }, err: /not on the API origin/ },
    { name: 'other scheme', grant: { ...GOOD, verification_url: 'http://innstance.impossibuild.ai/auth/device' }, err: /not on the API origin/ },
    { name: 'other path', grant: { ...GOOD, verification_url: ORIGIN + '/login' }, err: /shape/ },
    { name: 'query smuggled', grant: { ...GOOD, verification_url: ORIGIN + '/auth/device?next=https://evil.example' }, err: /shape/ },
    { name: 'empty query', grant: { ...GOOD, verification_url: ORIGIN + '/auth/device?' }, err: /shape/ },
    { name: 'fragment', grant: { ...GOOD, verification_url: ORIGIN + '/auth/device#x' }, err: /shape/ },
    { name: 'userinfo', grant: { ...GOOD, verification_url: 'https://a@innstance.impossibuild.ai/auth/device' }, err: /shape/ },
    { name: 'javascript', grant: { ...GOOD, verification_url: 'javascript:alert(1)' }, err: /unsafe verification URL/ },
  ];
  for (const c of cases) assert.throws(() => checkGrant(ORIGIN, c.grant), c.err, c.name);
  const ok = checkGrant(ORIGIN, GOOD);
  assert.equal(ok.verifyURL, ORIGIN + '/auth/device?code=ABCD-EFGH');
});

test('signIn waits through pending polls and returns the approved token', async (t) => {
  const server = await startFakeServer({ pendingPolls: 2 });
  t.after(server.close);
  const { ctx, out, opened } = makeContext(tempHome(t), server);
  const result = await signIn(ctx, server.origin, 'npx-mac-test-a1b2');
  assert.equal(result.email, 'dev@example.com');
  assert.ok(server.validToken(result.token));
  assert.deepEqual(server.state.deviceNames, ['npx-mac-test-a1b2']);
  assert.equal(server.state.polls, 3);
  assert.deepEqual(opened, [server.origin + '/auth/device?code=ABCD-EFGH']);
  const printed = out.join('\n');
  assert.match(printed, /ABCD-EFGH/);
  assert.ok(!printed.includes(result.token), 'the token must never be printed');
});

test('signIn without a browser prints the link instead', async (t) => {
  const server = await startFakeServer({ pendingPolls: 0 });
  t.after(server.close);
  const { ctx, out } = makeContext(tempHome(t), server);
  ctx.openBrowser = null;
  await signIn(ctx, server.origin, 'npx-linux-a1b2');
  assert.match(out.join('\n'), /Open this link in a browser/);
});

test('signIn reports each way a sign-in ends without a token', async (t) => {
  const cases = [
    { name: 'denied in the browser', state: { deny: true }, err: /cancelled in the browser/ },
    { name: 'grant expired', state: { pollStatus: 410 }, err: /expired/ },
    { name: 'server error while polling', state: { pollStatus: 500 }, err: /sign-in failed: forced \(HTTP 500\)/ },
    { name: 'device login missing', state: { startStatus: 404 }, err: /does not offer device sign-in/ },
    { name: 'start refused', state: { startStatus: 429 }, err: /start refused \(HTTP 429\)/ },
    {
      name: 'unsafe verification URL',
      state: { grant: { ...GOOD, verification_url: 'https://evil.example/auth/device' } },
      err: /unsafe verification URL/,
    },
  ];
  for (const c of cases) {
    const server = await startFakeServer({ pendingPolls: 0, ...c.state });
    const { ctx, opened } = makeContext(tempHome(t), server);
    await assert.rejects(signIn(ctx, server.origin, 'npx-mac-a1b2'), c.err, c.name);
    if (c.name === 'unsafe verification URL') assert.deepEqual(opened, [], 'nothing is opened for an unsafe URL');
    await server.close();
  }
});

test('signIn backs off when rate limited and gives up at the grant expiry', async (t) => {
  const server = await startFakeServer({ pollStatus: 429 });
  t.after(server.close);
  server.state.grant = { ...GOOD, verification_url: server.origin + '/auth/device', interval: 1, expires_in: 30 };
  const { ctx } = makeContext(tempHome(t), server);
  let clock = 0;
  const waits = [];
  ctx.now = () => clock;
  ctx.sleep = async (ms) => {
    waits.push(ms);
    clock += ms;
  };
  await assert.rejects(signIn(ctx, server.origin, 'npx-mac-a1b2'), /timed out/);
  assert.deepEqual(waits.slice(0, 3), [1000, 6000, 11000]);
  assert.ok(clock <= 30000);
});

test('signIn rides out brief network failures while polling, but not a lasting one', async (t) => {
  const cases = [
    { drops: 2, ok: true },
    { drops: 3, ok: false },
  ];
  for (const c of cases) {
    const server = await startFakeServer({ pendingPolls: 0, dropPolls: c.drops });
    const { ctx } = makeContext(tempHome(t), server);
    if (c.ok) {
      const result = await signIn(ctx, server.origin, 'npx-mac-a1b2');
      assert.ok(server.validToken(result.token), `${c.drops} drops`);
    } else {
      await assert.rejects(signIn(ctx, server.origin, 'npx-mac-a1b2'), /could not reach/, `${c.drops} drops`);
    }
    await server.close();
  }
});
