#!/usr/bin/env node
'use strict';

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  process.stderr.write(`npx innstance needs Node.js 18 or newer; this is ${process.versions.node}.\n`);
  process.exit(1);
}

require('../lib/cli')
  .main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`innstance: ${(err && err.message) || err}\n`);
    process.exitCode = 1;
  });
