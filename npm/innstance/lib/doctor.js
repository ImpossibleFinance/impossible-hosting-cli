'use strict';

const path = require('node:path');

const { AGENTS, readMCP } = require('./agents');
const { health, whoami } = require('./account');
const { tildify } = require('./context');
const { probeMCP } = require('./mcp');
const { DEFAULT_ORIGIN, mcpURL } = require('./origin');
const { loadSession } = require('./session');
const { PIN, SKILL_NAME, compareVersions, readInstalled } = require('./skill');

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
        report('ok', 'Session', `signed in as ${me.email || session.email}${me.plan ? ` (${me.plan} plan)` : ''}`);
      } else {
        report('fail', 'Session', 'the saved session has ended (revoked, or replaced by a newer sign-in); run: npx innstance --relogin');
      }
    } catch (err) {
      report('fail', 'Session', err.message);
    }
  }

  if (reachable) {
    const probe = await probeMCP(mcp, token);
    if (probe.state === 'ok') report('ok', 'MCP endpoint', probe.detail);
    else if (probe.state === 'missing') report('warn', 'MCP endpoint', probe.detail);
    else if (probe.state === 'auth' && !token) report('ok', 'MCP endpoint', 'live (sign in to use it)');
    else report('fail', 'MCP endpoint', probe.detail);
  }

  for (const agent of AGENTS) {
    const { file, entry, error } = readMCP(agent, ctx);
    const installed = agent.detect(ctx);
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
      report('fail', agent.name, `${tildify(ctx, file)} has no bearer token for innstance; run: npx innstance --agents ${agent.id}`);
      continue;
    }
    if (session && session.token && entry.token !== session.token) {
      report('fail', agent.name, `${tildify(ctx, file)} holds an older session's token; run: npx innstance`);
      continue;
    }
    const skillDir = path.join(agent.skillsRoot(ctx), SKILL_NAME);
    const skill = readInstalled(skillDir);
    let skillNote;
    if (!skill) skillNote = 'skill not installed';
    else if (!skill.version) skillNote = `${tildify(ctx, skillDir)} is not an Innstance skill`;
    else if (compareVersions(skill.version, pinned.version) < 0) skillNote = `skill ${skill.version} (older than ${pinned.version}; run npx innstance)`;
    else skillNote = `skill ${skill.version}`;
    report('ok', agent.name, `connected in ${tildify(ctx, file)}; ${skillNote}`);
  }

  ctx.out('');
  if (failed > 0) {
    ctx.err(`${failed} check${failed === 1 ? '' : 's'} failed.`);
    return 1;
  }
  ctx.out(warned > 0 ? `No failures; ${warned} warning${warned === 1 ? '' : 's'} above.` : 'No problems found.');
  return 0;
}

module.exports = { doctor };
