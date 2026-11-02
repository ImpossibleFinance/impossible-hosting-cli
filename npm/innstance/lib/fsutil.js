'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Every file this package writes either holds a token (agent MCP configs, the
// saved session) or sits next to one, so everything is written owner-only and
// replaced atomically: a reader sees the old file or the new one, never half
// of either, and a crash mid-write leaves the original untouched.
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

// resolveWriteTarget follows a symlink to the file it points at. Dotfiles are
// often symlinks into a managed repository; renaming over the link would
// silently replace it with a regular file and detach the person's setup.
function resolveWriteTarget(target) {
  try {
    return fs.realpathSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // A dangling link still names where the file is meant to live.
      try {
        const link = fs.readlinkSync(target);
        return path.resolve(path.dirname(target), link);
      } catch {
        return target;
      }
    }
    throw err;
  }
}

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function ensureDir(dir, mode = PRIVATE_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

// Windows refuses to rename over a file another process has open for a
// moment (an editor, an indexer, antivirus). Those holds are brief, so a few
// short retries turn a spurious failure into a success.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function writeFileAtomic(target, data, mode = PRIVATE_FILE) {
  const real = resolveWriteTarget(target);
  const dir = path.dirname(real);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(real)}.innstance-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    for (let off = 0; off < bytes.length; ) {
      off += fs.writeSync(fd, bytes, off, bytes.length - off);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // openSync's mode is filtered through the umask; chmod is not.
    fs.chmodSync(tmp, mode);
    await renameWithRetry(tmp, real);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// withFileLock serialises a read-modify-write of a config file with other
// writers that use the common "<file>.lock" directory convention (creating a
// directory is atomic on every platform). Tools that hold such a lock refresh
// it while they work, so one older than staleMs is abandoned and reclaimed.
// Writers that use no lock at all are not excluded by this; the atomic rename
// still guarantees they never read a torn file.
async function withFileLock(target, fn, { waitMs = 5000, staleMs = 10000 } = {}) {
  const real = resolveWriteTarget(target);
  ensureDir(path.dirname(real));
  const lock = real + '.lock';
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between our mkdir and stat
      }
      if (age > staleMs) {
        try {
          fs.rmdirSync(lock);
        } catch {}
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`${real} is being edited by another program (${lock} exists); close it and try again`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn(real);
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {}
  }
}

// gitWorkTree returns the directory of the git work tree that holds file,
// found by walking up from it looking for .git (a directory, or the file a
// worktree or submodule has), or null.
function gitWorkTree(file) {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// linkedTarget returns the real file when file, or a directory between it
// and home, is a symlink (a dotfiles setup), and null otherwise. Links above
// home (such as macOS's /var) are the system's, not the person's.
function linkedTarget(file, home) {
  const stop = path.resolve(home);
  for (let p = path.resolve(file); p !== stop && path.dirname(p) !== p; p = path.dirname(p)) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return resolveWriteTarget(file);
    } catch {
      // not there yet: nothing to follow
    }
  }
  return null;
}

// tokenFileRisk explains why a token written to file could leak, or returns
// null. The case it exists for is a dotfiles repository: a config kept in
// one, directly or through a symlink into it, can be committed and pushed,
// and a session token that never expires stays live in a public repository
// until someone notices. Writes are followed through links (see
// resolveWriteTarget), so the check looks at where the bytes really land.
function tokenFileRisk(file, home) {
  const repo = gitWorkTree(resolveWriteTarget(file));
  if (!repo) return null;
  const link = linkedTarget(file, home);
  return `${link ? `${file} (a link to ${link})` : file} is inside the git repository at ${repo}, where the token could be committed`;
}

function fileMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

module.exports = {
  PRIVATE_FILE,
  PRIVATE_DIR,
  resolveWriteTarget,
  readTextIfExists,
  exists,
  isDirectory,
  ensureDir,
  writeFileAtomic,
  withFileLock,
  fileMode,
  gitWorkTree,
  linkedTarget,
  tokenFileRisk,
};
