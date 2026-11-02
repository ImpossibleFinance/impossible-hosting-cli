# Innstance CLI release metadata

Public trust material and independent checks for the `innstance`
command-line tool, which CLIs installed before the rename still run as
`ifhost`. The CLI is built into the product server image and is delivered
from the same origin as the API. This repository does not build or publish
binaries and does not hold the release signing seed.

## Install

Download and inspect the installer before running it:

```sh
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
  --tlsv1.2 --connect-timeout 10 --max-time 60 --max-filesize 1048576 \
  https://innstance.impossibuild.ai/install --output "$installer"
less "$installer"
sh "$installer"
```

Windows users can inspect and run
[`install.ps1`](https://innstance.impossibuild.ai/install.ps1) instead.

The installer fetches `/dl/release.txt` and `/dl/release.txt.sshsig`, verifies
the SSHSIG with the public key in `release-signers`, picks the `innstance`
archive for the machine from the twelve signed artifact digests, and downloads
that archive from `/dl`. The same server-held Ed25519 seed signs `/cli/version`
for installed clients. There is no KMS publisher and `gh-pages` is not the
active release channel.

## Two names, one build

Every release publishes each platform's build twice, once under each name the
CLI has had:

- `innstance_<os>_<arch>.tar.gz` (`.zip` on Windows) holds a single
  `innstance` entry (`innstance.exe`). The installers download these, and CLIs
  installed as `innstance` update from the `innstance_<os>_<arch>` key in
  `/cli/version`.
- `ifhost_<os>_<arch>.tar.gz` (`.zip`) holds a single `ifhost` entry
  (`ifhost.exe`). CLIs installed before the rename update from the bare
  `<os>_<arch>` key and cannot be taught another one; scripts written against
  the old name keep downloading it.

The two entries for a platform are the same bytes; only the name differs. Six
platforms under two names make the twelve digests in `release.txt` and the
twelve download keys in `/cli/version`.

## Verify the live channel

On a system with Bash, curl, OpenSSH, jq, Python 3, SHA-256 tools, and OpenSSL
3, run:

```sh
scripts/verify-channel.sh \
  https://innstance.impossibuild.ai \
  release-signers \
  channel-state.json \
  /tmp/ifhost-channel-state.json
```

The verifier checks both signed metadata formats, their common build identity
and digests, the exact `/dl` URLs, all twelve live archives and checksum
sidecars, the archive member shape, and that both names carry the same binary.
It never executes a downloaded binary.

The signed record is pinned to exactly the shape the server signs: the four
identity lines, then the six `innstance_*` digests and the six `ifhost_*`
digests, each group in archive-name order. A change to that shape on the
server has to ship with the matching change to `scripts/verify-channel.sh`;
until then the audit fails instead of guessing.

A build ID's timestamp is the UTC committer time of the signed source commit.
The source repository is private, so the public check cannot confirm that.
Anyone with a clone of it can, by naming the clone:

```sh
git -C /path/to/impossible-hosting fetch origin
IFHOST_CHANNEL_SOURCE_REPO=/path/to/impossible-hosting \
  scripts/verify-channel.sh \
  https://innstance.impossibuild.ai \
  release-signers \
  channel-state.json \
  /tmp/ifhost-channel-state.json
```

A commit's date is whatever its author wrote, and a clone also holds feature
and dependency branches, so the verifier then also requires the signed commit
to be on `origin/main` in that clone. Set `IFHOST_CHANNEL_SOURCE_REF` to check
another branch. This binds the build ID to a commit that reached the deployed
branch; it still cannot show which commit the server actually built.

`channel-state.json` is the repository's committed checkpoint, where an audit
with no history of its own starts. A recurring audit must compare with its
immediately preceding successful output, not start over from that file. The
scheduled workflow does this by retaining each accepted state as a GitHub
Actions artifact and refusing to continue when a previous audit exists but its
state is unavailable. It never falls back to the committed checkpoint (see
[SECURITY.md](SECURITY.md)).

The checkpoint moves only forward and only through review. To advance it, run
the verifier from the newest state an audit has accepted: the `channel-state`
artifact of the latest successful scheduled or manual audit, or this file when
no audit has kept one. Commit the state the verifier writes, and show that run
in the review. Never advance it from an older state than the audit has
accepted, and never edit it by hand to match whatever is live.

## Build identity

A build ID is `YYYYMMDD-HHMMSS`, the UTC committer time of the signed source
commit. Today every deploy of the source repository's `main` rebuilds the CLI
from the commit being deployed, so each deploy signs that commit and gets a
new build ID, even when only the server changed.

The release pipeline is moving to building the CLI from the newest commit
that changed it. A server deploy that leaves the CLI alone will then keep the
build ID and must serve the same `release.txt`, byte for byte: the same source
commit and the same archive digests. The verifier already accepts that, and
rejects anything else under a repeated build ID.

A repeated build identity is accepted only when the signed source commit and
the complete signed release record are byte-for-byte unchanged. An advance
must have a later UTC timestamp. The legacy `YYYYMMDD-HHMMSS` form remains
valid only while the previously accepted identity is also legacy. Once the
channel records `YYYYMMDD-HHMMSS-<40-character-source-commit>`, every later
identity must keep that form and its suffix must equal the `source_commit` in
the SSHSIG record. Consequently, replaying an older complete signed snapshot
after a newer observation fails instead of resetting the verifier's history.

## Release metadata

The live endpoints are:

- `https://innstance.impossibuild.ai/dl/release.txt`
- `https://innstance.impossibuild.ai/dl/release.txt.sshsig`
- `https://innstance.impossibuild.ai/cli/version`
- `https://innstance.impossibuild.ai/dl/innstance_<os>_<arch>.<archive>`
- `https://innstance.impossibuild.ai/dl/ifhost_<os>_<arch>.<archive>`

`release.txt` authenticates the build identity, source repository name, exact
source commit, build mechanism, and archive digests. `/cli/version` carries the
same build identity and digests plus the relative download URLs. The verifier
requires an SSHSIG over the exact release record and a valid Ed25519 signature
over the updater manifest; agreement between unsigned fields is not a
substitute for either signature.

The source commit is an authenticated assertion by the server-held release
key. This public repository cannot independently prove reachability in the
private source repository or prove which machine used the key. See
[SECURITY.md](SECURITY.md) for the trust boundary and residual risk.

## Reporting problems

Issues and support go through the platform, not this metadata repository.
