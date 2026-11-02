'use strict';

const path = require('node:path');

const { AGENTS, readMCP } = require('./agents');
const { health, whoami } = require('./account');
const { tildify } = require('./context');
const { fileMode: modeOf } = require('./fsutil');
const { probeMCP } = require('./mcp');
const { DEFAULT_ORIGIN, mcpURL } = require('./origin');
const { loadSession } = require('./session');
const { PIN, SKILL_NAME, compareVersions, readInstalled } = require('./skill');

// How plan tiers are named to people. The stored tier "team" is sold as
// Studio; an unknown tier is shown as the server sent it.
const PLAN_NAMES = { free: 'Free', hobby: 'Hobby', pro: 'Pro', team: 'Studio' };

function planName(tier) {
  return PLAN_NAMES[tier] || tier;
}

// doctor walks the path an agent's request takes — this machine, the network,
// the control plane, the session, the MCP endpoint, each agent's config — and
// reports the first thing wrong at each step in words that say what to run.
// It changes nothing. Exit status is 1 when anything failed, so an agent or
// a script can use it as a check.
async function doctor(ctx, opts) {
  const origin = opts.origin;
  const mcp = mcpURL(origin);
  const pinned = ctx.skillPin || PIN;
  let failed = 0;
  let warned = 0;
  const report = (level, label, detail) => {
    if (level === 'fail') failed++;
    if (level === 'warn') warned++;
    const line = `  ${level.padEnd(4)}  ${label}${detail ? ': ' + detail : ''}`;
    if (level === 'fail') ctx.err(line);
    else ctx.out(line);
  };

  ctx.out(`Innstance doctor (${origin})`);

  const major = Number(String(ctx.nodeVersion).split('.')[0]);
  report(major >= 18 ? 'ok' : 'fail', 'Node.js', major >= 18 ? ctx.nodeVersion : `${ctx.nodeVersion}; version 18 or newer is required`);

  let reachable = false;
  try {
    const h = await health(origin);
    reachable = true;
    report(h.ok ? 'ok' : 'fail', 'Control plane', h.ok ? `reachable (${h.ms} ms)` : `answered HTTP ${h.status} on /health`);
  } catch (err) {
    report('fail', 'Control plane', err.message);
  }

  const session = loadSession(ctx, origin);
  let token = '';
  if (!session || !session.token) {
    report('warn', 'Session', `this machine is not signed in with npx innstance; run: npx innstance${origin === DEFAULT_ORIGIN ? '' : ` --server ${origin}`}`);
  } else if (reachable) {
    try {
      const me = await whoami(origin, session.token);
      if (me.valid) {
        token = session.token;
        report('ok', 'Session', `signed in as ${me.email || session.email}${me.plan ? ` (${planName(me.plan)} plan)` : ''}`);
      } else {
        report('fail', 'Session', 'the saved session has ended (revoked, or replaced by a newer sign-in); run: npx innstance --relogin');
      }
    } catch (err) {
      report('fail', 'Session', err.message);
    }
  }

  // Each agent's own token is checked too: an agent can hold a token other
  // than the saved session's (pasted by hand, or left from an older sign-in),
  // and with no saved session it is the only one there is. Tokens are only
  // ever sent to this origin, the one whose MCP endpoint the agent names.
  const checked = new Map();
  const tokenState = async (t) => {
    if (token && t === token) return 'valid';
    if (!reachable) return 'unknown';
    if (!checked.has(t)) {
      try {
        checked.set(t, (await whoami(origin, t)).valid ? 'valid' : 'ended');
      } catch {
        checked.set(t, 'unknown');
      }
    }
    return checked.get(t);
  };
  const agents = AGENTS.map((agent) => ({ agent, ...readMCP(agent, ctx) }));

  let mcpState = 'unknown';
  if (reachable) {
    // Probe as an agent would: with the saved session, or failing that with
    // a connected agent's working token.
    let probeToken = token;
    for (const { entry } of agents) {
      if (probeToken) break;
      if (entry && entry.url === mcp && entry.token && (await tokenState(entry.token)) === 'valid') probeToken = entry.token;
    }
    const probe = await probeMCP(mcp, probeToken);
    mcpState = probe.state;
    if (probe.state === 'ok') report('ok', 'MCP endpoint', probe.detail);
    else if (probe.state === 'missing') report('warn', 'MCP endpoint', probe.detail);
    else if (probe.state === 'auth' && !probeToken) report('ok', 'MCP endpoint', 'live (sign in to use it)');
    else if (probe.state === 'forbidden') report('fail', 'MCP endpoint', `${probe.detail}; try the newest version: npx innstance@latest`);
    else report('fail', 'MCP endpoint', probe.detail);
  }

  for (const { agent, file, entry, error } of agents) {
    const installed = agent.detect(ctx);
    const where = tildify(ctx, file);
    if (error) {
      report('fail', agent.name, error);
      continue;
    }
    if (!entry) {
      if (installed) report('warn', agent.name, `not connected; run: npx innstance --agents ${agent.id}`);
      continue;
    }
    if (entry.url !== mcp) {
      report('warn', agent.name, `its "innstance" server points at ${entry.url || 'nothing'}, not ${mcp}`);
      continue;
    }
    if (!entry.token) {
      report('fail', agent.name, `${where} has no bearer token for innstance; run: npx innstance --agents ${agent.id}`);
      continue;
    }
    const state = await tokenState(entry.token);
    if (state === 'ended') {
      report('fail', agent.name, `${where} holds a token that has ended (revoked, or an older session's); run: npx innstance --agents ${agent.id}`);
      continue;
    }
    if (mcpState === 'missing') {
      report('fail', agent.name, `connected in ${where}, but ${mcp} is not available on this server, so the agent shows a failing server; run npx innstance remove --agents ${agent.id} until it is live`);
      continue;
    }
    if (mcpState === 'error' || mcpState === 'forbidden') {
      report('fail', agent.name, `connected in ${where}, but the MCP endpoint is failing (see above)`);
      continue;
    }
    const notes = [];
    if (state === 'unknown') notes.push('token not checked');
    else if (token && entry.token !== token) notes.push("signed in with its own token, not this machine's npx session");
    const skillDir = path.join(agent.skillsRoot(ctx), SKILL_NAME);
    const skill = readInstalled(skillDir);
    if (!skill) notes.push('skill not installed');
    else if (!skill.version) notes.push(`${tildify(ctx, skillDir)} is not an Innstance skill`);
    else if (compareVersions(skill.version, pinned.version) < 0) notes.push(`skill ${skill.version} (older than ${pinned.version}; run npx innstance)`);
    else notes.push(`skill ${skill.version}`);
    const fileMode = ctx.platform === 'win32' ? null : modeOf(file);
    if (fileMode !== null && fileMode & 0o077) {
      report('warn', agent.name, `${where} holds a token and is readable by other users (mode ${fileMode.toString(8)}); run: npx innstance --agents ${agent.id}`);
    }
    report('ok', agent.name, `connected in ${where}; ${notes.join('; ')}`);
  }

  ctx.out('');
  if (failed > 0) {
    ctx.err(`${failed} check${failed === 1 ? '' : 's'} failed.`);
    return 1;
  }
  ctx.out(warned > 0 ? `No failures; ${warned} warning${warned === 1 ? '' : 's'} above.` : 'No problems found.');
  return 0;
}

module.exports = { doctor, planName };
