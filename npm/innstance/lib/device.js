'use strict';

const { postJSON, parseJSONBody, serverMessage, NetworkError } = require('./http');
const { validToken } = require('./session');

// The control plane's device-authorization flow (server/handler/clerk_device.go),
// spoken exactly as the Go CLI speaks it (cli/login.go):
//
//   POST /auth/device/start {device_name}
//     -> 200 {device_code, user_code, verification_url, interval, expires_in}
//   the person approves at verification_url?code=<user_code> in a browser
//   POST /auth/device/poll {device_code}
//     -> 202 pending | 200 {status: approved, token, email} | 200 {status: denied}
//     -> 410 expired
//
// The token is minted server-side into the grant and handed over once, to
// the poll; it never passes through the browser. Every field of the start
// response is checked before anything is shown or opened, with the same
// limits the Go CLI applies: a compromised or confused server must not be
// able to send the person to another site, or make this loop spin forever.

const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function validUserCode(code) {
  if (typeof code !== 'string' || code.length !== 9 || code[4] !== '-') return false;
  for (let i = 0; i < code.length; i++) {
    if (i !== 4 && !USER_CODE_ALPHABET.includes(code[i])) return false;
  }
  return true;
}

// trustedVerificationURL accepts only <origin>/auth/device with nothing else
// attached: same scheme and host as the API, no credentials, query or
// fragment. The user code is added by us, not taken from the server.
function trustedVerificationURL(origin, raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('not an absolute URL');
  }
  if (u.username || u.password || u.search || u.hash || raw.includes('?') || raw.includes('#') || u.pathname !== '/auth/device') {
    throw new Error('unexpected verification URL shape');
  }
  if (u.origin !== origin) {
    throw new Error('verification URL is not on the API origin');
  }
  return u;
}

function checkGrant(origin, grant) {
  if (!grant || typeof grant !== 'object') throw new Error('could not read the sign-in response');
  const { device_code: deviceCode, user_code: userCode, verification_url: verificationURL, interval, expires_in: expiresIn } = grant;
  if (typeof deviceCode !== 'string' || !/^[0-9a-f]{64}$/i.test(deviceCode)) {
    throw new Error('the sign-in server returned an invalid device code');
  }
  if (!validUserCode(userCode)) throw new Error('the sign-in server returned an invalid user code');
  if (!Number.isInteger(interval) || interval < 1 || interval > 30 || !Number.isInteger(expiresIn) || expiresIn < 30 || expiresIn > 1800) {
    throw new Error('the sign-in server returned unsafe polling limits');
  }
  let verification;
  try {
    verification = trustedVerificationURL(origin, verificationURL);
  } catch (err) {
    throw new Error(`the sign-in server returned an unsafe verification URL: ${err.message}`);
  }
  verification.searchParams.set('code', userCode);
  return { deviceCode, userCode, verifyURL: verification.toString(), interval, expiresIn };
}

// Transient network trouble while polling should not throw away an approval
// the person may be completing right now; a few consecutive failures are
// tolerated before giving up.
const MAX_POLL_NETWORK_FAILURES = 3;

async function signIn(ctx, origin, name) {
  let res;
  try {
    res = await postJSON(origin + '/auth/device/start', { device_name: name });
  } catch (err) {
    throw err instanceof NetworkError ? err : new Error(`could not start sign-in: ${err.message}`);
  }
  if (res.status === 404) {
    throw new Error(`${origin} does not offer device sign-in`);
  }
  if (res.status !== 200) {
    throw new Error(`could not start sign-in: ${serverMessage(res)}`);
  }
  const grant = checkGrant(origin, parseJSONBody(res));

  const opened = ctx.openBrowser ? ctx.openBrowser(grant.verifyURL) : false;
  ctx.out('');
  ctx.out(`  Your sign-in code: ${grant.userCode}`);
  ctx.out('');
  ctx.out(opened ? '  Approve this device in the browser window that opened. If none did, visit:' : '  Open this link in a browser to approve this device:');
  ctx.out(`  ${grant.verifyURL}`);
  ctx.out('');
  ctx.out(`  Check that the page shows the same code. Waiting for approval...`);

  const deadline = ctx.now() + grant.expiresIn * 1000;
  let wait = grant.interval * 1000;
  let failures = 0;
  for (;;) {
    if (ctx.now() + wait > deadline) {
      throw new Error('sign-in timed out; run npx innstance again');
    }
    await ctx.sleep(wait);
    try {
      res = await postJSON(origin + '/auth/device/poll', { device_code: grant.deviceCode });
      failures = 0;
    } catch (err) {
      if (++failures >= MAX_POLL_NETWORK_FAILURES) throw err;
      continue;
    }
    if (res.status === 202) continue;
    if (res.status === 429) {
      // The sign-in endpoints are rate limited per IP. Back off the way RFC
      // 8628's slow_down asks, rather than failing an approval in progress.
      wait = Math.min(wait + 5000, 30000);
      continue;
    }
    if (res.status === 410) throw new Error('sign-in expired; run npx innstance again');
    if (res.status !== 200) throw new Error(`sign-in failed: ${serverMessage(res)}`);
    const out = parseJSONBody(res);
    if (!out || typeof out !== 'object') throw new Error('could not read the sign-in response');
    if (out.status === 'denied') throw new Error('sign-in was cancelled in the browser');
    if (out.status !== 'approved') throw new Error(`unexpected sign-in state ${JSON.stringify(String(out.status))}`);
    if (!validToken(out.token)) throw new Error('the sign-in server returned an unusable token');
    return { token: out.token, email: typeof out.email === 'string' ? out.email : '' };
  }
}

module.exports = { signIn, checkGrant, trustedVerificationURL, validUserCode };
