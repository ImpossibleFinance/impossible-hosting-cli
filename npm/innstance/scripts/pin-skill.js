#!/usr/bin/env node
'use strict';

// Maintains lib/skill-pin.json, the reviewed skill revision this package
// installs.
//
//   node scripts/pin-skill.js --check     verify the current pin against GitHub
//   node scripts/pin-skill.js <commit>    pin a new 40-character skill commit
//
// Pin a commit only after it has been reviewed and merged to the skill
// repository's protected main branch, and normally the same commit the Go
// CLI pins (internal/agentskill/source.go in the platform repository), so
// both clients hand agents the same instructions.

const fs = require('node:fs');
const path = require('node:path');

const { SKILL_FILES, downloadSkillFile, fetchSkill, officialBaseURL, sha256, validatePin } = require('../lib/skill');

const PIN_FILE = path.join(__dirname, '..', 'lib', 'skill-pin.json');

async function check() {
  const pin = validatePin(JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')));
  const bundle = await fetchSkill({ pin });
  console.log(`skill pin ok: ${pin.repository}@${pin.commit} version ${bundle.version}`);
}

async function repin(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('give a full 40-character lowercase commit hash');
  const current = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
  const pin = { repository: current.repository, commit, version: '', files: {} };
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

const arg = process.argv[2];
(arg === '--check' ? check() : arg ? repin(arg) : Promise.reject(new Error('usage: pin-skill.js --check | <commit>'))).catch((err) => {
  console.error(`pin-skill: ${err.message}`);
  process.exitCode = 1;
});
