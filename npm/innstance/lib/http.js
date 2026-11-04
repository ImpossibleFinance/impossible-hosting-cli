'use strict';

const http = require('node:http');
const https = require('node:https');

const { version } = require('../package.json');

// Built on node:http rather than fetch for three reasons. fetch prints an
// ExperimentalWarning on Node 18, which is the floor this package supports.
// node:http never follows redirects, which is what every call here wants: a
// token must not be replayed to wherever a 3xx points. And it lets a response
// be cut off at a byte limit, or as soon as the part we need has arrived,
// instead of buffering whatever a server chooses to send.
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 64 << 10;

const USER_AGENT = `innstance-npx/${version} node/${process.versions.node} ${process.platform}`;

class NetworkError extends Error {
  constructor(url, cause) {
    super(`could not reach ${new URL(url).origin}: ${describeNetworkCause(cause)}`);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

function describeNetworkCause(err) {
  switch (err && err.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the name did not resolve (check your connection or DNS)';
    case 'ECONNREFUSED':
      return 'the connection was refused';
    case 'ECONNRESET':
      return 'the connection was reset';
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return 'the request timed out';
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return `the TLS certificate was not trusted (${err.code})`;
    default:
      return (err && err.message) || 'unknown error';
  }
}

// request performs one HTTP exchange. It resolves for every status code (the
// callers decide what a 404 or 401 means) and rejects only for transport
// failures, timeouts and oversized bodies. stopWhen, if given, is called with
// the bytes received so far and the response headers; returning true ends the
// read early, which is how an MCP response streamed as server-sent events is
// read without waiting for the server to close the stream.
function request(method, url, options = {}) {
  const {
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    stopWhen,
  } = options;
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
  if (!transport) {
    return Promise.reject(new Error(`refusing to request a non-http(s) URL: ${target.protocol}`));
  }
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const allHeaders = { 'User-Agent': USER_AGENT, ...headers };
  if (payload) allHeaders['Content-Length'] = String(payload.length);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = transport.request(target, { method, headers: allHeaders });
    const timer = setTimeout(() => {
      const err = new Error('timed out');
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    }, timeoutMs);
    req.on('error', (err) => finish(reject, new NetworkError(url, err)));
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      const done = () =>
        finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          finish(reject, new Error(`response from ${target.origin} exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
        if (stopWhen && stopWhen(Buffer.concat(chunks), res.headers)) {
          done();
          res.destroy();
        }
      });
      res.on('end', done);
      res.on('error', (err) => finish(reject, new NetworkError(url, err)));
      res.on('close', () => {
        if (!res.complete) finish(reject, new NetworkError(url, new Error('the response was cut off')));
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function postJSON(url, value, options = {}) {
  return request('POST', url, {
    ...options,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(value),
  });
}

function parseJSONBody(res) {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return undefined;
  }
}

// serverMessage turns an error response into one printable line. The server
// answers {"error": "..."}; anything else is reduced to its status. Control
// characters are stripped so a hostile body cannot rewrite the terminal.
function serverMessage(res) {
  const parsed = parseJSONBody(res);
  let text = '';
  if (parsed && typeof parsed === 'object') {
    text = typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : '';
  }
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  if (text.length > 300) text = text.slice(0, 297) + '...';
  return text ? `${text} (HTTP ${res.status})` : `HTTP ${res.status}`;
}

module.exports = { request, postJSON, parseJSONBody, serverMessage, NetworkError, USER_AGENT };
