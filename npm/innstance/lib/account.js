'use strict';

const { request, postJSON, parseJSONBody, serverMessage } = require('./http');

// whoami checks a token against GET /auth/me. A 401 is an answer ("this
// session has ended": revoked from the dashboard, or replaced by a newer
// sign-in on the same device name), not an error; anything else unexpected
// is, because guessing would either discard a good session or keep a dead one.
async function whoami(origin, token) {
  const res = await request('GET', origin + '/auth/me', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401) return { valid: false };
  if (res.status !== 200) throw new Error(`could not check the session: ${serverMessage(res)}`);
  const me = parseJSONBody(res) || {};
  return {
    valid: true,
    email: typeof me.email === 'string' ? me.email : '',
    plan: typeof me.plan_tier === 'string' ? me.plan_tier : '',
  };
}

// logout ends the session on the server (POST /auth/logout). The server only
// ever revokes session slots this way, never an API token someone pasted, so
// this cannot sign out another machine.
async function logout(origin, token) {
  const res = await postJSON(origin + '/auth/logout', {}, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) return { revoked: false, detail: 'the session had already ended' };
  if (res.status !== 200) return { revoked: false, detail: serverMessage(res) };
  const out = parseJSONBody(res) || {};
  return { revoked: out.revoked === true, detail: typeof out.reason === 'string' ? out.reason : '' };
}

async function health(origin) {
  const started = Date.now();
  const res = await request('GET', origin + '/health', { timeoutMs: 10000 });
  return { ok: res.status === 200, status: res.status, ms: Date.now() - started };
}

module.exports = { whoami, logout, health };
