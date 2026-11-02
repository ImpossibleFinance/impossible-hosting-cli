'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { main, parseArgs } = require('../lib/cli');
const { version } = require('../package.json');
const { makeContext, tempHome } = require('./helpers');

test('parseArgs reads commands and options', () => {
  const ids = (agents) => agents && agents.map((a) => a.id);
  const cases = [
    { argv: [], want: { command: 'setup', agents: null } },
    { argv: ['setup'], want: { command: 'setup' } },
    { argv: ['doctor'], want: { command: 'doctor' } },
    { argv: ['remove'], want: { command: 'remove' } },
    { argv: ['uninstall'], want: { command: 'remove' } },
    { argv: ['--agents', 'claude,cursor'], want: { command: 'setup', agents: ['claude', 'cursor'] } },
    { argv: ['--agents=all'], want: { agents: ['claude', 'codex', 'cursor', 'opencode'] } },
    { argv: ['--agents', 'Claude-Code, codex,codex'], want: { agents: ['claude', 'codex'] } },
    { argv: ['--server', 'http://127.0.0.1:1', 'doctor'], want: { command: 'doctor', server: 'http://127.0.0.1:1' } },
    { argv: ['--no-browser', '--relogin', '--skip-mcp-check', '--force'], want: { browser: false, relogin: true, skipMcpCheck: true, force: true } },
    { argv: ['doctor', '--help'], want: { command: 'help' } },
    { argv: ['-v'], want: { command: 'version' } },
  ];
  for (const c of cases) {
    const got = parseArgs(c.argv);
    for (const [key, value] of Object.entries(c.want)) {
      const actual = key === 'agents' ? ids(got.agents) : got[key];
      assert.deepEqual(actual, value, `${c.argv.join(' ')}: ${key}`);
    }
  }
});

test('parseArgs refuses what it does not understand', () => {
  const cases = [
    { argv: ['deploy'], err: /unknown command/ },
    { argv: ['doctor', 'setup'], err: /unknown command/ },
    { argv: ['--bogus'], err: /unknown option/ },
    { argv: ['--agents'], err: /needs a value/ },
    { argv: ['--agents', 'vim'], err: /unknown agent/ },
    { argv: ['--server'], err: /needs a value/ },
    { argv: ['--relogin=yes'], err: /does not take a value/ },
  ];
  for (const c of cases) assert.throws(() => parseArgs(c.argv), c.err, c.argv.join(' '));
});

test('usage errors exit 2 without touching the network', async (t) => {
  const { ctx, err } = makeContext(tempHome(t), null);
  assert.equal(await main(['--agents', 'vim'], ctx), 2);
  assert.match(err.join('\n'), /unknown agent/);
  assert.equal(await main(['--server', 'http://evil.example'], ctx), 2);
});

test('a command of the full CLI says where that CLI comes from', async (t) => {
  for (const argv of [['deploy'], ['status', '--json'], ['login']]) {
    const { ctx, err } = makeContext(tempHome(t), null);
    assert.equal(await main(argv, ctx), 2, argv.join(' '));
    assert.match(err.join('\n'), new RegExp(`unknown command "${argv[0]}"`));
    assert.match(err.join('\n'), /only signs in and connects agents.*full innstance CLI.*separate install: https:\/\/innstance\.impossibuild\.ai\/docs/s);
  }
});

test('the published entry point runs with plain node', () => {
  const bin = path.join(__dirname, '..', 'bin', 'innstance-setup.js');
  const res = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), version);
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /npx innstance doctor/);
});
