'use strict';

const { AGENTS, removeMCP } = require('./agents');
const { logout } = require('./account');
const { sudoProblem, tildify } = require('./context');
const { mcpURL } = require('./origin');
const { clearSession, loadSession, savedOrigins } = require('./session');
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

  const sudo = sudoProblem(ctx);
  if (sudo) {
    ctx.err(`Nothing was changed: ${sudo}`);
    return 1;
  }

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
    const session = loadSession(ctx, origin);
    if (session && session.token) {
      let forget = false;
      try {
        const out = await logout(origin, session.token);
        forget = out.ended;
        if (out.revoked) ctx.out('  Session: ended on the server');
        else if (out.ended) ctx.out(`  Session: ${out.detail}`);
        else {
          failures++;
          ctx.err(`  Session: not ended (${out.detail}); revoke it from ${origin}/dashboard, then run npx innstance remove again`);
        }
      } catch (err) {
        failures++;
        ctx.err(`  Session: could not end it (${err.message}); run npx innstance remove again, or revoke it from ${origin}/dashboard`);
      }
      // The token is kept until the server confirms the session is over, so
      // running remove again can still end it.
      if (forget && (await clearSession(ctx, origin))) ctx.out('  Session: forgotten on this machine');
    } else if (session) {
      await clearSession(ctx, origin);
    }
    for (const other of savedOrigins(ctx)) {
      ctx.out(`  This machine is also signed in to ${other}; to end that: npx innstance remove --server ${other}`);
    }
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
