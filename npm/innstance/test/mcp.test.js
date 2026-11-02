'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { firstResponse, probeMCP } = require('../lib/mcp');
const { startFakeServer } = require('./helpers');

test('probeMCP reports what an agent would find at the endpoint', async (t) => {
  const cases = [
    { name: 'JSON answer', mcp: 'json', token: true, state: 'ok', detail: /initialized \(innstance 0\.0\.1\)/, deletes: 1 },
    { name: 'SSE answer left open', mcp: 'sse', token: true, state: 'ok', detail: /initialized/, deletes: 1 },
    { name: 'not deployed yet', mcp: 'missing', token: true, state: 'missing', detail: /not available/ },
    { name: 'token refused', mcp: 'json', token: 'bogus', state: 'auth', detail: /refused this token/ },
    { name: 'no token', mcp: 'json', token: false, state: 'auth', detail: /needs a token/ },
    { name: 'server error', mcp: '500', token: true, state: 'error', detail: /HTTP 500/ },
  ];
  for (const c of cases) {
    const server = await startFakeServer({ mcp: c.mcp });
    const valid = 'imp_' + 'c'.repeat(64);
    server.state.sessions.set('npx-test', valid);
    const token = c.token === true ? valid : c.token === false ? '' : 'imp_' + 'd'.repeat(64);
    const got = await probeMCP(server.origin + '/mcp', token);
    assert.equal(got.state, c.state, c.name);
    assert.match(got.detail, c.detail, c.name);
    if (c.deletes) assert.equal(server.state.mcpDeletes, c.deletes, `${c.name}: the probe session is closed`);
    await server.close();
  }
});

test('probeMCP gives up on an endpoint that never answers', async (t) => {
  const server = http.createServer(() => {
    // Accept the request and say nothing.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections && server.closeAllConnections();
    server.close();
  });
  const silent = await probeMCP(`http://127.0.0.1:${server.address().port}/mcp`, '', { timeoutMs: 200 });
  assert.equal(silent.state, 'error');
  assert.match(silent.detail, /timed out/);
  const unreachable = await probeMCP('http://127.0.0.1:1/mcp', '');
  assert.equal(unreachable.state, 'error');
  assert.match(unreachable.detail, /could not reach/);
});

test('firstResponse reads JSON and event streams', () => {
  const reply = { jsonrpc: '2.0', id: 1, result: {} };
  const cases = [
    { text: JSON.stringify(reply), sse: false, want: reply },
    { text: JSON.stringify([{ jsonrpc: '2.0', method: 'note' }, reply]), sse: false, want: reply },
    { text: 'not json', sse: false, want: null },
    { text: `event: message\ndata: ${JSON.stringify(reply)}\n\n`, sse: true, want: reply },
    { text: `data: {"jsonrpc":"2.0","method":"notifications/x"}\n\ndata: ${JSON.stringify(reply)}\n\n`, sse: true, want: reply },
    { text: 'data: {"jsonrpc":"2.0","id":1,', sse: true, want: null },
  ];
  for (const c of cases) assert.deepEqual(firstResponse(c.text, c.sse), c.want, c.text);
});
