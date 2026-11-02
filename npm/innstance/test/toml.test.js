'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const toml = require('../lib/toml');

const FIELDS = { url: 'https://x.example/mcp', http_headers: { Authorization: 'Bearer t0k3n' } };
const BLOCK = '[mcp_servers.innstance]\n# note\nurl = "https://x.example/mcp"\nhttp_headers = { "Authorization" = "Bearer t0k3n" }\n';

test('setServer writes the table and leaves the rest of config.toml alone', () => {
  const cases = [
    { name: 'empty file', text: '', want: BLOCK },
    { name: 'root keys only', text: 'model = "o3"\n', want: 'model = "o3"\n\n' + BLOCK },
    {
      name: 'appended after other servers',
      text: 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n',
      want: 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n' + BLOCK,
    },
    {
      name: 'replaced in place, subtables included, next table keeps its comment',
      text:
        '[mcp_servers.innstance]\nurl = "old"\n\n[mcp_servers.innstance.http_headers]\nAuthorization = "Bearer old"\n\n# second server\n[mcp_servers.b]\nurl = "y"\n',
      want: BLOCK + '\n# second server\n[mcp_servers.b]\nurl = "y"\n',
    },
    {
      name: 'quoted header names the same table',
      text: '[mcp_servers."innstance"]\nurl = "old"\n[profile]\nx = 1\n',
      want: BLOCK + '\n[profile]\nx = 1\n',
    },
    {
      name: 'header-looking lines inside strings and arrays are not headers',
      text: 'notes = """\n[mcp_servers.innstance]\n"""\nlit = \'\'\'\n[x]\n\'\'\'\nmatrix = [\n  [1, 2],\n]\n',
      want: 'notes = """\n[mcp_servers.innstance]\n"""\nlit = \'\'\'\n[x]\n\'\'\'\nmatrix = [\n  [1, 2],\n]\n\n' + BLOCK,
    },
    {
      name: 'CRLF kept',
      text: 'a = 1\r\n',
      want: ('a = 1\n\n' + BLOCK).replace(/\n/g, '\r\n'),
    },
  ];
  for (const c of cases) {
    const got = toml.setServer(c.text, 'innstance', FIELDS, { comment: 'note' });
    assert.equal(got, c.want, c.name);
    assert.deepEqual(toml.readServer(got, 'innstance'), FIELDS, c.name);
  }
});

test('setServer refuses definitions it cannot rewrite safely', () => {
  const cases = [
    'mcp_servers = { innstance = { url = "x" } }\n',
    '[mcp_servers]\ninnstance = { url = "x" }\n',
    '[mcp_servers]\ninnstance.url = "x"\n',
    'mcp_servers.innstance.url = "x"\n',
  ];
  for (const text of cases) {
    assert.throws(() => toml.setServer(text, 'innstance', FIELDS), toml.TOMLConflictError, text);
  }
  // Another server defined with dotted keys is not ours to object to.
  const fine = toml.setServer('[mcp_servers]\nother.url = "x"\n', 'innstance', FIELDS);
  assert.deepEqual(toml.readServer(fine, 'innstance'), FIELDS);
});

test('readServer understands the forms people write by hand', () => {
  const cases = [
    { text: 'x = 1\n', want: null },
    { text: '[mcp_servers.innstance]\nurl = \'https://lit\'\n', want: { url: 'https://lit' } },
    {
      text: '[mcp_servers.innstance]\nurl = "u" # trailing\nhttp_headers.Authorization = "Bearer a"\n',
      want: { url: 'u', http_headers: { Authorization: 'Bearer a' } },
    },
    {
      text: '[mcp_servers.innstance]\nurl = "u\\u0041"\n[mcp_servers.innstance.http_headers]\nAuthorization = "Bearer b"\n',
      want: { url: 'uA', http_headers: { Authorization: 'Bearer b' } },
    },
    { text: '[mcp_servers.innstance]\nstartup_timeout_sec = 30\n', want: {} },
  ];
  for (const c of cases) assert.deepEqual(toml.readServer(c.text, 'innstance'), c.want, c.text);
});

test('removeServer cuts only our table', () => {
  const cases = [
    { text: '', want: '' },
    { text: 'a = 1\n', want: 'a = 1\n' },
    { text: 'a = 1\n\n' + BLOCK, want: 'a = 1\n' },
    { text: '[x]\ny = 1\n\n' + BLOCK + '\n[z]\nw = 2\n', want: '[x]\ny = 1\n\n[z]\nw = 2\n' },
    { text: BLOCK, want: '' },
  ];
  for (const c of cases) assert.equal(toml.removeServer(c.text, 'innstance'), c.want, JSON.stringify(c.text));
});

test('tomlString escapes what TOML requires', () => {
  assert.equal(toml.tomlString('a"b\\c\n'), '"a\\"b\\\\c\\u000a"');
});
