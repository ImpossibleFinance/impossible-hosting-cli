# Security policy

## Release trust boundary

The production server owns the release artifacts and the Ed25519 seed. At
startup it derives the public key and refuses to publish signed update metadata
when that key does not match the client trust anchor. It signs two different
messages with the same anchor:

- SSHSIG namespace `ifhost-release` covers the exact bytes served at
  `/dl/release.txt` for shell and PowerShell installers.
- Raw Ed25519 covers the canonical `/cli/version` JSON with its `signature`
  field omitted for installed CLI updates.

The public key is pinned in `release-signers`. The audit verifies both
signatures independently, then requires their build IDs, platform set, URLs,
and SHA-256 digests to agree. It fetches the six archives and sidecars through
the production `/dl` routes, verifies the bytes, and rejects links, devices,
extra members, empty payloads, and oversized payloads. Downloaded programs are
never executed by the audit.

There is no KMS signing stage, immutable Git artifact commit, `latest.json`, or
`gh-pages` metadata publisher in this trust model. Whoever controls the
production server and signing seed can produce an authentic malicious release.
The signed `source_commit` records exactly what that key holder attested; it is
not independent proof that a private source ref was reachable or that a
particular CI workflow ran.

## Rollback witness

Signature validity alone cannot distinguish the newest release from an older,
still-valid snapshot. `channel-state.json` therefore anchors the first audit.
Every successful scheduled or manually dispatched live audit uploads its
accepted state, and the next run restores the state from the latest preceding
successful live run. If such a run exists but its artifact is missing or
expired, the workflow fails closed instead of falling back to the repository
bootstrap.

The state binds four values: schema version, release build ID, signed source
commit, and SHA-256 of the complete SSHSIG-covered release record. The verifier
enforces these transitions:

1. The UTC timestamp in the build ID may not decrease.
2. Reusing a timestamp with another identity is rejected.
3. Reusing an identity is allowed only when the source commit and complete
   signed record digest are unchanged.
4. Once an accepted identity includes the full 40-character signed source
   commit as its suffix, every newer identity must include that suffix.

Those rules make a whole-snapshot replay observable after any successful audit;
checking only the internally consistent current response would not.

The Actions artifact is a witness outside the release server, not a permanent
transparency log. Repository administrators and GitHub remain trusted, and an
audit outage longer than artifact retention fails closed until an authorized
review updates the committed bootstrap checkpoint.

## Changes to trust material

Changes to `release-signers`, `channel-state.json`, the verifier, or the audit
workflow require CODEOWNER review and protected-branch enforcement. Rotating
the signing key requires first shipping clients and installers that trust the
new key, then deliberately replacing this repository's anchor. Never accept an
unsigned transition or reset the checkpoint merely to make a rollback alarm
pass.

## The `innstance` npm package

`npm/innstance` is a separate trust path from the signed CLI channel above.
It never downloads, verifies or runs the CLI binary. Its trust properties:

- **Publishing.** The package is published only by
  `.github/workflows/npm-publish.yml`, through npm trusted publishing with
  provenance. The workflow runs only for an `npm-v<version>` tag on a commit
  already on `main`, and only after a maintainer enables it (see
  `npm/innstance/RELEASING.md`). No npm token is stored in this repository.
- **Contents.** The package has no dependencies, no install scripts and no
  native code. Tests enforce this, and CI checks the tarball's file list.
- **Skill pin.** The skill is installed from one pinned commit of the public
  skill repository. Each file is checked against a SHA-256 pinned in
  `lib/skill-pin.json`. Because those hashes ship in a provenance-attested
  package rather than beside the files they describe, a change to the skill
  repository cannot alter what a published version installs.
- **Credentials.** The token is the control plane's per-device session
  (`cli-npx-<os>-<host>-<id>`), separate from the Go CLI's session. It is
  written owner-only (`0600`) into the agent configs and
  `~/.impossible/npx-session.json`. It is never printed, never sent to an
  origin other than the one that issued it, and never sent across a redirect.
  The approval URL from the device flow must be `<origin>/auth/device`
  exactly, or the package does not open or print it.

Whoever controls the npm package's trusted-publisher configuration, or the
`main` branch and tag rules of this repository, can publish a malicious
version. Changes to the publish workflow, the skill pin, and the package's
network or file-writing code need the same CODEOWNER review as the release
trust material.

## Reporting a vulnerability

Do not disclose a suspected release compromise in a public issue. Contact the
platform security owner through the private support channel and include the
observed build ID, source commit, release-record digest, and endpoint.
