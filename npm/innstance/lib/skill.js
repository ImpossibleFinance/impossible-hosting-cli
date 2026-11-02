'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { request } = require('./http');
const { ensureDir, writeFileAtomic } = require('./fsutil');
const PIN = require('./skill-pin.json');

// The Innstance skill is the published agent guide in the public
// impossible-hosting-skill repository. Like the Go CLI's `skill sync`, this
// package never follows a branch: it downloads from one immutable commit
// (raw.githubusercontent.com/<repo>/<40-hex commit>/...), so a later push to
// the skill repository cannot change what an agent installed from this
// release is asked to run. It goes one step further than the Go CLI and pins
// the SHA-256 of each file too. The Go CLI dropped per-file hashes because
// they lived in the skill repository beside the files they described and so
// authenticated nothing; these live in this package, which is published with
// npm provenance from a different repository, so they do.
//
// To move the pin to a newer reviewed skill commit, run
//   node scripts/pin-skill.js <commit>
// which downloads that commit's files and rewrites skill-pin.json.

const SKILL_NAME = 'innstance';
const SKILL_FILES = ['SKILL.md', 'RUNBOOK.md', 'manifest.json'];
const MAX_SKILL_FILE_BYTES = 2 << 20;

function validatePin(pin) {
  if (!pin || typeof pin !== 'object') throw new Error('skill pin is missing');
  if (pin.repository !== 'ImpossibleFinance/impossible-hosting-skill') throw new Error('skill pin names an unexpected repository');
  if (typeof pin.commit !== 'string' || !/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error('skill pin is not a 40-character lowercase commit');
  if (!parseVersion(pin.version)) throw new Error('skill pin has no usable version');
  const names = Object.keys(pin.files || {}).sort();
  if (JSON.stringify(names) !== JSON.stringify(SKILL_FILES.slice().sort())) throw new Error('skill pin must list exactly SKILL.md, RUNBOOK.md and manifest.json');
  for (const name of names) {
    if (!/^[0-9a-f]{64}$/.test(pin.files[name])) throw new Error(`skill pin hash for ${name} is malformed`);
  }
  return pin;
}

function officialBaseURL(pin) {
  return `https://raw.githubusercontent.com/${pin.repository}/${pin.commit}`;
}

// parseVersion reads the skill's "YYYYMMDD-N" version. Compared as numbers,
// so 20260924-10 is newer than 20260924-9.
function parseVersion(v) {
  const m = typeof v === 'string' && /^(\d{8})-(\d{1,6})$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  return pa[0] - pb[0] || pa[1] - pb[1];
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// fetchSkill downloads the pinned files and verifies every byte before
// anything is written. baseURL exists for the tests; whatever serves the
// files, they must match the pinned hashes.
async function fetchSkill({ pin = PIN, baseURL } = {}) {
  validatePin(pin);
  const base = (baseURL || officialBaseURL(pin)).replace(/\/+$/, '');
  const files = {};
  for (const name of SKILL_FILES) {
    const res = await request('GET', `${base}/${name}`, { timeoutMs: 20000, maxBytes: MAX_SKILL_FILE_BYTES });
    if (res.status !== 200) throw new Error(`could not download skill ${name}: HTTP ${res.status}`);
    const got = sha256(res.body);
    if (got !== pin.files[name]) {
      throw new Error(`skill ${name} does not match the pinned SHA-256 (got ${got}); nothing was installed`);
    }
    files[name] = res.body;
  }
  let manifest;
  try {
    manifest = JSON.parse(files['manifest.json'].toString('utf8'));
  } catch {
    throw new Error('skill manifest.json is not JSON');
  }
  if (!manifest || manifest.version !== pin.version) {
    throw new Error('skill manifest version does not match the pin');
  }
  return { version: pin.version, files };
}

function readInstalled(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.version === 'string' ? { version: parsed.version } : { version: '' };
  } catch {
    return { version: '' };
  }
}

function sameFiles(dir, bundle) {
  return SKILL_FILES.every((name) => {
    try {
      return sha256(fs.readFileSync(path.join(dir, name))) === sha256(bundle.files[name]);
    } catch {
      return false;
    }
  });
}

// installSkill writes the bundle to <skillsRoot>/innstance and reports what it
// did. A directory of that name that is not an Innstance skill (no manifest
// with a version) belongs to someone else and is left alone unless force is
// set. A newer Innstance skill — one the Go CLI's `skill sync` or a later
// release put there — is kept rather than rolled back.
//
// manifest.json is written last, so a failure part-way through leaves the old
// version recorded and the next run repairs the rest.
async function installSkill(skillsRoot, bundle, { force = false } = {}) {
  const dir = path.join(skillsRoot, SKILL_NAME);
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stat && !stat.isDirectory()) {
    return { dir, status: 'skipped', detail: `${dir} exists and is not a directory` };
  }
  if (stat) {
    const installed = readInstalled(dir);
    if (!installed || !installed.version) {
      if (!force) {
        return { dir, status: 'skipped', detail: `${dir} exists but is not an Innstance skill; re-run with --force to replace it` };
      }
    } else {
      const order = compareVersions(installed.version, bundle.version);
      if (order !== null && order > 0) {
        return { dir, status: 'kept', version: installed.version, detail: `newer skill ${installed.version} already installed` };
      }
      if (order === 0 && sameFiles(dir, bundle)) {
        return { dir, status: 'current', version: bundle.version };
      }
    }
    for (const name of SKILL_FILES) {
      try {
        const existing = fs.lstatSync(path.join(dir, name));
        if (!existing.isFile()) {
          return { dir, status: 'skipped', detail: `${path.join(dir, name)} is not a regular file` };
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  } else {
    ensureDir(dir);
  }
  for (const name of SKILL_FILES) {
    await writeFileAtomic(path.join(dir, name), bundle.files[name]);
  }
  return { dir, status: stat ? 'updated' : 'installed', version: bundle.version };
}

// removeSkill deletes the files this package installs and the directory if
// that leaves it empty. Anything else in the directory is not ours to delete.
function removeSkill(skillsRoot) {
  const dir = path.join(skillsRoot, SKILL_NAME);
  const installed = readInstalled(dir);
  if (!installed) return { dir, status: 'absent' };
  if (!installed.version) return { dir, status: 'skipped', detail: `${dir} is not an Innstance skill` };
  for (const name of SKILL_FILES) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // Not empty: the person keeps whatever else they put there.
  }
  return { dir, status: 'removed' };
}

module.exports = {
  PIN,
  SKILL_NAME,
  SKILL_FILES,
  validatePin,
  officialBaseURL,
  compareVersions,
  sha256,
  fetchSkill,
  readInstalled,
  installSkill,
  removeSkill,
};
