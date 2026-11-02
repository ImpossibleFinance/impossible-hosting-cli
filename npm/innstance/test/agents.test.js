'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { agentById } = require('../lib/agents');
const jsonc = require('../lib/jsonc');

const URL_ = 'https://innstance.impossibuild.ai/mcp';
const TOKEN = 'imp_' + 'f'.repeat(64);

test('a JSON entry that is already ours is updated in place', () => {
  const cases = [
    {
      name: 'only url and token change; what the person set stays',
      agent: 'opencode',
      text: '{\n  "mcp": {\n    "innstance": {"type": "remote", "url": "https://old/mcp", "enabled": false, "timeout": 30000, "headers": {"Authorization": "Bearer old", "X-Team": "a"}}\n  }\n}\n',
      want: { type: 'remote', url: URL_, enabled: false, timeout: 30000, headers: { Authorization: `Bearer ${TOKEN}`, 'X-Team': 'a' } },
    },
    {
      name: 'a lowercase header name is updated, not doubled',
      agent: 'cursor',
      text: '{"mcpServers": {"innstance": {"url": "https://old/mcp", "headers": {"authorization": "Bearer old"}}}}',
      want: { url: URL_, headers: { authorization: `Bearer ${TOKEN}` } },
    },
    {
      name: 'missing type and headers are added',
      agent: 'claude',
      text: '{"mcpServers": {"innstance": {"url": "https://old/mcp"}}}',
      want: { url: URL_, type: 'http', headers: { Authorization: `Bearer ${TOKEN}` } },
    },
    {
      name: 'a transport type the person chose is kept',
      agent: 'claude',
      text: '{"mcpServers": {"innstance": {"type": "streamable-http", "url": "https://old/mcp", "headers": {"Authorization": "Bearer old"}}}}',
      want: { type: 'streamable-http', url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } },
    },
  ];
  for (const c of cases) {
    const agent = agentById(c.agent);
    const got = agent.updateEntry(c.text, URL_, TOKEN);
    assert.deepEqual(jsonc.getAt(jsonc.parse(got), agent.jsonPath), c.want, c.name);
    assert.equal(agent.updateEntry(got, URL_, TOKEN), got, `${c.name}: a second update changes nothing`);
    assert.deepEqual(agent.readEntry(got), { url: URL_, token: TOKEN, command: false, fromEnv: false }, c.name);
  }
});

test('a JSON entry with headers that are not an object is refused', () => {
  const agent = agentById('cursor');
  assert.throws(() => agent.updateEntry('{"mcpServers": {"innstance": {"url": "u", "headers": "Bearer x"}}}', URL_, TOKEN), /"headers" value that is not an object/);
});

test('an entry that reads its token from an environment variable is recognised', () => {
  const cases = [
    {
      name: 'claude: ${VAR}',
      agent: 'claude',
      text: '{"mcpServers": {"innstance": {"type": "http", "url": "u", "headers": {"Authorization": "Bearer ${INNSTANCE_TOKEN}"}}}}',
      fromEnv: true,
    },
    {
      name: 'cursor: ${env:VAR}',
      agent: 'cursor',
      text: '{"mcpServers": {"innstance": {"url": "u", "headers": {"authorization": "Bearer ${env:INNSTANCE_TOKEN}"}}}}',
      fromEnv: true,
    },
    {
      name: 'opencode: {env:VAR}',
      agent: 'opencode',
      text: '{"mcp": {"innstance": {"type": "remote", "url": "u", "headers": {"Authorization": "Bearer {env:INNSTANCE_TOKEN}"}}}}',
      fromEnv: true,
    },
    {
      name: 'codex: bearer_token_env_var',
      agent: 'codex',
      text: '[mcp_servers.innstance]\nurl = "u"\nbearer_token_env_var = "INNSTANCE_TOKEN"\n',
      fromEnv: true,
    },
    {
      name: 'codex: env_http_headers',
      agent: 'codex',
      text: '[mcp_servers.innstance]\nurl = "u"\nenv_http_headers = { "Authorization" = "INNSTANCE_AUTH" }\n',
      fromEnv: true,
    },
    {
      name: 'codex: a literal token',
      agent: 'codex',
      text: `[mcp_servers.innstance]\nurl = "u"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN}" }\n`,
      fromEnv: false,
      token: TOKEN,
    },
    {
      name: 'cursor: a literal token',
      agent: 'cursor',
      text: `{"mcpServers": {"innstance": {"url": "u", "headers": {"Authorization": "Bearer ${TOKEN}"}}}}`,
      fromEnv: false,
      token: TOKEN,
    },
  ];
  for (const c of cases) {
    const entry = agentById(c.agent).readEntry(c.text);
    assert.equal(entry.fromEnv, c.fromEnv, c.name);
    assert.equal(entry.token, c.token || '', `${c.name}: a variable reference is never taken for a token`);
  }
});
