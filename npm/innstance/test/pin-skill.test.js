'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { assertOnMain } = require('../scripts/pin-skill');
const { testSkill } = require('./helpers');

test('a skill pin must name a commit that is on main', async (t) => {
  let answer = { status: 200, body: {} };
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || '' });
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const { pin } = testSkill();

  const cases = [
    { name: 'main is ahead of the commit', answer: { status: 200, body: { status: 'ahead' } }, ok: true },
    { name: 'main is the commit', answer: { status: 200, body: { status: 'identical' } }, ok: true },
    { name: 'a commit from a fork that never landed', answer: { status: 200, body: { status: 'diverged' } }, err: /is not on main \(main is "diverged"/ },
    { name: 'a commit newer than main', answer: { status: 200, body: { status: 'behind' } }, err: /is not on main/ },
    { name: 'an unknown commit', answer: { status: 404, body: { message: 'Not Found' } }, err: /HTTP 404/ },
  ];
  for (const c of cases) {
    answer = c.answer;
    const run = assertOnMain(pin, { apiBase, token: 'gh-token' });
    if (c.ok) await run;
    else await assert.rejects(run, c.err, c.name);
  }
  assert.equal(seen[0].url, `/repos/${pin.repository}/compare/${pin.commit}...main?per_page=1`);
  assert.equal(seen[0].auth, 'Bearer gh-token');
});
