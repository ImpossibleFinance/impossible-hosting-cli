'use strict';

const fs = require('node:fs');
const path = require('node:path');

const jsonc = require('./jsonc');
const toml = require('./toml');
const { PRIVATE_FILE, exists, readTextIfExists, withFileLock, writeFileAtomic } = require('./fsutil');

// The coding agents this package connects, and where each one keeps its
// user-level MCP servers and skills. Everything is written at user scope (not
// into a project), because the point is that Innstance is available in every
// project the person opens afterwards.
//
//   agent        MCP servers                                   skills
//   Claude Code  ~/.claude.json  mcpServers.innstance          ~/.claude/skills/innstance
//   Codex        ~/.codex/config.toml  [mcp_servers.innstance]  ~/.agents/skills/innstance
//   Cursor       ~/.cursor/mcp.json  mcpServers.innstance      ~/.agents/skills/innstance
//   OpenCode     ~/.config/opencode/opencode.json  mcp.innstance  ~/.agents/skills/innstance
//
// ~/.agents/skills is the shared user skills directory that Codex, Cursor and
// OpenCode all read, so one copy serves the three. Claude Code reads only its
// own directory. CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_CONFIG_HOME move these
// locations the same way they move them for the agents themselves.
//
// The token goes into each file as a literal Authorization header. The
// alternative, an environment variable reference, only works in a shell that
// exports it, which is not how people start a desktop editor; a literal in an
// owner-only file is what the agents' own "add server" commands produce too.

const SERVER_NAME = 'innstance';
const MANAGED_NOTE = 'Written by npx innstance. Remove it with: npx innstance remove';

function envPath(ctx, name) {
  const value = ctx.env[name];
  return value && path.isAbsolute(value) ? value : null;
}

function claudeDir(ctx) {
  return envPath(ctx, 'CLAUDE_CONFIG_DIR') || path.join(ctx.home, '.claude');
}

function claudeJSON(ctx) {
  const custom = envPath(ctx, 'CLAUDE_CONFIG_DIR');
  return custom ? path.join(custom, '.claude.json') : path.join(ctx.home, '.claude.json');
}

function codexHome(ctx) {
  return envPath(ctx, 'CODEX_HOME') || path.join(ctx.home, '.codex');
}

function opencodeDir(ctx) {
  return path.join(envPath(ctx, 'XDG_CONFIG_HOME') || path.join(ctx.home, '.config'), 'opencode');
}

function sharedSkillsRoot(ctx) {
  return path.join(ctx.home, '.agents', 'skills');
}

function bearer(token) {
  return `Bearer ${token}`;
}

function tokenFromHeader(value) {
  const m = typeof value === 'string' && /^Bearer\s+(\S+)$/.exec(value);
  return m ? m[1] : '';
}

// OpenCode reads opencode.json and opencode.jsonc from its config directory
// and merges them. Edit the one that already names our server; otherwise the
// one that exists; otherwise create opencode.json.
function opencodeConfig(ctx) {
  const dir = opencodeDir(ctx);
  const candidates = ['opencode.json', 'opencode.jsonc'].map((f) => path.join(dir, f));
  const existing = candidates.filter((f) => exists(f));
  for (const file of existing) {
    try {
      if (jsonc.getAt(jsonc.parse(readTextIfExists(file) || ''), ['mcp', SERVER_NAME]) !== undefined) return file;
    } catch {
      return file; // unreadable: pick it so the error is reported, not hidden
    }
  }
  return existing[0] || candidates[0];
}

function jsonAgent(spec) {
  return {
    format: 'json',
    readEntry(text) {
      const doc = jsonc.parse(text || '');
      const entry = jsonc.getAt(doc, spec.jsonPath);
      if (entry === undefined) return null;
      if (!entry || typeof entry !== 'object') return { url: '', token: '' };
      return {
        url: typeof entry.url === 'string' ? entry.url : '',
        token: tokenFromHeader(entry.headers && entry.headers.Authorization),
      };
    },
    editEntry(text, url, token) {
      return jsonc.setAt(text, spec.jsonPath, spec.entry(url, token), { seed: spec.seed });
    },
    removeEntry(text) {
      return jsonc.removeAt(text, spec.jsonPath);
    },
    ...spec,
  };
}

