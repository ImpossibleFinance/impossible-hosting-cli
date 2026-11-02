'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { main } = require('../lib/cli');
const jsonc = require('../lib/jsonc');
const toml = require('../lib/toml');
const { loadSession, sessionPath } = require('../lib/session');
const { makeContext, mode, readJSON, startFakeServer, tempHome } = require('./helpers');

const ALL = ['claude', 'codex', 'cursor', 'opencode'];

function configPaths(home) {
  return {
    claude: path.join(home, '.claude.json'),
    codex: path.join(home, '.codex', 'config.toml'),
    cursor: path.join(home, '.cursor', 'mcp.json'),
    opencode: path.join(home, '.config', 'opencode', 'opencode.json'),
  };
}

// tokensIn returns the bearer token each agent config holds.
function tokensIn(home) {
  const p = configPaths(home);
  const bearer = (v) => (v ? v.replace(/^Bearer /, '') : undefined);
  const read = (file, pathParts) => {
    if (!fs.existsSync(file)) return undefined;
    const entry = jsonc.getAt(jsonc.parse(fs.readFileSync(file, 'utf8')), pathParts);
    return entry && bearer(entry.headers && entry.headers.Authorization);
  };
  const codex = fs.existsSync(p.codex) ? toml.readServer(fs.readFileSync(p.codex, 'utf8'), 'innstance') : null;
  return {
    claude: read(p.claude, ['mcpServers', 'innstance']),
    codex: codex ? bearer(codex.http_headers.Authorization) : undefined,
    cursor: read(p.cursor, ['mcpServers', 'innstance']),
    opencode: read(p.opencode, ['mcp', 'innstance']),
  };
}

test('setup signs in once and connects every installed agent', async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  const p = configPaths(home);
  // Pre-existing settings that must survive untouched.
  fs.writeFileSync(p.claude, '{\n  "numStartups": 42,\n  "mcpServers": {\n    "other": {"type": "stdio", "command": "x"}\n  }\n}\n', { mode: 0o644 });
  fs.mkdirSync(path.dirname(p.codex), { recursive: true });
  fs.writeFileSync(p.codex, 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
  fs.mkdirSync(path.dirname(p.opencode), { recursive: true });
  fs.writeFileSync(p.opencode, '{\n  // my model\n  "model": "x",\n}\n');
  const { ctx, out, err, opened, text } = makeContext(home, server, { agents: ALL });

  const code = await main([], ctx);
  assert.equal(code, 0, text());

  const session = loadSession(ctx);
  assert.match(session.deviceName, /^npx-[a-z0-9]+-test-laptop[a-z-]*-[0-9a-f]{4}$/);
  assert.deepEqual(server.state.deviceNames, [session.deviceName]);
  assert.equal(opened.length, 1);

  const tokens = tokensIn(home);
  for (const id of ALL) assert.equal(tokens[id], session.token, `${id} holds the session token`);

  const claude = readJSON(p.claude);
  assert.equal(claude.numStartups, 42);
  assert.deepEqual(claude.mcpServers.other, { type: 'stdio', command: 'x' });
  assert.deepEqual(claude.mcpServers.innstance, {
    type: 'http',
    url: server.origin + '/mcp',
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const cursor = readJSON(p.cursor);
  assert.deepEqual(cursor.mcpServers.innstance, { url: server.origin + '/mcp', headers: { Authorization: `Bearer ${session.token}` } });
  const opencodeText = fs.readFileSync(p.opencode, 'utf8');
  assert.match(opencodeText, /\/\/ my model/, 'comments in opencode.json are kept');
  assert.deepEqual(jsonc.parse(opencodeText).mcp.innstance, {
    type: 'remote',
    url: server.origin + '/mcp',
    enabled: true,
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const codexText = fs.readFileSync(p.codex, 'utf8');
  assert.match(codexText, /^model = "o3"\n\n\[mcp_servers\.other\]\ncommand = "x"\n\n\[mcp_servers\.innstance\]\n/);

  if (process.platform !== 'win32') {
    for (const file of Object.values(p).concat(sessionPath(ctx))) assert.equal(mode(file), 0o600, file);
  }

  for (const dir of [path.join(home, '.claude', 'skills', 'innstance'), path.join(home, '.agents', 'skills', 'innstance')]) {
    assert.equal(readJSON(path.join(dir, 'manifest.json')).version, server.state.skillPin.version, dir);
    assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, 'RUNBOOK.md')));
  }

  assert.ok(!out.concat(err).join('\n').includes(session.token), 'the token is never printed');
  assert.match(out.join('\n'), /Next steps/);
  assert.match(out.join('\n'), /"cli-npx-/);
});

test('a second run reuses the saved session and connects a newly named agent', async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  const first = makeContext(home, server, { agents: ['claude'] });
  assert.equal(await main([], first.ctx), 0, first.text());
  const token = loadSession(first.ctx).token;

  const second = makeContext(home, server);
  assert.equal(await main(['--agents', 'cursor'], second.ctx), 0, second.text());
  assert.equal(server.state.deviceNames.length, 1, 'no second browser sign-in');
  assert.deepEqual(second.opened, []);
  assert.match(second.out.join('\n'), /saved session/);
  const tokens = tokensIn(home);
  assert.equal(tokens.cursor, token);
  assert.equal(tokens.claude, token);
});

test('--relogin replaces the session and refreshes every connected agent', async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  const first = makeContext(home, server, { agents: ['claude', 'codex'] });
  assert.equal(await main([], first.ctx), 0, first.text());
  const before = loadSession(first.ctx);

  // Sign in again but name only Cursor: the claude and codex agents still
  // point at this endpoint, so they must get the new token too.
  const again = makeContext(home, server);
  assert.equal(await main(['--relogin', '--agents', 'cursor'], again.ctx), 0, again.text());
  const after = loadSession(again.ctx);
  assert.equal(after.deviceName, before.deviceName, 'same machine, same session name');
  assert.notEqual(after.token, before.token);
  assert.equal(server.validToken(before.token), false, 'the server replaced the old session');
  const tokens = tokensIn(home);
  for (const id of ['claude', 'codex', 'cursor']) assert.equal(tokens[id], after.token, id);
  assert.match(again.out.join('\n'), /Codex: gave the new session to the "innstance" MCP server/);
});

