'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DEFAULT_ORIGIN, mcpURL, resolveOrigin, validateOrigin } = require('../lib/origin');

test('validateOrigin accepts https and loopback http origins only', () => {
  const cases = [
    { raw: 'https://innstance.impossibuild.ai', want: 'https://innstance.impossibuild.ai' },
    { raw: 'https://innstance.impossibuild.ai/', want: 'https://innstance.impossibuild.ai' },
    { raw: 'https://staging.example.com:8443', want: 'https://staging.example.com:8443' },
    { raw: 'http://127.0.0.1:8080', want: 'http://127.0.0.1:8080' },
    { raw: 'http://localhost:3000', want: 'http://localhost:3000' },
    { raw: 'http://[::1]:3000', want: 'http://[::1]:3000' },
    { raw: 'http://innstance.impossibuild.ai', err: /loopback/ },
    { raw: 'https://innstance.impossibuild.ai/api', err: /origin only/ },
    { raw: 'https://innstance.impossibuild.ai?x=1', err: /origin only/ },
    { raw: 'https://innstance.impossibuild.ai#x', err: /origin only/ },
    { raw: 'https://user:pass@innstance.impossibuild.ai', err: /credentials/ },
    { raw: 'ftp://innstance.impossibuild.ai', err: /not allowed/ },
    { raw: 'innstance.impossibuild.ai', err: /./ },
    { raw: 'file:///etc/passwd', err: /./ },
  ];
  for (const c of cases) {
    if (c.err) assert.throws(() => validateOrigin(c.raw), c.err, c.raw);
    else assert.equal(validateOrigin(c.raw), c.want, c.raw);
  }
});

test('resolveOrigin prefers the flag, then IMPOSSIBLE_API_URL, then the default', () => {
  const cases = [
    { flag: '', env: {}, want: DEFAULT_ORIGIN },
    { flag: '', env: { IMPOSSIBLE_API_URL: 'http://127.0.0.1:9' }, want: 'http://127.0.0.1:9' },
    { flag: 'https://a.example', env: { IMPOSSIBLE_API_URL: 'http://127.0.0.1:9' }, want: 'https://a.example' },
    { flag: '', env: { IMPOSSIBLE_API_URL: 'http://evil.example' }, err: /IMPOSSIBLE_API_URL/ },
    { flag: 'http://evil.example', env: {}, err: /--server/ },
  ];
  for (const c of cases) {
    if (c.err) assert.throws(() => resolveOrigin(c.flag, c.env), c.err);
    else assert.equal(resolveOrigin(c.flag, c.env), c.want);
  }
});

test('the MCP endpoint lives on the control plane', () => {
  assert.equal(mcpURL(DEFAULT_ORIGIN), 'https://innstance.impossibuild.ai/mcp');
});
