'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readTextIfExists, writeFileAtomic } = require('./fsutil');

// The npx session is its own sign-in, separate from the Go CLI's. Both live in
// ~/.impossible, but in different files, for a reason that matters: the
// server keeps one session per device name and replaces it on every sign-in.
// If this package reused the Go CLI's credentials, the next `innstance login`
// on the same machine would rotate that token and silently break every agent
// config written here. A separate device name ("npx-…") gives agents their
// own row in the dashboard's token list, revocable on its own.
//
// The token is kept here (owner-only) so `doctor` can check it and a second
// `npx innstance` run can connect another agent without a browser round trip.
const SESSION_FILE = 'npx-session.json';

function sessionPath(ctx) {
  return path.join(ctx.home, '.impossible', SESSION_FILE);
}

// RFC 6750 token68: what a bearer token may contain. Checked before a token
// is written into any config, so a malformed server answer can never inject
// quotes, newlines or anything else into a file someone else's tool parses.
const TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;

function validToken(token) {
  return typeof token === 'string' && token.length >= 16 && token.length <= 1024 && TOKEN_PATTERN.test(token);
}

function loadSession(ctx) {
  const text = readTextIfExists(sessionPath(ctx));
  if (text === null) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  return {
    server: typeof data.server === 'string' ? data.server : '',
    email: typeof data.email === 'string' ? data.email : '',
    token: validToken(data.token) ? data.token : '',
    deviceName: typeof data.device_name === 'string' ? data.device_name : '',
    deviceId: typeof data.device_id === 'string' && /^[0-9a-f]{4}$/.test(data.device_id) ? data.device_id : '',
  };
}

async function saveSession(ctx, session) {
  const body = {
    version: 1,
    server: session.server,
    email: session.email || '',
    token: session.token,
    device_name: session.deviceName || '',
    device_id: session.deviceId || '',
  };
  await writeFileAtomic(sessionPath(ctx), JSON.stringify(body, null, 2) + '\n');
}

function clearSession(ctx) {
  try {
    fs.unlinkSync(sessionPath(ctx));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// osLabel matches the Go CLI's words for the machine.
function osLabel(platform) {
  switch (platform) {
    case 'darwin':
      return 'mac';
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return platform;
  }
}

// The server turns the device name into the token name "cli-<slug>" and keeps
// at most 32 slug characters. The name is built to fit inside that, so the
// random id at the end — the part that keeps two machines with the same
// hostname apart — is never the part that gets cut.
const MAX_SLUG = 32;

function hostnameLabel(hostname, max) {
  let out = '';
  let lastDash = true;
  for (const ch of String(hostname || '').trim().toLowerCase()) {
    if (out.length >= max) break;
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      out += ch;
      lastDash = false;
    } else if ('-_ .'.includes(ch) && !lastDash) {
      out += '-';
      lastDash = true;
    }
  }
  out = out.replace(/^-+|-+$/g, '');
  return out === 'localhost' ? '' : out;
}

function newDeviceId() {
  return crypto.randomBytes(2).toString('hex');
}

// deviceName is "npx-<os>-<host>-<id>", e.g. npx-mac-studio-7f3a. The id is
// generated once per machine and kept in the session file, so signing in
// again here replaces this machine's npx session and no other.
function deviceName(platform, hostname, deviceId) {
  const prefix = `npx-${osLabel(platform)}`;
  const room = MAX_SLUG - prefix.length - deviceId.length - 2;
  const host = hostnameLabel(hostname, Math.max(0, room));
  return [prefix, host, deviceId].filter(Boolean).join('-');
}

module.exports = {
  sessionPath,
  loadSession,
  saveSession,
  clearSession,
  validToken,
  deviceName,
  newDeviceId,
  osLabel,
};
