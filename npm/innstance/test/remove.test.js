'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { main } = require('../lib/cli');
const toml = require('../lib/toml');
const { makeContext, readJSON, startFakeServer, tempHome, savedSession } = require('./helpers');

async function connectAll(t) {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, '.claude.json'), '{\n  "numStartups": 3,\n  "mcpServers": {\n    "keep": {"type": "stdio", "command": "x"}\n  }\n}\n');
  const setup = makeContext(home, server, { agents: ['claude', 'codex', 'cursor', 'opencode'] });
  assert.equal(await main([], setup.ctx), 0, setup.text());
  return { server, home, token: savedSession(setup.ctx).token };
}

test('remove undoes setup and ends the session', async (t) => {
  const { server, home, token } = await connectAll(t);
  const { ctx, text } = makeContext(home, server);
  assert.equal(await main(['remove'], ctx), 0, text());

  assert.deepEqual(readJSON(path.join(home, '.claude.json')), { numStartups: 3, mcpServers: { keep: { type: 'stdio', command: 'x' } } });
  assert.equal(readJSON(path.join(home, '.cursor', 'mcp.json')).mcpServers.innstance, undefined);
  assert.equal(readJSON(path.join(home, '.config', 'opencode', 'opencode.json')).mcp.innstance, undefined);
  assert.equal(toml.readServer(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), 'innstance'), null);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'innstance')), false);
  assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', 'innstance')), false);
  assert.equal(server.state.logouts, 1);
  assert.equal(server.validToken(token), false);
  assert.equal(savedSession(ctx), null);
  assert.ok(!text().includes(token));
});

test('remove --agents disconnects only those and keeps the shared session and skill', async (t) => {
  const { server, home, token } = await connectAll(t);
  const { ctx, text } = makeContext(home, server);
  assert.equal(await main(['remove', '--agents', 'cursor,claude'], ctx), 0, text());
  assert.equal(readJSON(path.join(home, '.cursor', 'mcp.json')).mcpServers.innstance, undefined);
  assert.equal(readJSON(path.join(home, '.claude.json')).mcpServers.innstance, undefined);
  assert.ok(readJSON(path.join(home, '.config', 'opencode', 'opencode.json')).mcp.innstance);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'innstance')), false, 'Claude Code has its own skill copy');
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'innstance', 'SKILL.md')), 'Codex and OpenCode still use the shared copy');
  assert.equal(server.state.logouts, 0);
  assert.equal(savedSession(ctx).token, token);
});

test('remove leaves an innstance entry that points somewhere else', async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  const file = path.join(home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const theirs = '{"mcpServers": {"innstance": {"url": "https://mirror.example/mcp"}}}\n';
  fs.writeFileSync(file, theirs);
  const { ctx, text } = makeContext(home, server);
  assert.equal(await main(['remove'], ctx), 0, text());
  assert.equal(fs.readFileSync(file, 'utf8'), theirs);
  assert.match(text(), /left ~?.*mcp\.json alone \(its innstance entry points at https:\/\/mirror\.example\/mcp\)/);
});

test('remove keeps the session when the server cannot be reached, so it can be retried', async (t) => {
  const { server, home } = await connectAll(t);
  await server.close();
  const { ctx, err } = makeContext(home, server);
  assert.equal(await main(['remove'], ctx), 1);
  assert.match(err.join('\n'), /could not end it/);
  assert.ok(savedSession(ctx).token, 'the token is kept for a retry');
});

test('remove keeps the session when the server does not end it', async (t) => {
  const cases = [
    { name: 'server error', state: { logoutStatus: 500 }, want: /could not end it \(the server did not end it: could not end the session \(HTTP 500\)\)/ },
    { name: 'rate limited', state: { logoutStatus: 429 }, want: /HTTP 429/ },
    { name: 'refused as not a session', state: { logoutReason: 'this is an API token, not a session.' }, want: /not ended \(this is an API token, not a session\.\); revoke it from/ },
  ];
  for (const c of cases) {
    const { server, home, token } = await connectAll(t);
    Object.assign(server.state, c.state);
    const { ctx, err, text } = makeContext(home, server);
    assert.equal(await main(['remove'], ctx), 1, `${c.name}: ${text()}`);
    assert.match(err.join('\n'), c.want, c.name);
    assert.equal(savedSession(ctx).token, token, `${c.name}: the token is kept so remove can be run again`);
    assert.equal(server.validToken(token), true, c.name);
    assert.doesNotMatch(text(), /forgotten on this machine/, c.name);

    // Once the server answers, a second remove ends and forgets it.
    Object.assign(server.state, { logoutStatus: 200, logoutReason: '' });
    const again = makeContext(home, server);
    assert.equal(await main(['remove'], again.ctx), 0, `${c.name}: ${again.text()}`);
    assert.equal(server.validToken(token), false, c.name);
    assert.equal(savedSession(again.ctx), null, c.name);
  }
});

test('remove ends only the session for its control plane', async (t) => {
  const { server, home, token } = await connectAll(t);
  const staging = await startFakeServer();
  t.after(staging.close);
  const other = makeContext(home, staging);
  assert.equal(await main(['--agents', 'cursor', '--force'], other.ctx), 0, other.text());
  const stagingToken = savedSession(other.ctx).token;

  const { ctx, text } = makeContext(home, server);
  assert.equal(await main(['remove'], ctx), 0, text());
  assert.equal(server.validToken(token), false);
  assert.equal(savedSession(ctx), null);
  assert.match(text(), new RegExp(`also signed in to ${staging.origin}; to end that: npx innstance remove --server ${staging.origin}`));
  assert.equal(savedSession(other.ctx).token, stagingToken, 'the other plane\'s session is kept');

  const end = makeContext(home, staging);
  assert.equal(await main(['remove'], end.ctx), 0, end.text());
  assert.equal(staging.validToken(stagingToken), false);
});