test('a refresh changes only the url and token, keeping what the person set', async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  const p = configPaths(home);
  const first = makeContext(home, server, { agents: ['claude', 'codex', 'opencode'] });
  assert.equal(await main([], first.ctx), 0, first.text());

  // The person turns the server off in OpenCode and Codex, and tunes Codex.
  const opencode = jsonc.setAt(jsonc.setAt(fs.readFileSync(p.opencode, 'utf8'), ['mcp', 'innstance', 'enabled'], false), ['mcp', 'innstance', 'timeout'], 30000);
  fs.writeFileSync(p.opencode, opencode);
  const custom = 'enabled = false\ndisabled_tools = ["delete_app"]\ntool_timeout_sec = 300\n\n[mcp_servers.innstance.tools.deploy]\napproval_mode = "prompt"\n';
  fs.writeFileSync(p.codex, fs.readFileSync(p.codex, 'utf8') + custom);

  // Naming only claude with the saved session touches nothing else.
  const reused = makeContext(home, server);
  assert.equal(await main(['--agents', 'claude'], reused.ctx), 0, reused.text());
  assert.equal(fs.readFileSync(p.opencode, 'utf8'), opencode);
  assert.ok(fs.readFileSync(p.codex, 'utf8').endsWith(custom));

  // A new sign-in refreshes them, and only their url and token change.
  const again = makeContext(home, server);
  assert.equal(await main(['--relogin', '--agents', 'claude'], again.ctx), 0, again.text());
  const token = loadSession(again.ctx).token;
  const entry = jsonc.parse(fs.readFileSync(p.opencode, 'utf8')).mcp.innstance;
  assert.equal(entry.enabled, false, 'OpenCode stays disabled');
  assert.equal(entry.timeout, 30000);
  assert.equal(entry.headers.Authorization, `Bearer ${token}`);
  const codex = fs.readFileSync(p.codex, 'utf8');
  assert.ok(codex.endsWith(custom), 'Codex keeps enabled = false, its tool settings and subtables');
  assert.equal(tokensIn(home).codex, token);
});

