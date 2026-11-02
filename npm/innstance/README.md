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

Installed globally (`npm i -g innstance`), the command is `innstance-setup`,
not `innstance`. That name belongs to the full CLI, and a global npm install
must not put something else ahead of it on your `PATH`.

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
| `--skip-mcp-check` | Sign in and write agent configs without first checking that the MCP endpoint answers. |
| `--force` | Replace an `innstance` MCP entry or skill directory that this tool did not create, and write the token into a config that sits in a git repository. |

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
The session is saved in `~/.impossible/npx-session.json`, one per control
plane.

Each edit changes only the `innstance` entry. Other servers, other settings,
comments, formatting, line endings and key order stay exactly as they were.
An `innstance` entry that already points at this control plane is updated in
place: only its `url` and `Authorization` header change, so anything you set
on it yourself (turning it off, tool approvals, timeouts) is kept. An
`innstance` entry that points somewhere else, or runs a local command, is left
alone unless you pass `--force`. If a file can't be read, or defines
`innstance` in a form the tool can't rewrite safely, the tool leaves that file
untouched, says so, and still sets up the other agents.

A config file that is a symlink is edited through the link, and setup says
where the token was written. The link itself is not replaced. A config whose
real file is inside a git repository, such as a dotfiles repository, is not
written at all unless you pass `--force`, because a token committed there
would stay live. The same goes for `~/.impossible` if your home directory is a
git repository.

Run it as yourself, not with `sudo`: files it writes are owner-only, and as
root they would end up owned by root, where your agents cannot read them.
`setup` and `remove` refuse to run as root in another user's home.

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
  previous session on the server. So after a new sign-in, `setup` also gives
  the new token to every agent config that already points at this control
  plane, not just the agents you named, even when it writes no new config.
  No agent is left holding a dead token. When the saved session is reused,
  agents you did not name are left alone.
* **A limit per account.** Each signed-in machine holds a session that does
  not expire, and the Go CLI's sessions count too. An account can hold 8. A
  fresh home directory (a new laptop, a container, a Codespace) signs in as a
  new machine, so revoke the ones you no longer use from your dashboard. At
  the limit, the approval page shows an error and `npx innstance` waits until
  the sign-in code expires.

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

A copy this tool installs carries a small `.npx-innstance.json` file that
records the hash of each file it wrote. `remove` uses it to delete only what
this tool installed and nobody changed since.

To move the pin to a newer reviewed commit:

```sh
node scripts/pin-skill.js <40-character commit>   # rewrites lib/skill-pin.json
node scripts/pin-skill.js --check                 # verifies the pin against GitHub
```

Both check that the commit is on the skill repository's `main`.

## doctor

`npx innstance doctor` changes nothing. It checks, in order:

* the Node.js version;
* that the control plane answers `/health`;
* that the saved session is still valid;
* that the MCP endpoint answers an `initialize` request with that session (or,
  with no saved session, with a connected agent's token);
* that each agent's `innstance` entry points at the right endpoint, holds a
  token the server still accepts, can reach a working MCP endpoint, and has
  the skill installed. A config that other users can read, or that sits in a
  git repository, is flagged.

Each problem is reported with the command that fixes it. Warnings, such as an
agent not connected yet, don't fail the check. Failures make doctor exit with
status 1.

## remove

`npx innstance remove`:

* deletes each agent's `innstance` entry that points at this control plane's
  MCP endpoint, whoever wrote it, and leaves entries that point anywhere else;
* deletes the skill copies this tool installed, unless a file in them has
  changed since; copies written by the Go CLI or anyone else are left alone;
* ends this control plane's session on the server, and forgets it locally
  once the server has confirmed it ended. If the server can't end it, the
  token is kept, so you can run `remove` again or revoke it from your
  dashboard.

With `--agents`, it disconnects only those agents. It keeps the session, and
it keeps any skill copy that another agent still uses. Sessions for other
control planes are kept; `remove` says how to end them.

## When MCP isn't available yet

If the control plane has no MCP endpoint yet (it answers 404), `setup`
installs the skill but doesn't sign you in or write any MCP config. An agent
pointed at a missing server would show a failure on every start, and a session
nothing uses is one more credential to leak. Run `npx innstance` again once
the endpoint is live. `--skip-mcp-check` signs in and writes the configs
anyway.

If the endpoint accepts the sign-in but refuses to let it use MCP (HTTP 403),
signing in again would not help. Run the newest version,
`npx innstance@latest`.

## Network

The tool connects directly to the control plane and to
`raw.githubusercontent.com` (for the skill). It doesn't read `HTTPS_PROXY`.

## Verifying the package

Releases are published from the public
[impossible-hosting-cli](https://github.com/ImpossibleFinance/impossible-hosting-cli)
repository, through GitHub Actions and npm trusted publishing, with
[provenance](https://docs.npmjs.com/generating-provenance-statements).

The npm page for each version has a Provenance section that links to the
commit and the workflow run that built it. From a terminal, this shows the
attestations for a version:

```sh
npm view innstance@0.1.0 dist.attestations
```

`npm audit signatures` checks the dependencies installed in a project, not
what `npx` runs from its cache. To verify the registry signature and the
provenance of a version, install it into an empty project and audit that:

```sh
cd "$(mktemp -d)" && npm init -y >/dev/null
npm install --ignore-scripts innstance@0.1.0
npm audit signatures
```

## Development

```sh
npm test          # node:test, against a fake control plane; no network needed
```