const AGENTS = [
  jsonAgent({
    id: 'claude',
    name: 'Claude Code',
    detect: (ctx) => exists(claudeDir(ctx)) || exists(claudeJSON(ctx)) || Boolean(ctx.which('claude')),
    configPath: claudeJSON,
    skillsRoot: (ctx) => path.join(claudeDir(ctx), 'skills'),
    jsonPath: ['mcpServers', SERVER_NAME],
    entry: (url, token) => ({ type: 'http', url, headers: { Authorization: bearer(token) } }),
    reload: 'restart Claude Code (or run /mcp in a session)',
  }),
  {
    id: 'codex',
    name: 'Codex',
    format: 'toml',
    detect: (ctx) => exists(codexHome(ctx)) || Boolean(ctx.which('codex')),
    configPath: (ctx) => path.join(codexHome(ctx), 'config.toml'),
    skillsRoot: sharedSkillsRoot,
    reload: 'start a new Codex session',
    readEntry(text) {
      const entry = toml.readServer(text || '', SERVER_NAME);
      if (!entry) return null;
      return {
        url: typeof entry.url === 'string' ? entry.url : '',
        token: tokenFromHeader(entry.http_headers && entry.http_headers.Authorization),
      };
    },
    editEntry(text, url, token) {
      return toml.setServer(text || '', SERVER_NAME, { url, http_headers: { Authorization: bearer(token) } }, { comment: MANAGED_NOTE });
    },
    removeEntry(text) {
      return toml.removeServer(text, SERVER_NAME);
    },
  },
  jsonAgent({
    id: 'cursor',
    name: 'Cursor',
    detect: (ctx) => exists(path.join(ctx.home, '.cursor')) || Boolean(ctx.which('cursor')) || Boolean(ctx.which('cursor-agent')),
    configPath: (ctx) => path.join(ctx.home, '.cursor', 'mcp.json'),
    skillsRoot: sharedSkillsRoot,
    jsonPath: ['mcpServers', SERVER_NAME],
    entry: (url, token) => ({ url, headers: { Authorization: bearer(token) } }),
    reload: 'reload Cursor (MCP servers are listed under Settings > MCP)',
  }),
  jsonAgent({
    id: 'opencode',
    name: 'OpenCode',
    detect: (ctx) => exists(opencodeDir(ctx)) || Boolean(ctx.which('opencode')),
    configPath: opencodeConfig,
    skillsRoot: sharedSkillsRoot,
    jsonPath: ['mcp', SERVER_NAME],
    seed: { $schema: 'https://opencode.ai/config.json' },
    entry: (url, token) => ({ type: 'remote', url, enabled: true, headers: { Authorization: bearer(token) } }),
    reload: 'restart OpenCode',
  }),
];

const AGENT_IDS = AGENTS.map((a) => a.id);

function agentById(id) {
  return AGENTS.find((a) => a.id === id) || null;
}

// parseAgentList turns "--agents claude,cursor" (or "all") into agents.
function parseAgentList(value) {
  const ids = String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (ids.length === 0) throw new Error(`--agents needs a list: ${AGENT_IDS.join(', ')} or all`);
  if (ids.includes('all')) return AGENTS.slice();
  const out = [];
  for (const id of ids) {
    const agent = agentById(id === 'claude-code' ? 'claude' : id);
    if (!agent) throw new Error(`unknown agent ${JSON.stringify(id)}; choose from ${AGENT_IDS.join(', ')} or all`);
    if (!out.includes(agent)) out.push(agent);
  }
  return out;
}

function detectAgents(ctx) {
  return AGENTS.filter((a) => a.detect(ctx));
}

// readMCP reports the agent's current innstance entry, if any. The token is
// returned for comparison only; callers never print it.
function readMCP(agent, ctx) {
  const file = agent.configPath(ctx);
  const text = readTextIfExists(file);
  if (text === null) return { file, entry: null };
  try {
    return { file, entry: agent.readEntry(text) };
  } catch (err) {
    return { file, entry: null, error: `${file} could not be read: ${err.message}` };
  }
}

async function writeMCP(agent, ctx, url, token) {
  const file = agent.configPath(ctx);
  await withFileLock(file, async (real) => {
    const before = readTextIfExists(real);
    let after;
    try {
      after = agent.editEntry(before, url, token);
    } catch (err) {
      throw new Error(`${file} was not changed: ${err.message}`);
    }
    if (after !== before) {
      await writeFileAtomic(real, after);
    } else {
      // Already up to date; still make sure a file holding a token is
      // owner-only, whatever its mode was before we first wrote to it.
      try {
        fs.chmodSync(real, PRIVATE_FILE);
      } catch {}
    }
  });
  return file;
}

// removeMCP deletes the entry only when it points at this control plane's
// MCP endpoint. An "innstance" server pointing somewhere else was put there
// by someone else, for their own reasons.
async function removeMCP(agent, ctx, url) {
  const { file, entry, error } = readMCP(agent, ctx);
  if (error) return { file, status: 'error', detail: error };
  if (!entry) return { file, status: 'absent' };
  if (entry.url !== url) return { file, status: 'skipped', detail: `its innstance entry points at ${entry.url || 'another server'}` };
  await withFileLock(file, async (real) => {
    const before = readTextIfExists(real);
    const after = agent.removeEntry(before);
    if (after !== before) await writeFileAtomic(real, after);
  });
  return { file, status: 'removed' };
}

module.exports = {
  AGENTS,
  AGENT_IDS,
  SERVER_NAME,
  agentById,
  parseAgentList,
  detectAgents,
  readMCP,
  writeMCP,
  removeMCP,
  sharedSkillsRoot,
};