test('setup leaves an innstance entry it did not write unless --force', async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  const p = configPaths(home);
  fs.mkdirSync(path.dirname(p.cursor), { recursive: true });
  const theirs = '{"mcpServers": {"innstance": {"command": "my-local-thing", "args": ["--x"]}}}\n';
  fs.writeFileSync(p.cursor, theirs);
  const { ctx, err, text } = makeContext(home, server, { agents: ['cursor', 'claude'] });
  assert.equal(await main([], ctx), 1, text());
  assert.equal(fs.readFileSync(p.cursor, 'utf8'), theirs);
  assert.match(err.join('\n'), /Cursor: left .*mcp\.json alone: its "innstance" server runs a local command; re-run with --force/);
  assert.ok(tokensIn(home).claude, 'the other agent is still connected');

  const forced = makeContext(home, server);
  assert.equal(await main(['--agents', 'cursor', '--force'], forced.ctx), 0, forced.text());
  assert.deepEqual(readJSON(p.cursor).mcpServers.innstance, { url: server.origin + '/mcp', headers: { Authorization: `Bearer ${loadSession(forced.ctx).token}` } });
  assert.match(forced.text(), /replaced the "innstance" entry \(--force\)/);
});

test('no agent is left holding a token a new sign-in ended', async (t) => {
  // MCP is refusing every token: setup signs in again (--relogin), which
  // ends the old session, and must still hand the new token to the agent
  // connected earlier even though it writes no new config.
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  const first = makeContext(home, server, { agents: ['cursor'] });
  assert.equal(await main([], first.ctx), 0, first.text());
  server.state.mcp = 'refuse';
  const again = makeContext(home, server);
  assert.equal(await main(['--relogin'], again.ctx), 1, again.text());
  const token = loadSession(again.ctx).token;
  assert.equal(tokensIn(home).cursor, token);
  assert.equal(server.validToken(token), true);
  assert.match(again.err.join('\n'), /refused this token/);
});

test('a session revoked from the dashboard leads to a fresh sign-in', async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  const first = makeContext(home, server, { agents: ['cursor'] });
  assert.equal(await main([], first.ctx), 0);
  server.state.sessions.clear();
  const second = makeContext(home, server);
  assert.equal(await main([], second.ctx), 0, second.text());
  assert.match(second.out.join('\n'), /has ended; signing in again/);
  assert.equal(server.state.deviceNames.length, 2);
  assert.equal(tokensIn(home).cursor, loadSession(second.ctx).token);
});

test('setup with nothing to connect stops before sign-in', async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const { ctx, err } = makeContext(tempHome(t), server);
  assert.equal(await main([], ctx), 1);
  assert.match(err.join('\n'), /No supported coding agent/);
  assert.deepEqual(server.state.deviceNames, []);
});

test('setup does not write configs for an MCP endpoint that is not live', async (t) => {
  const cases = [
    { name: 'not deployed', mcp: 'missing', code: 0, configs: false, signedIn: false, message: /not available on this server yet, so this machine was not signed in/ },
    { name: 'token not allowed', mcp: '403', code: 1, configs: false, message: /does not allow this session.*npx innstance@latest/ },
    { name: 'outage', mcp: '500', code: 0, configs: true, message: /writing the configs anyway/ },
    { name: 'not checked', mcp: 'missing', flags: ['--skip-mcp-check'], code: 0, configs: true, message: /not checked/ },
  ];
  for (const c of cases) {
    const server = await startFakeServer({ mcp: c.mcp });
    const home = tempHome(t);
    const { ctx, text } = makeContext(home, server, { agents: ['cursor'] });
    assert.equal(await main(c.flags || [], ctx), c.code, `${c.name}: ${text()}`);
    assert.equal(fs.existsSync(configPaths(home).cursor), c.configs, c.name);
    assert.match(text(), c.message, c.name);
    assert.equal(server.state.deviceNames.length, c.signedIn === false ? 0 : 1, `${c.name}: signed in?`);
    assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'innstance', 'SKILL.md')), `${c.name}: the skill is installed regardless`);
    await server.close();
  }
});

