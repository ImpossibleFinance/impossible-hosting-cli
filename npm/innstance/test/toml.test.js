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

test('comments and line endings outside our table are left exactly as they were', () => {
  const cases = [
    {
      name: 'commented-out table after ours at the end of the file',
      text: 'model = "o3"\n\n[mcp_servers.innstance]\nurl = "old"\n\n# [mcp_servers.disabled]\n# command = "foo"\n',
      set: 'model = "o3"\n\n' + BLOCK + '\n# [mcp_servers.disabled]\n# command = "foo"\n',
      removed: 'model = "o3"\n\n# [mcp_servers.disabled]\n# command = "foo"\n',
    },
    {
      name: 'a note for the next table, separated by a blank line',
      text: '[mcp_servers.innstance]\nurl = "old"\n# about the next table\n\n[profiles.fast]\nmodel = "x"\n',
      set: BLOCK + '\n# about the next table\n\n[profiles.fast]\nmodel = "x"\n',
      removed: '# about the next table\n\n[profiles.fast]\nmodel = "x"\n',
    },
    {
      name: 'a "#" line inside a multi-line string is part of the value',
      text: '[mcp_servers.innstance]\nurl = "old"\nnote = """\n# not a comment\n"""\n\n[x]\n',
      set: BLOCK + '\n[x]\n',
      removed: '[x]\n',
    },
    {
      name: 'mixed line endings are kept line by line',
      text: 'a = 1\r\nb = 2\n',
      set: 'a = 1\r\nb = 2\n\n' + BLOCK,
      removed: 'a = 1\r\nb = 2\n',
    },
    {
      name: 'no newline at the end of the file stays that way',
      text: '[mcp_servers.innstance]\nurl = "old"\n\n# just notes\n[x]\ny = 1',
      set: BLOCK + '\n# just notes\n[x]\ny = 1',
      removed: '# just notes\n[x]\ny = 1',
    },
  ];
  for (const c of cases) {
    assert.equal(toml.setServer(c.text, 'innstance', FIELDS, { comment: 'note' }), c.set, `${c.name}: set`);
    assert.equal(toml.removeServer(c.set, 'innstance'), c.removed, `${c.name}: removed`);
  }
});

test('updateServer changes only the url and Authorization lines', () => {
  const update = { url: 'https://x.example/mcp', authorization: 'Bearer n3w' };
  const cases = [
    {
      name: 'settings the person added survive, subtables included',
      text:
        'model = "o3"\n\n[mcp_servers.innstance]\n# note\nurl = "https://old.example/mcp"\nhttp_headers = { "Authorization" = "Bearer old" }\nenabled = false\ndisabled_tools = ["delete_app"]\ndefault_tools_approval_mode = "prompt"\ntool_timeout_sec = 300\n\n[mcp_servers.innstance.tools.deploy]\napproval_mode = "prompt"\n',
      want:
        'model = "o3"\n\n[mcp_servers.innstance]\n# note\nurl = "https://x.example/mcp"\nhttp_headers = { "Authorization" = "Bearer n3w" }\nenabled = false\ndisabled_tools = ["delete_app"]\ndefault_tools_approval_mode = "prompt"\ntool_timeout_sec = 300\n\n[mcp_servers.innstance.tools.deploy]\napproval_mode = "prompt"\n',
    },
    {
      name: 'other headers in the inline table are kept, in order',
      text: '[mcp_servers.innstance]\nurl = "https://x.example/mcp" # ours\nhttp_headers = { X-Team = "a", authorization = "Bearer old" }\n',
      want: '[mcp_servers.innstance]\nurl = "https://x.example/mcp" # ours\nhttp_headers = { "X-Team" = "a", "authorization" = "Bearer n3w" }\n',
    },
    {
      name: 'headers in their own subtable',
      text: '[mcp_servers.innstance]\nurl = "u"\n\n[mcp_servers.innstance.http_headers]\nX-Team = "a"\nAuthorization = \'Bearer old\'\n',
      want: '[mcp_servers.innstance]\nurl = "https://x.example/mcp"\n\n[mcp_servers.innstance.http_headers]\nX-Team = "a"\nAuthorization = "Bearer n3w"\n',
    },
    {
      name: 'a dotted header key',
      text: '[mcp_servers.innstance]\nurl = "u"\nhttp_headers.Authorization = "Bearer old"\n',
      want: '[mcp_servers.innstance]\nurl = "https://x.example/mcp"\nhttp_headers.Authorization = "Bearer n3w"\n',
    },
    {
      name: 'missing lines are added below the header and its note',
      text: '[mcp_servers.innstance]\n# note\nstartup_timeout_sec = 30\n',
      want: '[mcp_servers.innstance]\n# note\nurl = "https://x.example/mcp"\nhttp_headers = { "Authorization" = "Bearer n3w" }\nstartup_timeout_sec = 30\n',
    },
    {
      name: 'CRLF file',
      text: '[mcp_servers.innstance]\r\nurl = "u"\r\nenabled = true\r\n',
      want: '[mcp_servers.innstance]\r\nurl = "https://x.example/mcp"\r\nhttp_headers = { "Authorization" = "Bearer n3w" }\r\nenabled = true\r\n',
    },
  ];
  for (const c of cases) {
    const got = toml.updateServer(c.text, 'innstance', update);
    assert.equal(got, c.want, c.name);
    assert.equal(toml.updateServer(got, 'innstance', update), got, `${c.name}: a second update changes nothing`);
  }
  assert.equal(toml.updateServer('model = "o3"\n', 'innstance', update), null, 'no table to update');
  assert.equal(toml.updateServer('', 'innstance', update), null);
});

test('updateServer refuses values it cannot rewrite in place', () => {
  const update = { url: 'https://x.example/mcp', authorization: 'Bearer n3w' };
  const cases = [
    '[mcp_servers.innstance]\nurl = """\nhttps://x.example/mcp"""\n',
    '[mcp_servers.innstance]\nurl = "u"\nhttp_headers = "Bearer x"\n',
    '[mcp_servers.innstance.http_headers]\nAuthorization = "Bearer old"\n',
    '[mcp_servers]\ninnstance = { url = "x" }\n',
  ];
  for (const text of cases) {
    assert.throws(() => toml.updateServer(text, 'innstance', update), toml.TOMLConflictError, text);
  }
});

test('readServer keeps hostile key names as data', () => {
  const text = '[mcp_servers.innstance]\nurl = "https://x/mcp"\n\n[mcp_servers.innstance.__proto__]\nAuthorization = "Bearer polluted"\nurl = "https://evil/mcp"\n';
  const got = toml.readServer(text, 'innstance');
  assert.equal(({}).Authorization, undefined, 'Object.prototype is untouched');
  assert.equal(({}).url, undefined);
  assert.equal(got.url, 'https://x/mcp');
  assert.ok(Object.prototype.hasOwnProperty.call(got, '__proto__'));
  assert.equal(toml.readServer('[mcp_servers.innstance]\nhttp_headers = { "__proto__" = "x" }\n', 'innstance').http_headers.__proto__, 'x');
});
