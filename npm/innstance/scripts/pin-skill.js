#!/usr/bin/env node
'use strict';

// Maintains lib/skill-pin.json, the reviewed skill revision this package
// installs.
//
//   node scripts/pin-skill.js --check     verify the current pin against GitHub
//   node scripts/pin-skill.js <commit>    pin a new 40-character skill commit
//
// Pin a commit only after it has been reviewed and merged to the skill
// repository's protected main branch (both modes check that it is on main), and normally the same commit the Go
// CLI pins (internal/agentskill/source.go in the platform repository), so
// both clients hand agents the same instructions.

const fs = require('node:fs');
const path = require('node:path');

const { request, parseJSONBody } = require('../lib/http');
const { SKILL_FILES, downloadSkillFile, fetchSkill, officialBaseURL, sha256, validatePin } = require('../lib/skill');

const PIN_FILE = path.join(__dirname, '..', 'lib', 'skill-pin.json');

// assertOnMain fails unless the pinned commit is on the skill repository's
// main branch. raw.githubusercontent.com serves any commit in a repository's
// fork network by its SHA, so without this a pin could name a commit that
// never landed on the protected main, and the hash check would still pass.
// GitHub's compare API says how main relates to the commit: "ahead" or
// "identical" means the commit is an ancestor of main. GITHUB_TOKEN, when
// set (as it is in CI), only raises the API rate limit.
async function assertOnMain(pin, { apiBase = 'https://api.github.com', token = process.env.GITHUB_TOKEN } = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `${apiBase}/repos/${pin.repository}/compare/${pin.commit}...main?per_page=1`;
  const res = await request('GET', url, { headers, timeoutMs: 20000, maxBytes: 16 << 20 });
  if (res.status !== 200) throw new Error(`could not compare ${pin.commit} with main: HTTP ${res.status}`);
  const status = (parseJSONBody(res) || {}).status;
  if (status !== 'ahead' && status !== 'identical') {
    throw new Error(`${pin.repository}@${pin.commit} is not on main (main is ${JSON.stringify(String(status))} of it); pin only commits merged to main`);
  }
}

async function check() {
  const pin = validatePin(JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')));
  await assertOnMain(pin);
  const bundle = await fetchSkill({ pin });
  console.log(`skill pin ok: ${pin.repository}@${pin.commit} (on main) version ${bundle.version}`);
}

async function repin(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('give a full 40-character lowercase commit hash');
  const current = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
  const pin = { repository: current.repository, commit, version: '', files: {} };
  await assertOnMain(pin);
  const base = officialBaseURL(pin);
  const files = {};
  for (const name of SKILL_FILES) {
    const res = await downloadSkillFile(`${base}/${name}`);
    if (res.status !== 200) throw new Error(`${name}: HTTP ${res.status}`);
    files[name] = res.body;
    pin.files[name] = sha256(res.body);
  }
  pin.version = JSON.parse(files['manifest.json'].toString('utf8')).version;
  validatePin(pin);
  fs.writeFileSync(PIN_FILE, JSON.stringify(pin, null, 2) + '\n');
  console.log(`pinned ${pin.repository}@${commit} version ${pin.version}`);
}

if (require.main === module) {
  const arg = process.argv[2];
  (arg === '--check' ? check() : arg ? repin(arg) : Promise.reject(new Error('usage: pin-skill.js --check | <commit>'))).catch((err) => {
    console.error(`pin-skill: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { assertOnMain };
