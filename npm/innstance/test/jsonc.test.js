'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const jsonc = require('../lib/jsonc');

const ENTRY = { url: 'https://x.example/mcp', headers: { Authorization: 'Bearer t0k3n' } };
const PATH = ['mcpServers', 'innstance'];

test('parse reads JSON and JSON with comments and trailing commas', () => {
  const cases = [
    { text: '', want: undefined },
    { text: '  \n', want: undefined },
    { text: '{}', want: {} },
    { text: '﻿{"a": 1}', want: { a: 1 } },
    { text: '{"a": [1, 2.5e3, -0, true, false, null, "s\\"q"]}', want: { a: [1, 2500, -0, true, false, null, 's"q'] } },
    { text: '{\n  // line\n  "a": 1, /* block */ "b": {"c": [1,],},\n}', want: { a: 1, b: { c: [1] } } },
    { text: '{"a": 1, "a": 2}', want: { a: 2 } },
    { text: '{"__proto__": {"x": 1}}', want: JSON.parse('{"__proto__": {"x": 1}}') },
    { text: '{"url": "http://a/b // not a comment"}', want: { url: 'http://a/b // not a comment' } },
  ];
  for (const c of cases) assert.deepEqual(jsonc.parse(c.text), c.want, JSON.stringify(c.text));
});

test('parse reports where a file is broken', () => {
  const cases = [
    { text: '{"a": 1', err: /line 1/ },
    { text: '{\n  "a": 1\n  "b": 2\n}', err: /line 3/ },
    { text: '{a: 1}', err: /quoted key/ },
    { text: '{"a": /* open', err: /unterminated comment/ },
    { text: '{"a": "line\nbreak"}', err: /line break/ },
    { text: '{} {}', err: /after the value/ },
    { text: '{"a": tru}', err: /unexpected/ },
  ];
  for (const c of cases) assert.throws(() => jsonc.parse(c.text), c.err, JSON.stringify(c.text));
});

test('setAt edits one member and leaves every other byte alone', () => {
  const cases = [
    {
      name: 'empty file becomes a new document',
      text: '',
      want: '{\n  "mcpServers": {\n    "innstance": {\n      "url": "https://x.example/mcp",\n      "headers": {\n        "Authorization": "Bearer t0k3n"\n      }\n    }\n  }\n}\n',
    },
    {
      name: 'compact one-line file stays compact',
      text: '{"theme":"dark"}',
      want: '{"mcpServers":{"innstance":{"url":"https://x.example/mcp","headers":{"Authorization":"Bearer t0k3n"}}},"theme":"dark"}',
    },
    {
      name: 'existing servers, comments and four-space indent are kept',
      text: '{\n    // my servers\n    "mcpServers": {\n        "other": {"command": "x"} // keep me\n    },\n    "n": 1.50\n}\n',
      want:
        '{\n    // my servers\n    "mcpServers": {\n        "innstance": {\n            "url": "https://x.example/mcp",\n            "headers": {\n                "Authorization": "Bearer t0k3n"\n            }\n        },\n        "other": {"command": "x"} // keep me\n    },\n    "n": 1.50\n}\n',
    },
    {
      name: 'an existing entry is replaced in place',
      text: '{\n  "mcpServers": {\n    "a": 1,\n    "innstance": {"url": "old"},\n    "z": 2\n  }\n}\n',
      want:
        '{\n  "mcpServers": {\n    "a": 1,\n    "innstance": {\n      "url": "https://x.example/mcp",\n      "headers": {\n        "Authorization": "Bearer t0k3n"\n      }\n    },\n    "z": 2\n  }\n}\n',
    },
    {
      name: 'empty object with only a comment keeps the comment',
      text: '{\n  "mcpServers": { /* none yet */ }\n}\n',
      want:
        '{\n  "mcpServers": {\n    "innstance": {\n      "url": "https://x.example/mcp",\n      "headers": {\n        "Authorization": "Bearer t0k3n"\n      }\n    } /* none yet */ }\n}\n',
    },
    {
      name: 'CRLF files stay CRLF',
      text: '{\r\n  "a": 1\r\n}\r\n',
      want:
        '{\r\n  "mcpServers": {\r\n    "innstance": {\r\n      "url": "https://x.example/mcp",\r\n      "headers": {\r\n        "Authorization": "Bearer t0k3n"\r\n      }\r\n    }\r\n  },\r\n  "a": 1\r\n}\r\n',
    },
  ];
  for (const c of cases) {
    const got = jsonc.setAt(c.text, PATH, ENTRY);
    assert.equal(got, c.want, c.name);
    assert.deepEqual(jsonc.getAt(jsonc.parse(got), PATH), ENTRY, c.name);
  }
});

