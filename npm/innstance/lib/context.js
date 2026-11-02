'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The context is everything the commands take from the machine: where home
// is, what the environment says, how to print, sleep, tell the time and open
// a browser. Commands receive it instead of reaching for process and os, so
// the tests can run every command against a temporary home and a fake server
// without touching the real machine.
function defaultContext() {
  return {
    home: os.homedir(),
    platform: process.platform,
    env: process.env,
    hostname: os.hostname(),
    nodeVersion: process.versions.node,
    out: (line = '') => process.stdout.write(line + '\n'),
    err: (line = '') => process.stderr.write(line + '\n'),
    openBrowser: (url) => openBrowser(url, process.platform, process.env),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    which: (name) => findOnPath(name, process.env, process.platform),
    // Tests serve their own skill files with a pin to match; in normal use
    // both are undefined and the published, pinned skill is installed.
    skillBaseURL: undefined,
    skillPin: undefined,
  };
}

// openBrowser opens the approval page. The URL has already been checked to be
// <control plane>/auth/device?code=..., and it is passed as one argument with
// no shell in between. On Windows that rules out `cmd /c start`, where "&" in
// a URL would start a second command; rundll32's URL handler takes the URL
// as data, the same choice the Go CLI made. Failure is quiet: the link is
// printed either way, and a headless machine simply has no browser.
function openBrowser(rawURL, platform, env) {
  let u;
  try {
    u = new URL(rawURL);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  let command;
  let args;
  switch (platform) {
    case 'darwin':
      command = 'open';
      args = [u.toString()];
      break;
    case 'win32':
      command = 'rundll32';
      args = ['url.dll,FileProtocolHandler', u.toString()];
      break;
    default:
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
      command = 'xdg-open';
      args = [u.toString()];
  }
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name, env, platform) {
  const dirs = String(env.PATH || env.Path || '')
    .split(path.delimiter)
    .filter(Boolean);
  const exts = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

// tildify shortens a path under home for display.
function tildify(ctx, p) {
  const rel = path.relative(ctx.home, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return path.join('~', rel);
  return p;
}

module.exports = { defaultContext, openBrowser, findOnPath, tildify };
