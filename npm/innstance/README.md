# npx innstance

Sign in to [Innstance](https://innstance.impossibuild.ai) and connect your
coding agent to it, with nothing native to install:

```sh
npx innstance
```

That one command:

1. signs you in with a short code you approve in your browser;
2. adds the Innstance MCP server (`https://innstance.impossibuild.ai/mcp`) to
   every coding agent it finds: Claude Code, Codex, Cursor and OpenCode;
3. installs the Innstance skill, the guide that teaches agents how to publish
   and run things on Innstance;
4. tells you what to do next.

Then ask your agent something like *"Publish this folder with Innstance and
give me the link."*

The package is plain JavaScript that uses only Node.js built-ins. It has no
dependencies, no install scripts and no binary inside. It needs Node.js 18 or
newer. It handles sign-in and agent setup only. The full `innstance` command-line
tool (deploys, logs, domains and the rest) is a separate, signed install
described in the [docs](https://innstance.impossibuild.ai/docs).

## Commands

```sh
npx innstance                  # same as: npx innstance setup
npx innstance doctor           # check every step from this machine to the MCP endpoint
npx innstance remove           # disconnect agents and sign this machine out
```

| Option | Meaning |
|---|---|
| `--agents <list>` | `claude`, `codex`, `cursor`, `opencode`, or `all`, comma-separated. By default `setup` connects the agents installed on this machine, and `remove` disconnects all of them. |
| `--server <origin>` | The control plane to use. The default is `https://innstance.impossibuild.ai`. `IMPOSSIBLE_API_URL` does the same, as it does for the Go CLI. Only `https` origins and plain-`http` loopback are accepted. |
| `--no-browser` | Print the sign-in link without opening a browser. |
| `--relogin` | Sign in again even when this machine already has a working session. |
| `--skip-mcp-check` | Write agent configs without first checking that the MCP endpoint answers. |
| `--force` | Replace an existing `innstance` skill directory that this tool did not create. |

`setup` is safe to run again. The second run reuses this machine's session
without opening a browser, connects any agent you name, and updates the skill.

## What it changes on your machine

| Agent | MCP server entry | Skill |
|---|---|---|
| Claude Code | `~/.claude.json` → `mcpServers.innstance` (`type: http`) | `~/.claude/skills/innstance/` |
| Codex | `~/.codex/config.toml` → `[mcp_servers.innstance]` | `~/.agents/skills/innstance/` |
| Cursor | `~/.cursor/mcp.json` → `mcpServers.innstance` | `~/.agents/skills/innstance/` |
| OpenCode | `~/.config/opencode/opencode.json` → `mcp.innstance` (`type: remote`) | `~/.agents/skills/innstance/` |

`CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` move these locations
the same way they do for the agents themselves. Codex, Cursor and OpenCode all
read the shared `~/.agents/skills` directory, so one copy serves all three.
The session is saved in `~/.impossible/npx-session.json`.

Each edit changes only the `innstance` entry. Other servers, other settings,
comments, formatting and key order stay exactly as they were. If a file can't
be read, or defines `innstance` in a form the tool can't rewrite safely,
the tool leaves that file untouched, says so, and still sets up the other
agents. A config file that is a symlink, such as one kept in a dotfiles
repository, is edited through the link. The link itself is not replaced.

## Your token

* **One session per machine, separate from the Go CLI.** Agents sign in with
  their own session, named after the machine, for example
  `cli-npx-mac-studio-7f3a`. It appears in the token list on your dashboard,
  where you can revoke it. It never shares a token with an `innstance login`
  on the same machine. The server keeps one session per device name, so a
  shared token would break whenever either of them signed in again.
* **Written owner-only and never printed.** Every file that holds the token is
  written atomically with mode `0600`. The token is not shown on screen, in
  logs or in error messages.
* **Sent only to the control plane that issued it.** A saved session is never
  sent to a different `--server`. Requests never follow redirects, and the
  approval link is opened only if it is `<control plane>/auth/device`.
* **Kept current everywhere.** Signing in again replaces this machine's
  previous session on the server, so `setup` also updates every agent config
  that already points at this control plane, not just the agents you named.
  No agent is left holding a dead token.

The token is written into each config as an `Authorization` header. An
environment-variable reference would keep it out of the file, but it only works
for agents started from a shell that exports the variable, and desktop editors
are usually not started that way.

## The skill

The skill comes from the public
[impossible-hosting-skill](https://github.com/ImpossibleFinance/impossible-hosting-skill)
repository, pinned to one reviewed commit in
[`lib/skill-pin.json`](lib/skill-pin.json). This is normally the same commit
that the Go CLI's `innstance skill sync` uses. Every file must match the SHA-256 recorded
in that pin, or nothing is installed. A newer skill version that is already
installed, for example by the Go CLI, is kept. A directory named `innstance`
that is not an Innstance skill is left alone unless you pass `--force`.

To move the pin to a newer reviewed commit:

```sh
node scripts/pin-skill.js <40-character commit>   # rewrites lib/skill-pin.json
node scripts/pin-skill.js --check                 # verifies the pin against GitHub
```

## doctor

`npx innstance doctor` changes nothing. It checks, in order:

* the Node.js version;
* that the control plane answers `/health`;
* that the saved session is still valid;
* that the MCP endpoint answers an `initialize` request with that session;
* that each agent's `innstance` entry points at the right endpoint, holds the
  current token and has the skill installed.

Each problem is reported with the command that fixes it. Warnings, such as an
agent not connected yet, don't fail the check. Failures make doctor exit with
status 1.

## remove

`npx innstance remove`:

* deletes the `innstance` entries this tool wrote, but only those that point
  at this control plane;
* deletes the skill files it installed;
* ends the session on the server and forgets it locally.

With `--agents`, it disconnects only those agents. It keeps the session, and
it keeps any skill copy that another agent still uses.

## When MCP isn't available yet

If the control plane has no MCP endpoint yet (it answers 404), `setup` signs
you in and installs the skill, but it doesn't write any MCP config. An agent
pointed at a missing server would show a failure on every start. Run
`npx innstance` again once the endpoint is live. `--skip-mcp-check` writes the
configs anyway.

## Network

The tool connects directly to the control plane and to
`raw.githubusercontent.com` (for the skill). It doesn't read `HTTPS_PROXY`.

## Verifying the package

Releases are published from the public
[impossible-hosting-cli](https://github.com/ImpossibleFinance/impossible-hosting-cli)
repository, through GitHub Actions and npm trusted publishing, with
[provenance](https://docs.npmjs.com/generating-provenance-statements). To check
an installed copy:

```sh
npm audit signatures
```

The npm page for each version links to the commit and workflow run that built
it. The publish workflow runs only for a `npm-v<version>` tag on a commit that
is already on `main`.

## Development

```sh
npm test          # node:test, against a fake control plane; no network needed
```
