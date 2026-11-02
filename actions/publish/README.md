# Innstance publish action

A GitHub Action that puts work live on Innstance from a workflow, and
optionally on your own domain. It installs the CLI with the same signature
and checksum checks as the installer, then runs one of three modes:

- `publish`: static files, no machine. One self-contained HTML page, or PDFs
  and images.
- `deploy`: an app. The action pushes a directory to the app's runner VM,
  starts it, and waits until it answers.
- `install`: only installs the verified CLI, so later steps can run
  `innstance` themselves.

For getting work out of a sandbox (InstaBox, E2B, Daytona, Fly Sprites,
Vercel Sandbox) first, see [From any sandbox to your domain](../../docs/sandbox-to-domain.md).

## Quick start

1. Create a token for the workflow and save it as a repository secret named
   `INNSTANCE_TOKEN`:

   ```sh
   innstance tokens create --name github-actions --expires-in 90
   ```

2. Add a workflow. Replace `<commit-sha>` with a full 40-character commit of
   this repository (see [Pin the action](#pin-the-action)).

   ```yaml
   name: publish
   on:
     push:
       branches: [main]
   permissions:
     contents: read
   # One run at a time per site; see "Run one deploy at a time".
   concurrency:
     group: innstance-q3-report
     cancel-in-progress: false
   jobs:
     publish:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
           with:
             persist-credentials: false
         - uses: ImpossibleFinance/impossible-hosting-cli/actions/publish@<commit-sha>
           id: innstance
           with:
             token: ${{ secrets.INNSTANCE_TOKEN }}
             name: q3-report
             path: report.html
             domain: report.example.com
         - run: echo "Live at $URL"
           env:
             URL: ${{ steps.innstance.outputs.url }}
   ```

The site answers at the `url` output straight away. The custom domain
follows the DNS steps below.

## Publish static files

`path` takes files, globs, or a folder, one per line. Files appear in the
order you list them. A glob expands in name order.

```yaml
- uses: ImpossibleFinance/impossible-hosting-cli/actions/publish@<commit-sha>
  with:
    token: ${{ secrets.INNSTANCE_TOKEN }}
    name: menu
    path: |
      cover.pdf
      courses/*.pdf
```

Static publishing accepts what `innstance publish` accepts:

- exactly one HTML file, served as the page;
- several PDFs, combined into one document;
- PDFs and images, shown as one scrolling page;
- a single PDF or image, served directly.

Running the workflow again with the same `name` replaces the whole site.

A folder is passed to the CLI unchanged, so this action publishes folders
as soon as the CLI does. The current CLI refuses a folder before anything
is uploaded, your site is not changed, and the step fails with a pointer to
the next section.

## A static site of many files

Until the CLI publishes folders, a build output such as `dist/` (HTML plus
CSS, JavaScript and assets) is served from an app's runner VM:

```yaml
- uses: ImpossibleFinance/impossible-hosting-cli/actions/publish@<commit-sha>
  with:
    token: ${{ secrets.INNSTANCE_TOKEN }}
    mode: deploy
    name: my-site
    path: dist
    port: 8080
    packages: python3
    start-command: exec python3 -m http.server 8080 --bind 0.0.0.0
```

The runner VM has no web server of its own, so `packages` installs Python
and its built-in file server serves `dist`. This is an app, not a static
site: an always-on VM that counts against your plan's apps and memory like
any other, and on a free account it is a 24-hour trial (the step repeats
the platform's notice). Python's file server has no SPA fallback; a
single-page app that routes on the client needs a server that sends
`index.html` for unknown paths.

## Deploy an app

```yaml
name: deploy
on:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: innstance-my-api
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: ImpossibleFinance/impossible-hosting-cli/actions/publish@<commit-sha>
        with:
          token: ${{ secrets.INNSTANCE_TOKEN }}
          mode: deploy
          name: my-api
          path: .
          port: 3000
          packages: nodejs npm
          start-command: npm ci --omit=dev && exec node server.js
          health-path: /healthz
          domain: api.example.com
```

The action runs these steps, in this order:

1. If the working directory has no `impossible.toml`, it writes one that
   names only the app, its port and its volume. An app that already exists
   keeps its size and its volume, and keeps its port unless `port` sets
   one; an existing app with no volume gets the 1 GB `/data` volume, and the
   action says so. A new app gets the platform's defaults, on port 8080 unless `port`
   sets one, with the 1 GB `/data` volume every deploy adds to an app that
   has none. With an `impossible.toml`, every setting in it applies to the
   app (size, port, autostop, environment, volumes), and `name` and `port`
   override it.
2. `innstance deploy`, which creates the app or reuses its runner VM. On an
   app that exists, deploy restarts the VM, which ends every process on it,
   including one you started by hand. The app is down from here until step
   7 passes.
3. `innstance machines install` for `packages`.
4. If the VM was not restarted, it stops the process that an earlier run of
   this action started. It finds that process by a marker in its
   environment, not by a pid file.
5. `innstance machines push` of `path` into `remote-dir` (default `/app`).
   Push skips `.git`, `node_modules`, `.env*`, `impossible.toml` and anything
   your `.gitignore`, `.dockerignore` or `.impignore` excludes. List the
   files your app writes at runtime in `.ifhost-state-paths` so a push keeps
   them.
6. It runs `start-command` with `sh` in `remote-dir`, detached, logging to
   `/tmp/innstance-action.log` on the VM.
7. It waits up to `wait-seconds` for `health-path` to answer 2xx or 3xx. If
   it never does, the step fails and prints the command that shows the app
   log. With `show-app-log: true` it prints the end of the log itself; see
   [The app log](#the-app-log) before you turn that on.
8. It checks that the process it started in step 6 is still running. An
   answer in step 7 only shows that something listens on the port, and
   that could be another server while yours exited with "address in use".

The app must listen on `0.0.0.0` (or `::`), not `127.0.0.1`, on the port
the app is configured for. `start-command` must keep the server in the
foreground: a command that daemonizes (`nginx` with its default
`daemon on`, `pm2 start`) leaves nothing for step 8 to find, and the step
fails. Use `nginx -g 'daemon off;'`, `pm2-runtime`, or `exec node server.js`.
Without `start-command`, the files are pushed and nothing is started.

### Run one deploy at a time

Give every workflow that deploys an app a `concurrency` group named after
the app, with `cancel-in-progress: false`, as in the example above. Each
deploy restarts the VM, so a second run that starts while the first is
still installing, pushing or starting restarts the VM under it: the first
run's install is killed, its push fails part-way, or its process is lost
while the step still ends green. `cancel-in-progress: false` queues the
second run instead of cancelling the first in the middle of a push.

### What deploy mode does not do

- **Nothing restarts the app.** The process runs until the VM restarts:
  the next deploy, a change to the app's secrets or environment that
  restarts it, the platform moving or replacing the machine, or the VM
  running out of memory. After that the app stays down until this workflow
  runs again; re-run it, or add a `schedule` trigger. The CLI's own
  `innstance deploy --help` says the same.
- **It does not size the VM.** Set memory in a committed `impossible.toml`
  (`[resources] memory_mb = 1024`). Node and Python apps often need
  512 MB to 1 GB, and `npm ci` inside `start-command` uses memory before
  the server starts; at 256 MB the VM can run out of memory.
- **It installs `packages` on every run**, after each restart.

### Deploying what a sandbox or an agent produced

An `impossible.toml` in the working directory is applied as it is: its
`[resources]`, `[env]`, `[volumes]`, region, and `[secrets]` references.
A reference such as `@env:IMPOSSIBLE_API_TOKEN` would copy the account
token into the app, where the app's code can read it. So keep
`working-directory` on your own checkout, never on files an agent or a
sandbox wrote, and point `path` at their output. Push never uploads an
`impossible.toml`, so one inside `path` has no effect.

## Custom domains

Set `domain` to attach a hostname to the site or app. Your plan must
include custom domains.

- **First run:** Innstance needs proof that you control the domain. The
  step succeeds with `domain-status: pending_verification`. The DNS records
  to create appear in the job summary and as a warning.
- **After the records resolve:** run the workflow again. The domain is
  attached, and `domain-status` becomes `active`, or `pending_certificate`
  for the minutes until its certificate is issued.
- **Later runs:** the action only checks a domain that is already attached.
  The step fails only when the check gives no answer at all; a domain
  whose certificate is still pending, or whose `/` does not answer 200,
  is reported in `domain-status` instead.

Diagnose a domain from your machine with
`innstance sites domains check <site> <hostname>` or
`innstance machines domains check <hostname> --app <app>`.

## Use the CLI in your own steps

```yaml
- uses: ImpossibleFinance/impossible-hosting-cli/actions/publish@<commit-sha>
  with:
    mode: install
- run: innstance sites list
  env:
    IMPOSSIBLE_API_TOKEN: ${{ secrets.INNSTANCE_TOKEN }}
```

`innstance` and `ifhost` are on `PATH` for every later step of the job.
Automatic updates are off for the rest of the job (`IFHOST_AUTO_UPDATE=0`),
so every step runs the build that was verified.

## Inputs

| Input | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `mode` | `publish` | all | `publish`, `deploy` or `install`. |
| `token` | | publish, deploy | Innstance API token. Pass it from a secret. |
| `name` | | publish, deploy | Site or app name. The public address is built from it. |
| `path` | | publish, deploy | publish: files, globs or a folder, one per line. deploy: the directory to push (default: the working directory). |
| `domain` | | publish, deploy | Custom hostname to attach. |
| `working-directory` | `.` | publish, deploy | Directory that `path` and `impossible.toml` are relative to. |
| `start-command` | | deploy | Command that starts the app, run with `sh` in `remote-dir`. |
| `remote-dir` | `/app` | deploy | Absolute directory on the VM. |
| `port` | | deploy | Port the app listens on. |
| `packages` | | deploy | Debian packages to install before starting. |
| `health-path` | `/` | deploy | Path that must answer 2xx or 3xx. |
| `wait-seconds` | `120` | deploy | How long to wait for `health-path`; `0` skips the check. |
| `show-app-log` | `false` | deploy | Print the end of the app log when `health-path` never answers. |
| `api-url` | | all | Control-plane origin for staging or self-hosted installs. |
| `cli-build-id` | | all | Refuse any CLI release except this build ID. |

## Outputs

| Output | Meaning |
| --- | --- |
| `url` | Address the site or app answers at. |
| `domain-url` | `https://` address of `domain`, when one was given. |
| `domain-status` | `active`, `pending_certificate` or `pending_verification`. |
| `cli-build-id` | Build ID of the verified CLI the job used. |

## Security

### Pin the action

Reference the action by a full commit SHA, never by a branch. The commit
also pins the release key in [`release-signers`](../../release-signers)
that the CLI is verified against, so pinning the commit pins the trust
anchor too.

### What is verified

The action does not pipe anything into a shell. It runs these checks before
it runs the CLI:

1. It fetches `/dl/release.txt` and its SSHSIG.
2. It verifies the signature against the pinned key.
3. It requires each field it uses (build ID, source repository and commit,
   this runner's archive digest) exactly once, in its expected format.
4. It refuses a release older than the checkpoint in `channel-state.json`.
5. It checks the downloaded archive against the SHA-256 in that record.
6. It checks that the archive holds exactly one regular file.

A compromised release origin cannot swap the key along with the binary.
Nor can it serve a signed release older than the checkpoint in
[`channel-state.json`](../../channel-state.json) at the commit you pinned.
It could still serve an older release made after that checkpoint. Set
`cli-build-id` if a workflow must run one exact build.

### The token

- The token goes only to the publish or deploy step. The install step and
  later steps do not get it.
- Pass the token from a secret, as `${{ secrets.INNSTANCE_TOKEN }}`. GitHub
  prints a step's inputs in the job log before the step runs, and masks
  only values it already knows are secret. A token made in an earlier step
  must be masked in that step, with `echo "::add-mask::$TOKEN"`, before it
  is passed here; otherwise it appears in the log in clear text, and the
  log of a public repository is public.
- Use a dedicated token with an expiry. Revoke it with
  `innstance tokens revoke <id>`.
- GitHub gives no secrets to workflows triggered by pull requests from
  forks. In that case the action stops with an error that says so, and
  publishes nothing.

### The app log

Anyone who can read a public repository can read its job logs, and an
app's log can hold secrets: a connection string in a startup error, an
environment dump, user data. Values set with `innstance secrets` are not
GitHub secrets, so GitHub does not mask them. The action therefore never
prints the app log unless `show-app-log: true` is set. Leave it off in
public repositories.

### Inputs

Inputs reach the action's scripts only as environment variables. No input
value is placed inside shell code.

Nothing the CLI prints, and nothing it relays from the VM, can run a
workflow command such as `::set-output` or `::add-mask`: the action pauses
command processing with `::stop-commands::` while that output is printed.
Its own messages are escaped, so an input it refuses stays inside the
message that refuses it.

## Runners

GitHub-hosted Linux and macOS runners work as they are. A self-hosted
runner needs these tools:

- bash
- curl
- OpenSSH `ssh-keygen` 8.1 or later
- tar
- jq
- `sha256sum` or `shasum`

Windows runners are not supported. Install with `install.ps1` from the
release origin instead.
