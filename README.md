# ifhost CLI releases

Release binaries for the `ifhost` command-line tool. This repository holds
published artifacts only — no source. It is public so that installs and
self-updates download from GitHub's CDN rather than from the platform API.

## Install

```sh
curl -fsSL https://host.impossi.build/install | sh
```

The installer picks the right build for your platform and verifies its
SHA-256 checksum before installing.

## Manual download

Pick a build from [Releases](../../releases). Every release publishes
`linux` and `darwin` for both `amd64` and `arm64`, each with a `.sha256`
alongside it. Verify before running:

```sh
sha256sum -c ifhost_linux_amd64.tar.gz.sha256
tar -xzf ifhost_linux_amd64.tar.gz
./ifhost --help
```

## Versioning

Releases are dated: `YYYY.MM.DD.N`, where `N` counts releases within that
day starting at 1 — so `2026.08.14.2` is the second release cut on the
14th. A version changes only when the CLI itself changes.

## Reporting problems

Issues and support go through the platform, not this repository.