test('a broken config is reported and left exactly as it was', async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  const p = configPaths(home);
  fs.mkdirSync(path.dirname(p.cursor), { recursive: true });
  fs.writeFileSync(p.cursor, '{"mcpServers": {"a": 1,,}}');
  fs.mkdirSync(path.dirname(p.codex), { recursive: true });
  fs.writeFileSync(p.codex, '[mcp_servers]\ninnstance = { url = "x" }\n');
  const { ctx, err, text } = makeContext(home, server, { agents: ['cursor', 'codex', 'claude'] });
  assert.equal(await main([], ctx), 1, text());
  assert.equal(fs.readFileSync(p.cursor, 'utf8'), '{"mcpServers": {"a": 1,,}}');
  assert.equal(fs.readFileSync(p.codex, 'utf8'), '[mcp_servers]\ninnstance = { url = "x" }\n');
  assert.match(err.join('\n'), /Cursor: .*mcp\.json was not changed/);
  assert.match(err.join('\n'), /Codex: .*inline table/);
  assert.equal(readJSON(p.claude).mcpServers.innstance.headers.Authorization, `Bearer ${loadSession(ctx).token}`, 'the healthy agent is still connected');
});

test('setup follows a symlinked config instead of replacing the link', { skip: process.platform === 'win32' }, async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  const dotfiles = path.join(home, 'dotfiles');
  fs.mkdirSync(dotfiles);
  fs.writeFileSync(path.join(dotfiles, 'mcp.json'), '{}\n');
  fs.mkdirSync(path.join(home, '.cursor'));
  fs.symlinkSync(path.join(dotfiles, 'mcp.json'), path.join(home, '.cursor', 'mcp.json'));
  const { ctx, text } = makeContext(home, server, { agents: ['cursor'] });
  assert.equal(await main([], ctx), 0, text());
  assert.ok(fs.lstatSync(path.join(home, '.cursor', 'mcp.json')).isSymbolicLink());
  assert.ok(readJSON(path.join(dotfiles, 'mcp.json')).mcpServers.innstance);
});

test('CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_CONFIG_HOME move the configs', async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const home = tempHome(t);
  const custom = path.join(home, 'custom');
  const env = {
    CLAUDE_CONFIG_DIR: path.join(custom, 'claude'),
    CODEX_HOME: path.join(custom, 'codex'),
    XDG_CONFIG_HOME: path.join(custom, 'xdg'),
  };
  const { ctx, text } = makeContext(home, server, { env });
  assert.equal(await main(['--agents', 'all'], ctx), 0, text());
  assert.ok(readJSON(path.join(custom, 'claude', '.claude.json')).mcpServers.innstance);
  assert.ok(fs.existsSync(path.join(custom, 'claude', 'skills', 'innstance', 'SKILL.md')));
  assert.ok(toml.readServer(fs.readFileSync(path.join(custom, 'codex', 'config.toml'), 'utf8'), 'innstance'));
  assert.ok(readJSON(path.join(custom, 'xdg', 'opencode', 'opencode.json')).mcp.innstance);
  assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);
});

test('a saved session is never sent to a different control plane', async (t) => {
  const first = await startFakeServer();
  const second = await startFakeServer();
  t.after(first.close);
  t.after(second.close);
  const home = tempHome(t);
  const a = makeContext(home, first, { agents: ['cursor'] });
  assert.equal(await main([], a.ctx), 0);
  const token = loadSession(a.ctx).token;
  const b = makeContext(home, second);
  // Cursor's entry points at the first control plane: moving it needs --force.
  assert.equal(await main(['--agents', 'cursor'], b.ctx), 1, b.text());
  assert.match(b.err.join('\n'), /points at http:\/\/127\.0\.0\.1:\d+\/mcp; re-run with --force/);
  assert.equal(tokensIn(home).cursor, token);
  const c = makeContext(home, second);
  assert.equal(await main(['--agents', 'cursor', '--force'], c.ctx), 0, c.text());
  assert.ok(second.state.requests.every((r) => r.auth !== token), 'the first server\'s token never reaches the second');
  assert.equal(second.state.deviceNames.length, 1);
});