test('setAt seeds only a brand-new document', () => {
  const seed = { $schema: 'https://opencode.ai/config.json' };
  const fresh = jsonc.parse(jsonc.setAt(null, ['mcp', 'innstance'], { a: 1 }, { seed }));
  assert.deepEqual(Object.keys(fresh), ['$schema', 'mcp']);
  const existing = jsonc.parse(jsonc.setAt('{"model": "x"}', ['mcp', 'innstance'], { a: 1 }, { seed }));
  assert.equal(existing.$schema, undefined);
});

test('setAt refuses to edit through a value that is not an object', () => {
  assert.throws(() => jsonc.setAt('{"mcpServers": []}', PATH, ENTRY), /not an object/);
  assert.throws(() => jsonc.setAt('[1, 2]', PATH, ENTRY), /JSON object/);
  assert.throws(() => jsonc.setAt('{"a": ', PATH, ENTRY), /unexpected end/);
});

test('removeAt removes the member and repairs commas', () => {
  const cases = [
    {
      name: 'first of several',
      text: '{\n  "mcpServers": {\n    "innstance": {"url": "u"},\n    "other": 1\n  }\n}\n',
      want: '{\n  "mcpServers": {\n    "other": 1\n  }\n}\n',
    },
    {
      name: 'last of several takes the previous comma',
      text: '{\n  "mcpServers": {\n    "other": 1,\n    "innstance": {"url": "u"}\n  }\n}\n',
      want: '{\n  "mcpServers": {\n    "other": 1\n  }\n}\n',
    },
    {
      name: 'only member leaves an empty object',
      text: '{\n  "mcpServers": {\n    "innstance": {"url": "u"}\n  },\n  "x": 1\n}\n',
      want: '{\n  "mcpServers": {},\n  "x": 1\n}\n',
    },
    {
      name: 'duplicates are all removed',
      text: '{"mcpServers": {"innstance": 1, "a": 2, "innstance": 3}}',
      want: '{"mcpServers": {"a": 2}}',
    },
    {
      name: 'absent member is a no-op',
      text: '{\n  // c\n  "mcpServers": {}\n}\n',
      want: '{\n  // c\n  "mcpServers": {}\n}\n',
    },
    { name: 'no file', text: null, want: null },
  ];
  for (const c of cases) {
    const got = jsonc.removeAt(c.text, PATH);
    assert.equal(got, c.want, c.name);
    if (got) jsonc.parse(got);
  }
});

test('a round trip through setAt and removeAt restores the original bytes', () => {
  const originals = [
    '{\n  "mcpServers": {\n    "other": {"url": "x"}\n  },\n  "numStartups": 12\n}\n',
    '{\n  "b": true\n}\n',
  ];
  for (const original of originals) {
    const edited = jsonc.setAt(original, PATH, ENTRY);
    const restored = jsonc.removeAt(edited, PATH);
    if (original.includes('mcpServers')) assert.equal(restored, original);
    else assert.deepEqual(jsonc.parse(restored), { mcpServers: {}, b: true });
  }
});
