'use strict';

const fs = require('node:fs');
const path = require('node:path');

const jsonc = require('./jsonc');
const toml = require('./toml');
const { PRIVATE_FILE, exists, linkedTarget, readTextIfExists, tokenFileRisk, withFileLock, writeFileAtomic } = require('./fsutil');

// The coding agents this package connects, and where each one keeps its
// user-level MCP servers and skills. Everything is written at user scope (not
// into a project), because the point is that Innstance is available in every
// project the person opens afterwards.
//
//   agent     MCP servers                                      skills
//   claude    ~/.claude.json  mcpServers.innstance             ~/.claude/skills/innstance
//   codex     ~/.codex/config.toml  [mcp_servers.innstance]    ~/.agents/skills/innstance
//   cursor    ~/.cursor/mcp.json  mcpServers.innstance         ~/.agents/skills/innstance
//   opencode  ~/.config/opencode/opencode.json  mcp.innstance  ~/.agents/skills/innstance
//
// ~/.agents/skills is the shared user skills directory that codex, cursor and
// opencode all read, so one copy serves the three. The claude agent reads
// only its own directory. CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_CONFIG_HOME move these
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

// HTTP header names are case-insensitive, and people write "authorization"
// as often as "Authorization"; both are read, and both are updated.
function authorizationKeys(headers) {
  return headers && typeof headers === 'object' && !Array.isArray(headers) ? Object.keys(headers).filter((k) => k.toLowerCase() === 'authorization') : [];
}

