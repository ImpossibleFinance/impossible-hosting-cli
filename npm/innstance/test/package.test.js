'use strict';

// The promise this package makes is "nothing native to install": pure
// JavaScript, Node built-ins only, no dependencies and no install scripts.
// These checks keep that promise from eroding one convenient import at a time.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');

function shippedFiles() {
  const out = [];
  for (const dir of ['bin', 'lib']) {
    for (const name of fs.readdirSync(path.join(root, dir))) out.push(path.join(dir, name));
  }
  return out;
}

test('the package has no dependencies and runs no install scripts', () => {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies', 'devDependencies']) {
    assert.equal(pkg[field], undefined, field);
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
    assert.equal(pkg.scripts[hook], undefined, hook);
  }
  assert.equal(pkg.name, 'innstance');
  assert.deepEqual(pkg.bin, { innstance: 'bin/innstance.js' });
  assert.equal(pkg.engines.node, '>=18');
  assert.deepEqual(pkg.files, ['bin/', 'lib/', 'README.md']);
  // npm provenance ties the published tarball to this repository and path.
  assert.equal(pkg.repository.url, 'git+https://github.com/ImpossibleFinance/impossible-hosting-cli.git');
  assert.equal(pkg.repository.directory, 'npm/innstance');
});

test('shipped code is JavaScript that requires only Node built-ins and itself', () => {
  for (const file of shippedFiles()) {
    assert.match(file, /\.(js|json)$/, `${file} is not JavaScript or JSON`);
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'), `${file} requires ${spec}`);
    }
    assert.doesNotMatch(source, /\bimport\s*\(|\bprocess\.binding\b|\.node['"]/, `${file} loads something dynamically`);
  }
});

test('the entry point is executable through npx', () => {
  const bin = fs.readFileSync(path.join(root, pkg.bin.innstance), 'utf8');
  assert.ok(bin.startsWith('#!/usr/bin/env node\n'));
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(path.join(root, pkg.bin.innstance)).mode & 0o111, 'bin/innstance.js must be executable');
  }
});
