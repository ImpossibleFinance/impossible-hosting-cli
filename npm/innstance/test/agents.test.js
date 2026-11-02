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
    assert.deepEqual(agent.readEntry(got), { url: URL_, token: TOKEN, command: false }, c.name);
  }
});

test('a JSON entry with headers that are not an object is refused', () => {
  const agent = agentById('cursor');
  assert.throws(() => agent.updateEntry('{"mcpServers": {"innstance": {"url": "u", "headers": "Bearer x"}}}', URL_, TOKEN), /"headers" value that is not an object/);
});
