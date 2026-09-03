# ifhost CLI release metadata

Public trust material and independent checks for the `ifhost` command-line tool.
The CLI is built into the product server image and is delivered from the same
origin as the API. This repository does not build or publish binaries and does
not hold the release signing seed.

## Install

Download and inspect the installer before running it:

```sh
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
  --tlsv1.2 --connect-timeout 10 --max-time 60 --max-filesize 1048576 \
  https://host.impossibuild.ai/install --output "$installer"
less "$installer"
sh "$installer"
```

Windows users can inspect and run
[`install.ps1`](https://host.impossibuild.ai/install.ps1) instead.

The installer fetches `/dl/release.txt` and `/dl/release.txt.sshsig`, verifies
the SSHSIG with the public key in `release-signers`, selects one of the six
signed artifact digests, and downloads that archive from `/dl`. The same
server-held Ed25519 seed signs `/cli/version` for installed clients. There is no
KMS publisher and `gh-pages` is not the active release channel.

## Verify the live channel

On a system with Bash, curl, OpenSSH, jq, Python 3, SHA-256 tools, and OpenSSL
3, run:

```sh
scripts/verify-channel.sh \
  https://host.impossibuild.ai \
  release-signers \
  channel-state.json \
  /tmp/ifhost-channel-state.json
```

The verifier checks both signed metadata formats, their common build identity
and digests, the exact `/dl` URLs, all six live archives and checksum sidecars,
and the archive member shape. It never executes a downloaded binary.

`channel-state.json` is the repository's initial accepted checkpoint. A
recurring audit must compare with its immediately preceding successful output,
not start over from that file. The scheduled workflow does this by retaining
each accepted state as a GitHub Actions artifact and refusing to continue when
a previous audit exists but its state is unavailable.

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

- `https://host.impossibuild.ai/dl/release.txt`
- `https://host.impossibuild.ai/dl/release.txt.sshsig`
- `https://host.impossibuild.ai/cli/version`
- `https://host.impossibuild.ai/dl/ifhost_<os>_<arch>.<archive>`

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
