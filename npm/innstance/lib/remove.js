'use strict';

const { AGENTS, removeMCP } = require('./agents');
const { logout } = require('./account');
const { tildify } = require('./context');
const { mcpURL } = require('./origin');
const { clearSession, loadSession } = require('./session');
const { removeSkill } = require('./skill');

// remove undoes setup. With no --agents it disconnects every agent, removes
// the skill copies this package installed, ends the npx session on the server
// and forgets it locally. With --agents it disconnects only those agents and
// keeps the session, because the others still sign in with it. A skill
// directory shared by several agents is removed only when all of them are.
async function remove(ctx, opts) {
  const origin = opts.origin;
  const mcp = mcpURL(origin);
  const everything = !opts.agents;
  const agents = opts.agents || AGENTS;
  let failures = 0;

  for (const agent of agents) {
    try {
      const result = await removeMCP(agent, ctx, mcp);
      const where = tildify(ctx, result.file);
      if (result.status === 'removed') ctx.out(`  ${agent.name}: removed the innstance server from ${where}`);
      else if (result.status === 'skipped') ctx.out(`  ${agent.name}: left ${where} alone (${result.detail})`);
      else if (result.status === 'error') {
        failures++;
        ctx.err(`  ${agent.name}: ${result.detail}`);
      }
    } catch (err) {
      failures++;
      ctx.err(`  ${agent.name}: ${err.message}`);
    }
  }

  const roots = [];
  for (const agent of AGENTS) {
    const root = agent.skillsRoot(ctx);
    if (roots.includes(root)) continue;
    const sharers = AGENTS.filter((a) => a.skillsRoot(ctx) === root);
    if (sharers.every((a) => agents.includes(a))) roots.push(root);
  }
  for (const root of roots) {
    try {
      const result = removeSkill(root);
      if (result.status === 'removed') ctx.out(`  Skill: removed ${tildify(ctx, result.dir)}`);
      else if (result.status === 'skipped') ctx.out(`  Skill: left ${tildify(ctx, result.dir)} alone (${result.detail})`);
    } catch (err) {
      failures++;
      ctx.err(`  Skill: ${err.message}`);
    }
  }

  if (everything) {
    const session = loadSession(ctx);
    let keep = false;
    if (session && session.server && session.server !== origin) {
      keep = true;
      ctx.out(`  Session: kept the saved session for ${session.server}; run npx innstance remove --server ${session.server} to end it`);
    } else if (session && session.token) {
      try {
        const out = await logout(origin, session.token);
        if (out.revoked) ctx.out('  Session: ended on the server');
        else ctx.out(`  Session: not ended on the server (${out.detail || 'already ended'})`);
      } catch (err) {
        // Keep the token so running remove again can still end it.
        failures++;
        keep = true;
        ctx.err(`  Session: could not end it (${err.message}); run npx innstance remove again, or revoke it from ${origin}/dashboard`);
      }
    }
    if (!keep && clearSession(ctx)) ctx.out('  Session: forgotten on this machine');
  }

  ctx.out('');
  if (failures > 0) {
    ctx.err('Finished with problems (see above).');
    return 1;
  }
  ctx.out('Done. Restart any agent that is running so it drops the server.');
  return 0;
}

module.exports = { remove };
