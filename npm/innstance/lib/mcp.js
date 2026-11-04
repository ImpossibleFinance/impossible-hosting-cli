'use strict';

const { request, NetworkError } = require('./http');
const { version } = require('../package.json');

// probeMCP asks the control plane's MCP endpoint to initialize, the first
// thing any agent will do with the config written here. It answers the one
// question setup and doctor need: will an agent that reads this config get a
// working server?
//
//   ok       the endpoint initialized (serverInfo is reported)
//   auth     the endpoint is live but refused the token (or none was sent)
//   forbidden  the token is valid but not allowed to use MCP (HTTP 403)
//   missing  the control plane has no /mcp yet (404)
//   error    anything else: an outage, an unexpected answer
//
// Streamable HTTP servers may answer a POST with plain JSON or with a short
// server-sent event stream; both are read, and the read stops as soon as the
// initialize result has arrived. A session the server opened for the probe is
// closed again with DELETE so it does not linger.

const PROTOCOL_VERSION = '2025-06-18';
const PROBE_CLIENT_NAME = 'innstance-npx-probe';

function initializeRequest() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      // A distinct name, so MCP session and funnel metrics that count
      // sessions by clientInfo can leave these probes out: every setup and
      // doctor run opens one, and none of them will ever publish anything.
      clientInfo: { name: PROBE_CLIENT_NAME, version },
    },
  };
}

// firstResponse extracts the JSON-RPC response to our id from a JSON body or
// an SSE stream ("data:" lines, events separated by a blank line).
function firstResponse(text, isSSE) {
  if (!isSSE) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.find((m) => m && m.id === 1) || null : parsed;
    } catch {
      return null;
    }
  }
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      const message = JSON.parse(data);
      if (message && message.id === 1) return message;
    } catch {
      // An event split across reads; the caller will read more.
    }
  }
  return null;
}

async function probeMCP(mcpURL, token, { timeoutMs = 15000 } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const streamed = (h) => String((h && h['content-type']) || '').includes('text/event-stream');
  let res;
  try {
    res = await request('POST', mcpURL, {
      headers,
      body: JSON.stringify(initializeRequest()),
      timeoutMs,
      maxBytes: 256 << 10,
      stopWhen: (buf, h) => streamed(h) && firstResponse(buf.toString('utf8'), true) !== null,
    });
  } catch (err) {
    return { state: 'error', detail: err instanceof NetworkError ? err.message : `MCP request failed: ${err.message}` };
  }
  const isSSE = streamed(res.headers);
  if (res.status === 404) return { state: 'missing', detail: `${mcpURL} is not available on this server yet` };
  if (res.status === 401 || (res.status === 403 && !token)) {
    return { state: 'auth', detail: token ? 'the MCP endpoint refused this token' : 'the MCP endpoint is live and needs a token' };
  }
  if (res.status === 403) {
    // The token was accepted as a sign-in but may not use MCP (a server that
    // asks for a scoped or newer kind of token). Signing in again the same
    // way would not change that, so this is told apart from a refusal.
    return { state: 'forbidden', detail: 'the MCP endpoint does not allow this session to use MCP' };
  }
  if (res.status !== 200) return { state: 'error', detail: `the MCP endpoint answered HTTP ${res.status}` };

  const message = firstResponse(res.body.toString('utf8'), isSSE);
  const sessionId = res.headers['mcp-session-id'];
  if (sessionId && typeof sessionId === 'string') {
    // Best effort: a server without sessions answers 405, which is fine.
    await request('DELETE', mcpURL, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Mcp-Session-Id': sessionId },
      timeoutMs: 5000,
    }).catch(() => {});
  }
  if (!message || message.error || !message.result) {
    const reason =
      message && message.error && typeof message.error.message === 'string'
        ? `: ${message.error.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 200)}`
        : '';
    return { state: 'error', detail: `the MCP endpoint did not initialize${reason}` };
  }
  const info = message.result.serverInfo || {};
  const name = [info.name, info.version].filter((v) => typeof v === 'string' && v).join(' ');
  return { state: 'ok', detail: name ? `initialized (${name.replace(/[\u0000-\u001f\u007f]/g, '')})` : 'initialized' };
}

module.exports = { probeMCP, firstResponse, PROTOCOL_VERSION, PROBE_CLIENT_NAME };
