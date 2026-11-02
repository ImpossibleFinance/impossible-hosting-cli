# From any sandbox to your domain

Coding agents often build in a cloud sandbox. Its preview URL is temporary.
This page shows how to put the result on an address that stays up, and on
your own domain. Every recipe has the same two steps:

1. Get the files out of the sandbox.
2. Publish or deploy them with the `innstance` CLI, or with the
   [GitHub Action](../actions/publish/README.md).

The vendor commands below were checked against each vendor's own
documentation on 2026-11-02. Under each recipe, **Not verified** lists any
command we could not confirm there. Vendors change their tools, so check a
command against its linked source before you rely on it in automation.

## Choose publish or deploy

| What you have | Use |
| --- | --- |
| One self-contained HTML page (styles and scripts inline), or PDFs and images | publish: `innstance publish --name <name> page.html` |
| A folder of static files, such as a `dist/` with HTML, CSS, JavaScript and assets | deploy, served by a small file server ([below](#a-folder-of-static-files)) |
| A server, API, bot or SSR app | deploy ([below](#an-app)) |

Publish needs no machine and is live in seconds. Deploy runs on an
always-on runner VM. `innstance publish` takes files, not folders, today,
so publishing only the `index.html` of a build folder leaves its CSS,
JavaScript and images behind: the job succeeds and the page is broken.

## Keep your token out of the sandbox

Pull the files out and publish from your own machine or from CI. A sandbox
runs code an agent wrote, and anything running there can read the
environment, including an Innstance token you put there.

If you must run the CLI inside the sandbox:

- Install it with the verified installer from the
  [README](../README.md#install).
- Use a token that expires soon: `innstance tokens create --name sandbox --expires-in 1`.
- Revoke the token when you are done: `innstance tokens revoke <id>`.

## The common shape: one archive

Most sandbox file APIs copy one file per call. So pack the output inside the
sandbox, copy that one archive out, and unpack it into a new, empty
directory:

```sh
# inside the sandbox (each vendor's "run a command" call)
tar -czf /tmp/site.tgz -C /path/to/output .

# on your machine or in CI, after copying /tmp/site.tgz out
mkdir site && tar -xzf site.tgz -C site
```

`/path/to/output` is wherever your agent wrote its build, for example
`dist` or `out`. The vendor recipes below end with `site.tgz` copied out
(InstaBox copies the folder itself, straight into `site/`). Unpack it as
above, then put `site/` live as one of the next three sections shows.

Treat `site/` as untrusted: an agent wrote it. Run `innstance init` and
`innstance deploy` in a directory of your own, never inside `site/`. An
`impossible.toml` there would otherwise set the app, its size, its
environment and its secret references. `machines push` never uploads an
`impossible.toml`, so one inside `site/` has no effect when you push it.

### One page

```sh
innstance publish --name my-demo site/report.html
innstance sites domains add my-demo www.example.com
```

### A folder of static files

The runner VM has no web server of its own, so install Python and serve
the folder with its built-in file server:

```sh
mkdir -p deploy && cd deploy          # a directory of your own, not site/
innstance init --app my-demo --port 8080
innstance deploy --app my-demo --yes
innstance machines install --app my-demo python3
innstance machines push --app my-demo ../site --to /app --yes-replace
innstance machines exec --app my-demo -- sh -c 'cd /app && { setsid nohup python3 -m http.server 8080 --bind 0.0.0.0 </dev/null >/tmp/app.log 2>&1 & }'
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 30 https://my-demo.innstance.app/
innstance machines domains add www.example.com --app my-demo
```

### An app

The same steps, with the app's runtime and its own start command. For a
Node server on port 3000:

```sh
mkdir -p deploy && cd deploy          # a directory of your own, not site/
innstance init --app my-demo --port 3000
innstance deploy --app my-demo --yes
innstance machines install --app my-demo nodejs npm
innstance machines push --app my-demo ../site --to /app --yes-replace
innstance machines exec --app my-demo -- sh -c 'cd /app && npm ci --omit=dev && { setsid nohup node server.js </dev/null >/tmp/app.log 2>&1 & }'
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 30 https://my-demo.innstance.app/
innstance machines domains add www.example.com --app my-demo
```

Notes for both:

- `init` writes the VM's size as well as its port. Run it for a new app
  only; for an app that already runs, deploy from the `impossible.toml` you
  deployed it with, or `init` resizes it to the defaults.
- `deploy` restarts the VM of an app that already exists, so install and
  start again after it, as above. Nothing restarts the server later; the
  [Action's README](../actions/publish/README.md#what-deploy-mode-does-not-do)
  lists when it stops.
- The app is live when the `curl` line prints 200 (or another 2xx or 3xx),
  not when `exec` returns: the server starts in the background and logs to
  `/tmp/app.log` on the VM. Use the address `innstance deploy` printed if it
  differs from the one above.
- `npm ci` needs a `package-lock.json`; use `npm install --omit=dev` without
  one.

`domains add` prints the DNS records to create. Run it again once they
resolve. The [Action](../actions/publish/README.md) runs these steps, the
health check and the domain step for you, on every push.

## InstaBox

Source: <https://instabox.sh/docs/cli.md> and <https://instabox.sh/llms.txt>.

```sh
npm install -g instabox          # in CI, pin an exact version: instabox@<version>
export INSTABOX_API_KEY=...      # create one with: instabox keys create --name ci
mkdir -p site
instabox cp -r my-box:/data/home/app/dist/. site
```

- `instabox cp [-r] SRC DST` copies in either direction. `box:PATH` names a
  path in the machine.
- A source ending in `/.` copies the directory's contents into `DST` itself.
- `/data/home` is the machine's home directory. Replace `app/dist` with
  your output directory.
- For a single file: `instabox cp my-box:/data/home/app/report.html .`

**Not verified:**

- Whether `cp` creates `DST` when it does not exist. The `mkdir -p` above
  avoids depending on it.
- The working directory `instabox exec` uses when `--cwd` is not given. The
  recipe uses absolute paths so it does not depend on it.

## E2B

Sources: <https://docs.e2b.dev/sandbox/connect>,
<https://docs.e2b.dev/filesystem/download>, the Python SDK reference
(`files.read(..., format="bytes")`, `commands.run(..., cwd=...)`), and the
`e2b` package on PyPI (2.62.0, released 2026-10-28). The SDK reads
`E2B_API_KEY` from the environment.

Python:

```python
# pip install e2b
from e2b import Sandbox

sbx = Sandbox.connect("<sandbox-id>")
sbx.commands.run("tar -czf /tmp/site.tgz -C /home/user/app/dist .")
with open("site.tgz", "wb") as f:
    f.write(sbx.files.read("/tmp/site.tgz", format="bytes"))
```

JavaScript:

```js
// npm i e2b
import { Sandbox } from 'e2b'
import { writeFile } from 'node:fs/promises'

const sbx = await Sandbox.connect(sandboxId)
await sbx.commands.run('tar -czf /tmp/site.tgz -C /home/user/app/dist .')
await writeFile('site.tgz', await sbx.files.read('/tmp/site.tgz', { format: 'bytes' }))
```

Replace `/home/user/app/dist` with your output directory.

**Not verified:**

- The npm package name `e2b`. The documentation imports from `'e2b'`, but
  its quickstart installs `@e2b/code-interpreter` instead.
- That `{ format: 'bytes' }` returns a `Uint8Array` in JavaScript. The
  reference lists `bytes` as a format and a `Uint8Array` overload, but does
  not state that one leads to the other.
- That a foreground `commands.run` raises an error when the command exits
  non-zero. The reference says so only for `CommandHandle.wait`, so check
  the result if you depend on it.

## Daytona

Sources: <https://www.daytona.io/docs/en.md> (`pip install daytona`,
`DAYTONA_API_KEY`),
<https://www.daytona.io/docs/en/python-sdk/sync/daytona.md> (`Daytona.get`),
<https://www.daytona.io/docs/en/file-system-operations.md>,
<https://www.daytona.io/docs/en/process-code-execution.md>, and
<https://www.daytona.io/docs/en/tools/cli.md>.

```python
# pip install daytona
from daytona import Daytona

daytona = Daytona()
sandbox = daytona.get("<sandbox-id-or-name>")
result = sandbox.process.exec("tar -czf /tmp/site.tgz -C /path/to/dist .")
if result.exit_code != 0:
    raise SystemExit(result.result)
sandbox.fs.download_file("/tmp/site.tgz", "site.tgz")
```

- The `daytona` CLI can run the `tar` step:
  `daytona exec <sandbox> -- tar -czf /tmp/site.tgz -C /path/to/dist .`.
  It has no command to download a file, so use the SDK for the copy.
- The TypeScript SDK (`npm install @daytona/sdk`) has the same calls:
  `process.executeCommand` and `fs.downloadFile`.

**Not verified:** the exact TypeScript call to fetch an existing sandbox by
ID. The Python `daytona.get` above is from the reference.

## Fly Sprites

Sources: <https://docs.fly.io/sprites/cli/commands.md>, the Sprites API spec
<https://docs.fly.io/sprites/api/openapi.json> (`GET
/v1/sprites/{name}/fs/read`; `path` and `workingDir` are required; bearer
auth), and <https://docs.fly.io/sprites/quickstart.md>.

```sh
sprite exec -s my-sprite -- tar -czf /tmp/site.tgz -C /path/to/dist .
curl --fail --silent --show-error \
  --header "Authorization: Bearer $SPRITE_TOKEN" \
  --output site.tgz \
  "https://api.sprites.dev/v1/sprites/my-sprite/fs/read?path=/tmp/site.tgz&workingDir=/"
```

- Install and sign in to the `sprite` CLI as the quickstart describes.
- The CLI has no copy command. Its only file option uploads a file before an
  `exec`. So the archive comes out through the filesystem API.

**Not verified:**

- That the token in the SDK examples (`SPRITE_TOKEN`) is the bearer token
  the REST API expects. The spec declares bearer auth but does not say which
  token it takes.
- That `sprite exec` output is binary-safe. The recipe does not stream the
  archive through `exec` for that reason.

## Vercel Sandbox

Sources: <https://vercel.com/docs/sandbox/cli-reference> and
<https://vercel.com/docs/sandbox/sdk-reference>.

CLI:

```sh
npm i -g sandbox                 # in CI, pin an exact version: sandbox@<version>
sandbox exec my-sandbox -- tar -czf /tmp/site.tgz -C /path/to/dist .
sandbox copy my-sandbox:/tmp/site.tgz ./site.tgz
```

- `sandbox copy` moves one file per call. The destination is the full path,
  not a directory.
- Outside Vercel, authenticate with an access token. `sandbox exec` and
  `sandbox copy` both accept `--token`, `--scope` and `--project`.

SDK:

```ts
import { Sandbox } from '@vercel/sandbox'

const sandbox = await Sandbox.get({ name: 'my-sandbox' })
const tar = await sandbox.runCommand('tar', ['-czf', '/tmp/site.tgz', '-C', '/path/to/dist', '.'])
if (tar.exitCode !== 0) throw new Error(`tar exited ${tar.exitCode}`)
await sandbox.downloadFile({ path: '/tmp/site.tgz' }, { path: 'site.tgz', cwd: process.cwd() })
```

`Sandbox.get` does not resume a stopped sandbox unless you pass
`resume: true`.

## In one workflow: sandbox to your domain

This GitHub Actions job pulls a build folder out of an E2B sandbox and
serves it on your domain. The same shape works with any recipe above: swap
the first step. For a single self-contained page, use the Action's default
`mode: publish` with `path: site/report.html` instead.

```yaml
name: ship-sandbox-build
on:
  workflow_dispatch:
    inputs:
      sandbox_id:
        description: Sandbox to publish from
        required: true
permissions:
  contents: read
# One deploy of this app at a time: each one restarts its VM.
concurrency:
  group: innstance-my-demo
  cancel-in-progress: false
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - name: Pull the build out of the sandbox
        env:
          E2B_API_KEY: ${{ secrets.E2B_API_KEY }}
          SANDBOX_ID: ${{ inputs.sandbox_id }}
        run: |
          python3 -m venv "$RUNNER_TEMP/venv"
          "$RUNNER_TEMP/venv/bin/pip" install --quiet 'e2b==2.62.0'
          "$RUNNER_TEMP/venv/bin/python" - <<'PY'
          import os
          from e2b import Sandbox

          sbx = Sandbox.connect(os.environ["SANDBOX_ID"])
          sbx.commands.run("tar -czf /tmp/site.tgz -C /home/user/app/dist .")
          with open("site.tgz", "wb") as f:
              f.write(sbx.files.read("/tmp/site.tgz", format="bytes"))
          PY
          mkdir site && tar -xzf site.tgz -C site
      - uses: ImpossibleFinance/impossible-hosting-cli/actions/publish@<commit-sha>
        with:
          token: ${{ secrets.INNSTANCE_TOKEN }}
          mode: deploy
          name: my-demo
          path: site
          port: 8080
          packages: python3
          start-command: exec python3 -m http.server 8080 --bind 0.0.0.0
          domain: demo.example.com
```

- The sandbox ID reaches the script as an environment variable, not as an
  expression inside `run`. So a crafted input cannot become shell code.
- The vendor key and the Innstance token are separate secrets. Each step
  gets only the one it needs.
- `path: site` pushes the sandbox's output, while the working directory
  stays the job's own. An `impossible.toml` the agent left in `site/` is
  neither read nor pushed. Never point `working-directory` at the output.
- Replace `<commit-sha>` with a full commit of this repository, as the
  [Action's README](../actions/publish/README.md#pin-the-action) explains.
