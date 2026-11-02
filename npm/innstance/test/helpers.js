'use strict';

// Shared test support: a fake control plane that speaks the device flow,
// /auth/me, /auth/logout, /health and a minimal MCP endpoint, plus a context
// that runs commands against a temporary home. (node --test also loads this
// file as a test file; it defines no tests, so that is harmless.)

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// The repository and version of the shipped pin (lib/skill-pin.json); test
// skills use the same ones so the pin validation applies to them unchanged.
const SKILL_REPOSITORY = 'ImpossibleFinance/impossible-hosting-skill';
const SKILL_VERSION = '20260924-1';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// testSkill builds skill files and a matching pin, so the install path runs
// for real without the published skill in the test fixtures.
function testSkill(version = SKILL_VERSION) {
  const files = {
    'SKILL.md': Buffer.from(`---\nname: innstance\n---\n# test skill ${version}\n`),
    'RUNBOOK.md': Buffer.from(`# runbook ${version}\n`),
    'manifest.json': Buffer.from(JSON.stringify({ version }, null, 2) + '\n'),
  };
  const pin = {
    repository: SKILL_REPOSITORY,
    commit: 'a'.repeat(40),
    version,
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(v)])),
  };
  return { files, pin };
}

function newToken() {
  return 'imp_' + crypto.randomBytes(32).toString('hex');
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

function bearerOf(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : '';
}

// startFakeServer returns { origin, state, close }. state is mutable from the
// test: pending polls before approval, denial, how /mcp answers, and so on.
// Like the real server, a sign-in replaces the previous session minted for
// the same device name.
async function startFakeServer(overrides = {}) {
  const skill = testSkill();
  const state = {
    email: 'dev@example.com',
    pendingPolls: 1,
    deny: false,
    mcp: 'json', // json | sse | missing | 500 | refuse (401 for every token) | 403
    healthStatus: 200,
    logoutStatus: 200, // anything else: the server fails to end the session
    logoutReason: '', // a 200 that ends nothing, with this reason
    grant: null, // override the start response body
    startStatus: 200,
    pollStatus: null, // force one status for every poll
    dropPolls: 0, // cut the connection on this many polls first
    sessions: new Map(), // device name -> token
    deviceNames: [],
    polls: 0,
    logouts: 0,
    mcpDeletes: 0,
    requests: [],
    skillFiles: skill.files,
    skillPin: skill.pin,
    ...overrides,
  };
  const valid = (token) => [...state.sessions.values()].includes(token);
  let origin = '';
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, origin);
    state.requests.push({ method: req.method, path: url.pathname, auth: bearerOf(req) });
    const route = `${req.method} ${url.pathname}`;
    if (route === 'POST /auth/device/start') {
      if (state.startStatus !== 200) return json(res, state.startStatus, { error: 'start refused' });
      const { device_name: name } = JSON.parse(body);
      state.deviceNames.push(name);
      state.currentDevice = name;
      state.polls = 0;
      return json(
        res,
        200,
        state.grant || {
          device_code: crypto.randomBytes(32).toString('hex'),
          user_code: 'ABCD-EFGH',
          verification_url: origin + '/auth/device',
          interval: 1,
          expires_in: 60,
        },
      );
    }
    if (route === 'POST /auth/device/poll') {
      if (state.dropPolls > 0) {
        state.dropPolls--;
        req.socket.destroy();
        return;
      }
      state.polls++;
      if (state.pollStatus) return json(res, state.pollStatus, { error: 'forced' });
      if (state.polls <= state.pendingPolls) return json(res, 202, { status: 'pending' });
      if (state.deny) return json(res, 200, { status: 'denied' });
      const token = newToken();
      state.sessions.set(state.currentDevice, token);
      return json(res, 200, { status: 'approved', token, email: state.email });
    }
    if (route === 'GET /auth/me') {
      if (!valid(bearerOf(req))) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { id: 'u1', email: state.email, plan_tier: 'free' });
    }
    if (route === 'POST /auth/logout') {
      const token = bearerOf(req);
      if (!valid(token)) return json(res, 401, { error: 'unauthorized' });
      if (state.logoutStatus !== 200) return json(res, state.logoutStatus, { error: 'could not end the session' });
      if (state.logoutReason) return json(res, 200, { revoked: false, reason: state.logoutReason });
      for (const [name, t] of state.sessions) if (t === token) state.sessions.delete(name);
      state.logouts++;
      return json(res, 200, { revoked: true });
    }
    if (route === 'GET /health') {
      return json(res, state.healthStatus, { status: state.healthStatus === 200 ? 'ok' : 'error' });
    }
    if (url.pathname === '/mcp') {
      if (state.mcp === 'missing') return json(res, 404, { error: 'not found' });
      if (state.mcp === '500') return json(res, 500, { error: 'boom' });
      if (state.mcp === 'refuse' || !valid(bearerOf(req))) return json(res, 401, { error: 'unauthorized' });
      if (state.mcp === '403') return json(res, 403, { error: 'this token may not use MCP' });
      if (req.method === 'DELETE') {
        state.mcpDeletes++;
        res.writeHead(204);
        return res.end();
      }
      const message = JSON.parse(body);
      const reply = {
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'innstance', version: '0.0.1' } },
      };
      if (state.mcp === 'sse') {
        // Leave the stream open after the response, as a server may; the
        // client must stop reading once it has what it asked for.
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sess-1' });
        res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        return;
      }
      return json(res, 200, reply, { 'Mcp-Session-Id': 'sess-1' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/skill/')) {
      const file = state.skillFiles[url.pathname.slice('/skill/'.length)];
      if (!file) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(file);
    }
    json(res, 404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    state,
    validToken: valid,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections && server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innstance-npx-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// makeContext returns a context bound to a temporary home and a fake server,
// with captured output. Pass agents to create their config directories, so
// detection finds them.
function makeContext(home, server, { agents = [], env = {} } = {}) {
  const dirs = {
    claude: path.join(home, '.claude'),
    codex: path.join(home, '.codex'),
    cursor: path.join(home, '.cursor'),
    opencode: path.join(home, '.config', 'opencode'),
  };
  for (const id of agents) fs.mkdirSync(dirs[id], { recursive: true });
  const out = [];
  const err = [];
  const opened = [];
  const ctx = {
    home,
    platform: process.platform,
    env: { IMPOSSIBLE_API_URL: server ? server.origin : undefined, ...env },
    hostname: 'Test-Laptop.local',
    nodeVersion: process.versions.node,
    out: (line = '') => out.push(line),
    err: (line = '') => err.push(line),
    openBrowser: (url) => {
      opened.push(url);
      return true;
    },
    sleep: async () => {},
    now: () => Date.now(),
    which: () => null,
    skillBaseURL: server ? server.origin + '/skill' : undefined,
    skillPin: server ? server.state.skillPin : undefined,
  };
  return { ctx, out, err, opened, text: () => out.concat(err).join('\n') };
}

// savedSession is the session this machine saved for the control plane the
// context points at.
function savedSession(ctx) {
  return require('../lib/session').loadSession(ctx, ctx.env.IMPOSSIBLE_API_URL);
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

module.exports = { startFakeServer, makeContext, tempHome, testSkill, newToken, readJSON, mode, sha256, savedSession };
