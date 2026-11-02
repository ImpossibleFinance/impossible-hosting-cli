'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readTextIfExists, withFileLock, writeFileAtomic } = require('./fsutil');
const { validateOrigin } = require('./origin');

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
//
// The file holds one session per control plane, keyed by origin, so setting
// up against a staging plane (--server) does not forget the production
// session: each can still be reused, checked and ended on its own. The
// device id is one per machine and shared by all of them.
//
//   { "version": 2, "device_id": "7f3a",
//     "sessions": { "<origin>": { "email", "token", "device_name" } } }
//
// Version 1 files (a single session with a "server" field) are still read.
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

function validDeviceId(id) {
  return typeof id === 'string' && /^[0-9a-f]{4}$/.test(id);
}

function usableOrigin(origin) {
  try {
    return validateOrigin(origin) === origin;
  } catch {
    return false;
  }
}

// readFile returns { deviceId, sessions } with sessions a Map of origin to
// { email, token, deviceName }. A missing or damaged file reads as empty.
function readFile(ctx) {
  const empty = { deviceId: '', sessions: new Map() };
  const text = readTextIfExists(sessionPath(ctx));
  if (text === null) return empty;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!data || typeof data !== 'object') return empty;
  const entries =
    data.sessions && typeof data.sessions === 'object'
      ? Object.entries(data.sessions)
      : typeof data.server === 'string'
        ? [[data.server, data]] // version 1
        : [];
  const sessions = new Map();
  for (const [origin, entry] of entries) {
    if (!usableOrigin(origin) || !entry || typeof entry !== 'object') continue;
    sessions.set(origin, {
      email: typeof entry.email === 'string' ? entry.email : '',
      token: validToken(entry.token) ? entry.token : '',
      deviceName: typeof entry.device_name === 'string' ? entry.device_name : '',
    });
  }
  return { deviceId: validDeviceId(data.device_id) ? data.device_id : '', sessions };
}

async function writeFile(ctx, deviceId, sessions) {
  const body = { version: 2, device_id: deviceId, sessions: {} };
  for (const [origin, entry] of sessions) {
    body.sessions[origin] = { email: entry.email || '', token: entry.token, device_name: entry.deviceName || '' };
  }
  await writeFileAtomic(sessionPath(ctx), JSON.stringify(body, null, 2) + '\n');
}

// loadSession returns this machine's saved session for one control plane,
// or null when there is none.
function loadSession(ctx, origin) {
  const { deviceId, sessions } = readFile(ctx);
  const entry = sessions.get(origin);
  return entry ? { server: origin, ...entry, deviceId } : null;
}

// machineDeviceId is the id this machine already uses in its device names,
// or '' before the first sign-in.
function machineDeviceId(ctx) {
  return readFile(ctx).deviceId;
}

// savedOrigins lists the control planes this machine has a session for.
function savedOrigins(ctx) {
  return [...readFile(ctx).sessions.keys()];
}

async function saveSession(ctx, session) {
  await withFileLock(sessionPath(ctx), async () => {
    const { deviceId, sessions } = readFile(ctx);
    sessions.set(session.server, { email: session.email, token: session.token, deviceName: session.deviceName });
    await writeFile(ctx, session.deviceId || deviceId, sessions);
  });
}

// clearSession forgets one control plane's session, and the file with it
// once no session is left. Returns whether there was one to forget.
async function clearSession(ctx, origin) {
  let removed = false;
  await withFileLock(sessionPath(ctx), async () => {
    const { deviceId, sessions } = readFile(ctx);
    removed = sessions.delete(origin);
    if (!removed) return;
    if (sessions.size > 0) {
      await writeFile(ctx, deviceId, sessions);
      return;
    }
    try {
      fs.unlinkSync(sessionPath(ctx));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  });
  return removed;
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
  machineDeviceId,
  savedOrigins,
  validToken,
  deviceName,
  newDeviceId,
  osLabel,
};
