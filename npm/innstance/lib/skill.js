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

// MARKER records that this package installed a skill directory, and the
// SHA-256 of each file it wrote. remove deletes a directory's files only when
// the marker is there and every file still matches it, so a copy the Go
// CLI's `skill sync` wrote, a newer copy setup chose to keep, a checkout of
// the skill repository, or a file the person edited is never deleted.
const MARKER = '.npx-innstance.json';

// A first install is written into a temporary sibling directory and renamed
// into place, so an interrupted run never leaves a half-written directory
// that the next run would have to refuse as "not an Innstance skill".
const STAGING_PREFIX = `.${SKILL_NAME}.npx-staging-`;

// A renamed or transferred skill repository answers 301 on the old path. The
// bytes are pinned, so following a redirect costs nothing in safety, but it
// is allowed only on the same origin (raw.githubusercontent.com in use).
const MAX_SKILL_REDIRECTS = 2;

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

// downloadSkillFile GETs one skill file, following at most
// MAX_SKILL_REDIRECTS redirects that stay on the same origin. No credential
// is ever sent with these requests.
async function downloadSkillFile(url) {
  const origin = new URL(url).origin;
  for (let hop = 0; ; hop++) {
    const res = await request('GET', url, { timeoutMs: 20000, maxBytes: MAX_SKILL_FILE_BYTES });
    const location = res.headers.location;
    if (![301, 302, 303, 307, 308].includes(res.status) || !location || hop >= MAX_SKILL_REDIRECTS) return res;
    const next = new URL(location, url);
    if (next.origin !== origin) {
      throw new Error(`${url} redirected to another host (${next.origin}); nothing was installed`);
    }
    url = next.toString();
  }
}

// fetchSkill downloads the pinned files and verifies every byte before
// anything is written. baseURL exists for the tests; whatever serves the
// files, they must match the pinned hashes.
async function fetchSkill({ pin = PIN, baseURL } = {}) {
  validatePin(pin);
  const base = (baseURL || officialBaseURL(pin)).replace(/\/+$/, '');
  const files = {};
  for (const name of SKILL_FILES) {
    const res = await downloadSkillFile(`${base}/${name}`);
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
  return { version: pin.version, repository: pin.repository, commit: pin.commit, files };
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

function markerFor(bundle) {
  const files = {};
  for (const name of SKILL_FILES) files[name] = sha256(bundle.files[name]);
  const body = { installed_by: 'npx innstance', repository: bundle.repository || '', commit: bundle.commit || '', version: bundle.version, files };
  return JSON.stringify(body, null, 2) + '\n';
}

// readMarker returns the file hashes this package recorded for dir, or null
// when it did not install it (no marker, or one that is not a regular file).
function readMarker(dir) {
  const file = path.join(dir, MARKER);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const files = parsed && parsed.files;
    if (!files || typeof files !== 'object') return null;
    return SKILL_FILES.every((name) => typeof files[name] === 'string') ? files : null;
  } catch {
    return null;
  }
}

// sweepStaging deletes staging directories an interrupted first install left
// behind. They are named by this package and hold nothing anyone else wrote.
function sweepStaging(skillsRoot) {
  let names;
  try {
    names = fs.readdirSync(skillsRoot);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(STAGING_PREFIX)) fs.rmSync(path.join(skillsRoot, name), { recursive: true, force: true });
  }
}

// installSkill writes the bundle to <skillsRoot>/innstance and reports what it
// did. A directory of that name that is not an Innstance skill (no manifest
// with a version) belongs to someone else and is left alone unless force is
// set. A newer Innstance skill — one the Go CLI's `skill sync` or a later
// release put there — is kept rather than rolled back.
//
// A first install is staged and renamed into place. An update writes each
// file atomically with manifest.json last, so a failure part-way through
// leaves the old version recorded and the next run repairs the rest.
async function installSkill(skillsRoot, bundle, { force = false } = {}) {
  const dir = path.join(skillsRoot, SKILL_NAME);
  sweepStaging(skillsRoot);
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stat && !stat.isDirectory()) {
    return { dir, status: 'skipped', detail: `${dir} exists and is not a directory` };
  }
  if (!stat) {
    ensureDir(skillsRoot);
    const staging = path.join(skillsRoot, `${STAGING_PREFIX}${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.mkdirSync(staging, { mode: 0o700 });
      for (const name of SKILL_FILES) await writeFileAtomic(path.join(staging, name), bundle.files[name]);
      await writeFileAtomic(path.join(staging, MARKER), markerFor(bundle));
      fs.renameSync(staging, dir);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    return { dir, status: 'installed', version: bundle.version };
  }
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
  for (const name of SKILL_FILES.concat(MARKER)) {
    try {
      const existing = fs.lstatSync(path.join(dir, name));
      if (!existing.isFile()) {
        return { dir, status: 'skipped', detail: `${path.join(dir, name)} is not a regular file` };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  for (const name of SKILL_FILES) {
    await writeFileAtomic(path.join(dir, name), bundle.files[name]);
  }
  await writeFileAtomic(path.join(dir, MARKER), markerFor(bundle));
  return { dir, status: 'updated', version: bundle.version };
}

// removeSkill deletes what this package installed: the skill files and its
// marker, only when the marker is there and every file is still the one it
// wrote, and the directory if that leaves it empty. Anything else in the
// directory is not ours to delete.
function removeSkill(skillsRoot) {
  const dir = path.join(skillsRoot, SKILL_NAME);
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { dir, status: 'absent' };
    throw err;
  }
  if (stat.isSymbolicLink()) return { dir, status: 'skipped', detail: `${dir} is a symbolic link` };
  if (!stat.isDirectory()) return { dir, status: 'skipped', detail: `${dir} is not a directory` };
  const recorded = readMarker(dir);
  if (!recorded) return { dir, status: 'skipped', detail: 'it was not installed by npx innstance' };
  for (const name of SKILL_FILES) {
    const file = path.join(dir, name);
    try {
      if (!fs.lstatSync(file).isFile() || sha256(fs.readFileSync(file)) !== recorded[name]) {
        return { dir, status: 'skipped', detail: `${name} changed after npx innstance installed it` };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  for (const name of SKILL_FILES.concat(MARKER)) {
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
  MARKER,
  validatePin,
  downloadSkillFile,
  officialBaseURL,
  compareVersions,
  sha256,
  fetchSkill,
  readInstalled,
  installSkill,
  removeSkill,
};
