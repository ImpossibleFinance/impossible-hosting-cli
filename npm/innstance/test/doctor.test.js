'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { main } = require('../lib/cli');
const { makeContext, startFakeServer, tempHome } = require('./helpers');

async function connected(t, overrides = {}) {
  const server = await startFakeServer(overrides);
  t.after(server.close);
  const home = tempHome(t);
  const setup = makeContext(home, server, { agents: ['claude', 'cursor'] });
  assert.equal(await main([], setup.ctx), 0, setup.text());
  return { server, home };
}

function line(output, label) {
  return output.split('\n').find((l) => l.includes(label)) || '';
}

test('doctor passes on a healthy setup and changes nothing', async (t) => {
  const { server, home } = await connected(t);
  const before = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
  const { ctx, text } = makeContext(home, server);
  assert.equal(await main(['doctor'], ctx), 0, text());
  const out = text();
  for (const label of ['Node.js', 'Control plane', 'Session', 'MCP endpoint', 'Claude Code', 'Cursor']) {
    assert.match(line(out, label), /^ {2}ok/, label);
  }
  assert.match(line(out, 'Session'), /dev@example\.com \(Free plan\)/);
  assert.match(line(out, 'Claude Code'), /skill 20260924-1/);
  assert.equal(line(out, 'Codex'), '', 'agents that are not installed are not mentioned');
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), before);
  assert.equal(server.state.deviceNames.length, 1, 'doctor never signs in');
});

test('doctor names what is wrong and exits 1', async (t) => {
  const cases = [
    {
      name: 'session revoked from the dashboard',
      break: ({ server }) => server.state.sessions.clear(),
      label: 'Session',
      want: /fail .*has ended.*--relogin/,
    },
    {
      name: 'an agent holds an older token',
      break: ({ home }) => {
        const file = path.join(home, '.cursor', 'mcp.json');
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        doc.mcpServers.innstance.headers.Authorization = 'Bearer imp_' + '0'.repeat(64);
        fs.writeFileSync(file, JSON.stringify(doc));
      },
      label: 'Cursor',
      want: /fail .*holds a token that has ended.*npx innstance --agents cursor/,
    },
    {
      name: 'MCP endpoint rolled back while agents are connected',
      break: ({ server }) => (server.state.mcp = 'missing'),
      label: 'Cursor',
      want: /fail .*connected in .*, but .*\/mcp is not available on this server/,
    },
    {
      name: 'session forgotten here and the agent token revoked',
      break: ({ server, home }) => {
        fs.rmSync(path.join(home, '.impossible', 'npx-session.json'));
        server.state.sessions.clear();
      },
      label: 'Claude Code',
      want: /fail .*holds a token that has ended/,
    },
    {
      name: 'an agent config no longer parses',
      break: ({ home }) => fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), '{oops'),
      label: 'Cursor',
      want: /fail .*could not be read/,
    },
    {
      name: 'control plane unhealthy',
      break: ({ server }) => (server.state.healthStatus = 503),
      label: 'Control plane',
      want: /fail .*HTTP 503/,
    },
    {
      name: 'MCP endpoint failing',
      break: ({ server }) => (server.state.mcp = '500'),
      label: 'MCP endpoint',
      want: /fail .*HTTP 500/,
    },
  ];
  for (const c of cases) {
    const env = await connected(t);
    c.break(env);
    const { ctx, text } = makeContext(env.home, env.server);
    assert.equal(await main(['doctor'], ctx), 1, `${c.name}: ${text()}`);
    assert.match(line(text(), c.label), c.want, c.name);
  }
});

test('doctor warns, without failing, about steps not taken yet', async (t) => {
  const server = await startFakeServer({ mcp: 'missing' });
  t.after(server.close);
  const { ctx, text } = makeContext(tempHome(t), server, { agents: ['codex'] });
  assert.equal(await main(['doctor'], ctx), 0, text());
  assert.match(line(text(), 'Session'), /warn .*not signed in/);
  assert.match(line(text(), 'MCP endpoint'), /warn .*not available/);
  assert.match(line(text(), 'Codex'), /warn .*not connected; run: npx innstance --agents codex/);
  assert.match(text(), /No failures; 3 warnings above\./);
});

test('doctor reports an unreachable control plane', async (t) => {
  const { ctx, text } = makeContext(tempHome(t), null, { env: { IMPOSSIBLE_API_URL: 'http://127.0.0.1:1' } });
  assert.equal(await main(['doctor'], ctx), 1);
  assert.match(line(text(), 'Control plane'), /fail .*could not reach/);
});

test('doctor names plans the way people buy them', async (t) => {
  const cases = [
    { tier: 'free', want: 'Free' },
    { tier: 'hobby', want: 'Hobby' },
    { tier: 'pro', want: 'Pro' },
    { tier: 'team', want: 'Studio' },
  ];
  const { server, home } = await connected(t);
  for (const c of cases) {
    server.state.planTier = c.tier;
    const { ctx, text } = makeContext(home, server);
    assert.equal(await main(['doctor'], ctx), 0, text());
    assert.match(line(text(), 'Session'), new RegExp(`\\(${c.want} plan\\)`), c.tier);
  }
});

test('doctor checks the agents\' own tokens when this machine has no saved session', async (t) => {
  const { server, home } = await connected(t);
  fs.rmSync(path.join(home, '.impossible', 'npx-session.json'));
  const { ctx, text } = makeContext(home, server);
  assert.equal(await main(['doctor'], ctx), 0, text());
  assert.match(line(text(), 'Session'), /warn .*not signed in/);
  assert.match(line(text(), 'MCP endpoint'), /ok .*initialized/, 'probed with the agent\'s working token');
  assert.match(line(text(), 'Cursor'), /ok .*connected/);
});

test('doctor warns about a token file other users can read', { skip: process.platform === 'win32' }, async (t) => {
  const { server, home } = await connected(t);
  fs.chmodSync(path.join(home, '.cursor', 'mcp.json'), 0o644);
  const { ctx, text } = makeContext(home, server);
  assert.equal(await main(['doctor'], ctx), 0, text());
  assert.match(text(), /warn {2}Cursor: .*readable by other users \(mode 644\); run: npx innstance --agents cursor/);
});

test('doctor warns about a token file inside a git repository', async (t) => {
  const { server, home } = await connected(t);
  fs.mkdirSync(path.join(home, '.cursor', '.git'));
  const { ctx, text } = makeContext(home, server);
  assert.equal(await main(['doctor'], ctx), 0, text());
  assert.match(text(), /warn {2}Cursor: .*mcp\.json is inside the git repository at .*\.cursor, where the token could be committed/);
});