// An Authorization value can name an environment variable instead of holding
// the token: ${VAR} for the claude agent, ${env:VAR} for cursor, {env:VAR}
// for opencode. Someone who set an entry up that way chose to keep the token
// out of the file, so setup leaves such an entry as it is rather than write a
// literal token into it.
const ENV_REFERENCE = /\$\{|\{env:/;

function authorizationValue(headers) {
  const key = authorizationKeys(headers)[0];
  return key && typeof headers[key] === 'string' ? headers[key] : '';
}

function tokenFrom(headers) {
  const value = authorizationValue(headers);
  const m = !ENV_REFERENCE.test(value) && /^Bearer\s+(\S+)$/.exec(value);
  return m ? m[1] : '';
}

function tokenFromEnv(headers) {
  return ENV_REFERENCE.test(authorizationValue(headers));
}

// describeEntry says, for a message, what an entry that is not ours does.
function describeEntry(entry) {
  if (entry.url) return `points at ${entry.url}`;
  return entry.command ? 'runs a local command' : 'has no url';
}

// setIfDifferent sets one member of a JSON(C) document, leaving the text
// byte-for-byte alone when it already holds that value.
function setIfDifferent(text, pathParts, value) {
  if (JSON.stringify(jsonc.getAt(jsonc.parse(text), pathParts)) === JSON.stringify(value)) return text;
  return jsonc.setAt(text, pathParts, value);
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
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { url: '', token: '', command: false, fromEnv: false };
      return {
        url: typeof entry.url === 'string' ? entry.url : '',
        token: tokenFrom(entry.headers),
        command: entry.command !== undefined,
        fromEnv: tokenFromEnv(entry.headers),
      };
    },
    editEntry(text, url, token) {
      return jsonc.setAt(text, spec.jsonPath, spec.entry(url, token), { seed: spec.seed });
    },
    // updateEntry changes only what makes the entry reach Innstance: the url
    // and the Authorization header (and the transport type, only when the
    // entry has none). enabled, timeouts and anything else the person set
    // stay as they are.
    updateEntry(text, url, token) {
      const entry = jsonc.getAt(jsonc.parse(text), spec.jsonPath);
      let out = text;
      for (const [key, value] of Object.entries(spec.shape || {})) {
        if (entry[key] === undefined) out = setIfDifferent(out, spec.jsonPath.concat(key), value);
      }
      out = setIfDifferent(out, spec.jsonPath.concat('url'), url);
      if (entry.headers !== undefined && (!entry.headers || typeof entry.headers !== 'object' || Array.isArray(entry.headers))) {
        throw new Error('its innstance entry has a "headers" value that is not an object');
      }
      const keys = authorizationKeys(entry.headers);
      for (const key of keys.length > 0 ? keys : ['Authorization']) {
        out = setIfDifferent(out, spec.jsonPath.concat('headers', key), bearer(token));
      }
      return out;
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
    shape: { type: 'http' },
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
      // codex never expands variables inside http_headers; it reads the
      // token from the environment through bearer_token_env_var, or an
      // Authorization line in env_http_headers.
      const fromEnv = entry.bearer_token_env_var !== undefined || authorizationKeys(entry.env_http_headers).length > 0;
      return {
        url: typeof entry.url === 'string' ? entry.url : '',
        token: fromEnv ? '' : tokenFrom(entry.http_headers),
        command: entry.command !== undefined,
        fromEnv,
      };
    },
    editEntry(text, url, token) {
      return toml.setServer(text || '', SERVER_NAME, { url, http_headers: { Authorization: bearer(token) } }, { comment: MANAGED_NOTE });
    },
    updateEntry(text, url, token) {
      return toml.updateServer(text, SERVER_NAME, { url, authorization: bearer(token) });
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
    shape: { type: 'remote' },
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

// writeMCP connects one agent and reports what it did:
//
//   added      there was no innstance entry; a complete one was written
//   updated    the entry already pointed at this endpoint; only its url and
//              Authorization header were changed, so anything else the
//              person set on it (enabled, tool approvals, timeouts) stays
//   unchanged  the entry already held this url and token
//   replaced   an entry that was not ours was overwritten (force)
//   skipped    an innstance entry that points somewhere else, or runs a
//              local command, was put there by someone else and is left
//              alone unless replaceForeign is set; or the file sits in a git
//              repository, where the token could be committed, and
//              allowRepo is not set
//   external   the entry points at this endpoint but takes its token from
//              an environment variable; it is left as it is unless
//              replaceForeign is set, which replaces the whole entry
//
// linkedTo names the real file when the config is a symlink, so the person
// is told where the token went.
async function writeMCP(agent, ctx, url, token, { replaceForeign = false, allowRepo = false } = {}) {
  const file = agent.configPath(ctx);
  const risk = tokenFileRisk(file, ctx.home);
  if (risk && !allowRepo) {
    return { file, status: 'skipped', detail: `${risk}; move it out of the repository, or re-run with --force to write it anyway` };
  }
  const link = linkedTarget(file, ctx.home);
  let result;
  await withFileLock(file, async (real) => {
    const before = readTextIfExists(real);
    let after;
    try {
      const entry = before === null ? null : agent.readEntry(before);
      const ours = Boolean(entry) && entry.url === url;
      if (entry && !ours && !replaceForeign) {
        result = { file, status: 'skipped', detail: `its "innstance" server ${describeEntry(entry)}; re-run with --force to replace it` };
        return;
      }
      if (ours && entry.fromEnv && !replaceForeign) {
        result = { file, status: 'external', detail: 'its "innstance" server takes its token from an environment variable; re-run with --force to write the token into the file instead' };
        return;
      }
      const replacing = Boolean(entry) && (!ours || entry.fromEnv);
      after = entry && !replacing ? agent.updateEntry(before, url, token) : agent.editEntry(before, url, token);
      result = { file, status: !entry ? 'added' : replacing ? 'replaced' : after === before ? 'unchanged' : 'updated' };
      if (link) result.linkedTo = link;
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
  return result;
}

// removeMCP deletes the entry only when it points at this control plane's
// MCP endpoint. An "innstance" server pointing somewhere else was put there
// by someone else, for their own reasons.
async function removeMCP(agent, ctx, url) {
  const { file, entry, error } = readMCP(agent, ctx);
  if (error) return { file, status: 'error', detail: error };
  if (!entry) return { file, status: 'absent' };
  if (entry.url !== url) return { file, status: 'skipped', detail: `its innstance entry ${describeEntry(entry)}` };
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
