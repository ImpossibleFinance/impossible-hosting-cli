'use strict';

const { parseAgentList, AGENT_IDS } = require('./agents');
const { defaultContext } = require('./context');
const { doctor } = require('./doctor');
const { DEFAULT_ORIGIN, resolveOrigin } = require('./origin');
const { remove } = require('./remove');
const { setup } = require('./setup');
const { version } = require('../package.json');

const HELP = `npx innstance: sign in to Innstance and connect your coding agent.

Usage
  npx innstance [setup] [options]    sign in, connect your agents, install the skill
  npx innstance doctor [--server]    check every step from this machine to the MCP endpoint
  npx innstance remove [options]     disconnect agents and sign this machine out

Options
  --agents <list>    ${AGENT_IDS.join(', ')} or all (default: the ones installed here)
  --server <origin>  control plane (default ${DEFAULT_ORIGIN}, or IMPOSSIBLE_API_URL)
  --no-browser       print the sign-in link without opening a browser
  --relogin          sign in again even when this machine has a working session
  --skip-mcp-check   write agent configs without first checking the MCP endpoint
  --force            replace an "innstance" MCP entry or skill directory this tool
                     did not create, and write the token into a config that sits
                     in a git repository
  -h, --help         show this help
  -v, --version      print the version

This package only signs in and connects agents; it contains no native binary.
Installed globally (npm i -g innstance) its command is innstance-setup; the
name innstance belongs to the full innstance CLI (deploy, logs, domains, ...),
which is a separate, signed install: ${DEFAULT_ORIGIN}/docs`;

const COMMANDS = new Set(['setup', 'doctor', 'remove', 'uninstall', 'help', 'version']);

class UsageError extends Error {
  constructor(message, { unknownCommand = false } = {}) {
    super(message);
    this.unknownCommand = unknownCommand;
  }
}

function parseArgs(argv) {
  const opts = { command: 'setup', agents: null, server: '', browser: true, relogin: false, skipMcpCheck: false, force: false };
  let commandSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : null;
    const value = () => {
      if (inline !== null) return inline;
      const next = argv[++i];
      if (next === undefined || next.startsWith('-')) throw new UsageError(`${flag} needs a value`);
      return next;
    };
    const noValue = () => {
      if (inline !== null) throw new UsageError(`${flag} does not take a value`);
    };
    switch (flag) {
      case '-h':
      case '--help':
        opts.command = 'help';
        return opts;
      case '-v':
      case '--version':
        opts.command = 'version';
        return opts;
      case '--agents':
      case '--agent':
        try {
          opts.agents = parseAgentList(value());
        } catch (err) {
          throw new UsageError(err.message);
        }
        break;
      case '--server':
        opts.server = value();
        break;
      case '--no-browser':
        noValue();
        opts.browser = false;
        break;
      case '--relogin':
        noValue();
        opts.relogin = true;
        break;
      case '--skip-mcp-check':
        noValue();
        opts.skipMcpCheck = true;
        break;
      case '--force':
        noValue();
        opts.force = true;
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
        if (commandSeen || !COMMANDS.has(arg)) throw new UsageError(`unknown command ${JSON.stringify(arg)}`, { unknownCommand: !COMMANDS.has(arg) });
        commandSeen = true;
        opts.command = arg === 'uninstall' ? 'remove' : arg;
    }
  }
  return opts;
}

async function main(argv, ctx = defaultContext()) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    ctx.err(`innstance: ${err.message}`);
    if (err.unknownCommand) {
      // Most likely a command of the full CLI, run through this package by
      // mistake (or by an agent following the skill).
      ctx.err('This is npx innstance, which only signs in and connects agents. The full innstance CLI');
      ctx.err(`(deploy, logs, domains, ...) is a separate install: ${DEFAULT_ORIGIN}/docs`);
    }
    ctx.err('Run npx innstance --help for usage.');
    return 2;
  }
  if (opts.command === 'help') {
    ctx.out(HELP);
    return 0;
  }
  if (opts.command === 'version') {
    ctx.out(version);
    return 0;
  }
  try {
    opts.origin = resolveOrigin(opts.server, ctx.env);
  } catch (err) {
    ctx.err(`innstance: ${err.message}`);
    return 2;
  }
  if (!opts.browser) ctx = { ...ctx, openBrowser: null };
  try {
    switch (opts.command) {
      case 'doctor':
        return await doctor(ctx, opts);
      case 'remove':
        return await remove(ctx, opts);
      default:
        return await setup(ctx, opts);
    }
  } catch (err) {
    ctx.err(`innstance: ${err.message}`);
    return 1;
  }
}

module.exports = { main, parseArgs, HELP, UsageError };
