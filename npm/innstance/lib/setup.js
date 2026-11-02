'use strict';

const { AGENTS, detectAgents, readMCP, writeMCP } = require('./agents');
const { whoami } = require('./account');
const { tildify } = require('./context');
const { signIn } = require('./device');
const { probeMCP } = require('./mcp');
const { DEFAULT_ORIGIN, mcpURL } = require('./origin');
const { deviceName, loadSession, newDeviceId, saveSession } = require('./session');
const { fetchSkill, installSkill } = require('./skill');

function names(agents) {
  const list = agents.map((a) => a.name);
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

// ensureSession reuses this machine's saved npx session when it still works
// for this control plane, and otherwise signs in with the device flow. A
// saved token is only ever sent to the origin it was issued by.
async function ensureSession(ctx, origin, { relogin }) {
  const saved = loadSession(ctx);
  const deviceId = (saved && saved.deviceId) || newDeviceId();
  if (saved && saved.token && saved.server === origin && !relogin) {
    const me = await whoami(origin, saved.token);
    if (me.valid) {
      ctx.out(`Signed in as ${me.email || saved.email} (this machine's saved session).`);
      return { ...saved, email: me.email || saved.email, reused: true };
    }
    ctx.out('The saved session for this machine has ended; signing in again.');
  }
  const name = deviceName(ctx.platform, ctx.hostname, deviceId);
  const { token, email } = await signIn(ctx, origin, name);
  const session = { server: origin, token, email, deviceName: name, deviceId, reused: false };
  // Saved before any agent config is touched, so an interrupted setup can be
  // resumed without another trip through the browser.
  await saveSession(ctx, session);
  ctx.out('');
  ctx.out(`Signed in as ${email || 'your account'}.`);
  return session;
}

// The words for each writeMCP outcome. A refresh is an agent the person did
// not name this time, whose token was replaced by a new sign-in.
function describeWrite(result, refreshed) {
  switch (result.status) {
    case 'added':
      return 'added the "innstance" MCP server to';
    case 'updated':
      return refreshed ? 'gave the new session to the "innstance" MCP server in' : 'updated the "innstance" MCP server in';
    case 'replaced':
      return 'replaced the "innstance" entry (--force) in';
    default:
      return 'the "innstance" MCP server is already set in';
  }
}

async function setup(ctx, opts) {
  const origin = opts.origin;
  const mcp = mcpURL(origin);
  let failures = 0;

  if (origin !== DEFAULT_ORIGIN) {
    ctx.err(`Using the control plane at ${origin}: your sign-in and agent configs point there, not at Innstance.`);
  }

  const selected = opts.agents || detectAgents(ctx);
  if (selected.length === 0) {
    ctx.err('No supported coding agent was found on this machine (looked for Claude Code, Codex, Cursor and OpenCode).');
    ctx.err('Name the ones to set up, for example:  npx innstance --agents claude,cursor');
    return 1;
  }
  ctx.out(`Connecting ${names(selected)} to Innstance.`);

  // First ask whether there is an MCP endpoint at all. That needs no token
  // (a missing route answers 404 to anyone), and signing in to a control
  // plane without one would only mint a session that nothing uses.
  let mcpMissing = false;
  if (opts.skipMcpCheck) {
    ctx.out(`MCP endpoint ${mcp}: not checked (--skip-mcp-check).`);
  } else if ((await probeMCP(mcp, '')).state === 'missing') {
    mcpMissing = true;
    ctx.err(`${mcp} is not available on this server yet, so this machine was not signed in and no agent MCP config was written. Run npx innstance again once it is live.`);
  }

  let session = null;
  if (!mcpMissing) {
    try {
      session = await ensureSession(ctx, origin, opts);
    } catch (err) {
      ctx.err(`Sign-in failed: ${err.message}`);
      return 1;
    }
  }

  // Do not write configs that would leave every agent showing a failing
  // server: check the endpoint again, with the token the agents will use.
  let writeNew = Boolean(session);
  if (session && !opts.skipMcpCheck) {
    const probe = await probeMCP(mcp, session.token);
    if (probe.state === 'ok') {
      ctx.out(`MCP endpoint ${mcp}: ${probe.detail}.`);
    } else if (probe.state === 'missing') {
      writeNew = false;
      mcpMissing = true;
      ctx.err(`${probe.detail}; agent MCP configs were not written. Run npx innstance again once it is live.`);
    } else if (probe.state === 'auth') {
      writeNew = false;
      failures++;
      ctx.err(`MCP endpoint ${mcp}: ${probe.detail}; agent configs were not written. Try npx innstance --relogin.`);
    } else if (probe.state === 'forbidden') {
      writeNew = false;
      failures++;
      ctx.err(`MCP endpoint ${mcp}: ${probe.detail}; agent configs were not written. Signing in again gives the same kind of session, so try the newest version: npx innstance@latest`);
    } else {
      ctx.err(`Warning: could not confirm the MCP endpoint (${probe.detail}); writing the configs anyway.`);
    }
  }

  // A new sign-in replaced this machine's previous npx session on the
  // server, so an agent connected earlier still holds a token that no longer
  // works. Every entry already pointing at this endpoint gets the new token,
  // whatever the probe said, because the old one is dead either way. Only
  // the url and Authorization lines of those entries change. A reused
  // session changed nothing on the server, so agents not named this time are
  // left alone.
  const refresh =
    session && !session.reused
      ? AGENTS.filter((a) => {
          if (writeNew && selected.includes(a)) return false;
          const { entry } = readMCP(a, ctx);
          return Boolean(entry) && entry.url === mcp && entry.token !== session.token;
        })
      : [];

  const connected = [];
  const targets = (writeNew ? selected : []).concat(refresh);
  if (targets.length > 0) ctx.out('');
  for (const agent of targets) {
    const refreshed = refresh.includes(agent);
    try {
      const result = await writeMCP(agent, ctx, mcp, session.token, { force: opts.force && !refreshed });
      const where = tildify(ctx, result.file);
      if (result.status === 'skipped') {
        failures++;
        ctx.err(`  ${agent.name}: left ${where} alone: ${result.detail}`);
        continue;
      }
      connected.push(agent);
      ctx.out(`  ${agent.name}: ${describeWrite(result, refreshed)} ${where}`);
    } catch (err) {
      failures++;
      ctx.err(`  ${agent.name}: ${err.message}`);
    }
  }

  ctx.out('');
  let skillVersion = '';
  try {
    const bundle = await fetchSkill({ pin: ctx.skillPin, baseURL: ctx.skillBaseURL });
    skillVersion = bundle.version;
    const roots = [];
    for (const agent of selected) {
      const root = agent.skillsRoot(ctx);
      if (!roots.includes(root)) roots.push(root);
    }
    for (const root of roots) {
      const result = await installSkill(root, bundle, { force: opts.force });
      const where = tildify(ctx, result.dir);
      if (result.status === 'skipped') {
        failures++;
        ctx.err(`  Skill: ${result.detail}`);
      } else if (result.status === 'kept') {
        ctx.out(`  Skill: kept ${where} (${result.detail})`);
      } else {
        const verb = { installed: 'installed', updated: 'updated', current: 'already current' }[result.status];
        ctx.out(`  Skill ${bundle.version}: ${verb} in ${where}`);
      }
    }
  } catch (err) {
    failures++;
    ctx.err(`  Skill: ${err.message}`);
  }

  ctx.out('');
  if (failures > 0) {
    ctx.err('Setup finished with problems (see above). Fix them and run npx innstance again; it is safe to repeat.');
  } else {
    ctx.out('Done.');
  }
  ctx.out('');
  ctx.out('Next steps');
  let step = 1;
  if (connected.length > 0) {
    ctx.out(`  ${step++}. Reload your agent so it loads the new MCP server:`);
    for (const agent of connected) ctx.out(`       ${agent.name}: ${agent.reload}`);
    ctx.out(`  ${step++}. Ask it to put something on the web, for example:`);
    ctx.out('       "Publish this folder with Innstance and give me the link."');
  } else if (mcpMissing) {
    ctx.out(`  ${step++}. The skill${skillVersion ? ` (${skillVersion})` : ''} is installed; it teaches your agent to use the innstance CLI until MCP is live.`);
  }
  ctx.out(`  ${step++}. Check the connection any time:  npx innstance doctor`);
  ctx.out(`     Disconnect and sign out:          npx innstance remove`);
  if (session) {
    ctx.out('');
    // The server names the session "cli-<device name>"; say it the way the
    // dashboard's token list shows it, so it can be found there.
    const listed = session.deviceName ? `"cli-${session.deviceName}"` : "this machine's npx session";
    ctx.out(`Agents here sign in with ${listed}. Revoke it any time from ${origin}/dashboard.`);
  }
  return failures > 0 ? 1 : 0;
}

module.exports = { setup, ensureSession };
