'use strict';

// The control plane is the one origin this package talks to with a token:
// sign-in, the account check, the MCP endpoint and sign-out all live there.
// The MCP URL is derived from it rather than configured separately, because
// every agent config this package writes bakes that URL in, and a second knob
// would let the two drift apart.
const DEFAULT_ORIGIN = 'https://innstance.impossibuild.ai';

// The same override the Go CLI honours, so one environment variable points
// both clients at a local or staging control plane.
const ORIGIN_ENV = 'IMPOSSIBLE_API_URL';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// validateOrigin accepts https origins and plain-http loopback origins (local
// development and the tests), and nothing else. Mirrors the Go CLI's
// validateAPIURLOverride: a token is about to be sent here, so a path, query,
// credentials or a non-loopback http origin are refused rather than "fixed".
// A single trailing slash is tolerated because people paste origins that way.
function validateOrigin(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('not an absolute URL');
  }
  if (u.username || u.password) {
    throw new Error('must be an origin only (no credentials)');
  }
  const rest = raw.slice(u.origin.length);
  if (u.origin === 'null' || (rest !== '' && rest !== '/')) {
    throw new Error('must be an origin only (no path, query, or fragment)');
  }
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(u.hostname)) return u.origin;
    throw new Error('http is only allowed for loopback (localhost/127.0.0.1/::1)');
  }
  throw new Error(`scheme ${JSON.stringify(u.protocol.replace(/:$/, ''))} is not allowed`);
}

// resolveOrigin picks --server, then IMPOSSIBLE_API_URL, then the default.
// An invalid flag is an error (the person typed it just now); an invalid
// environment value is also an error here, unlike the Go CLI's warning,
// because this command's whole job is to write that origin into agent
// configs, and silently writing the default instead would be a surprise.
function resolveOrigin(flagValue, env) {
  const raw = flagValue || (env && env[ORIGIN_ENV]) || '';
  if (!raw) return DEFAULT_ORIGIN;
  const source = flagValue ? '--server' : ORIGIN_ENV;
  try {
    return validateOrigin(raw.trim());
  } catch (err) {
    throw new Error(`${source}=${JSON.stringify(raw)} is not usable: ${err.message}`);
  }
}

function mcpURL(origin) {
  return origin + '/mcp';
}

module.exports = { DEFAULT_ORIGIN, ORIGIN_ENV, validateOrigin, resolveOrigin, mcpURL };
