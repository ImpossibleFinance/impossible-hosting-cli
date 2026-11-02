'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { main } = require('../lib/cli');
const toml = require('../lib/toml');
const { loadSession } = require('../lib/session');
const { makeContext, readJSON, startFakeServer, tempHome } = require('./helpers');

async function connectAll(t) {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, '.claude.json'), '{\n  "numStartups": 3,\n  "mcpServers": {\n    "keep": {"type": "stdio", "command": "x"}\n  }\n}\n');
  const setup = makeContext(home, server, { agents: ['claude', 'codex', 'cursor', 'opencode'] });
  assert.equal(await main([], setup.ctx), 0, setup.text());
  return { server, home, token: loadSession(setup.ctx).token };
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
  assert.equal(loadSession(ctx), null);
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
  assert.equal(loadSession(ctx).token, token);
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
  assert.ok(loadSession(ctx).token, 'the token is kept for a retry');
});
