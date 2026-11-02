#!/usr/bin/env bash
set -euo pipefail

origin=${1:?usage: verify-channel.sh RELEASE_ORIGIN ALLOWED_SIGNERS PREVIOUS_STATE NEXT_STATE}
allowed_signers=${2:?usage: verify-channel.sh RELEASE_ORIGIN ALLOWED_SIGNERS PREVIOUS_STATE NEXT_STATE}
previous_state=${3:?usage: verify-channel.sh RELEASE_ORIGIN ALLOWED_SIGNERS PREVIOUS_STATE NEXT_STATE}
next_state=${4:?usage: verify-channel.sh RELEASE_ORIGIN ALLOWED_SIGNERS PREVIOUS_STATE NEXT_STATE}

curl_proto='=https'
if [[ $origin =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  :
elif [[ ${IFHOST_CHANNEL_ALLOW_HTTP:-} == 1 && $origin =~ ^http://(127\.0\.0\.1|localhost):[0-9]+$ ]]; then
  curl_proto='=http,https'
else
  echo "release origin must be an HTTPS origin without a path" >&2
  exit 1
fi

for tool in curl ssh-keygen jq python3; do
  command -v "$tool" >/dev/null || { echo "missing required verifier: $tool" >&2; exit 1; }
done
if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | awk '{ print $1 }'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | awk '{ print $1 }'; }
else
  echo "missing required verifier: sha256sum or shasum" >&2
  exit 1
fi
for file in "$allowed_signers" "$previous_state"; do
  test -f "$file" || { echo "missing verifier input: $file" >&2; exit 1; }
done
# Optional: a local clone of the private source repository.
source_repo=${IFHOST_CHANNEL_SOURCE_REPO:-}
if [[ -n $source_repo ]]; then
  command -v git >/dev/null || { echo "missing required verifier: git" >&2; exit 1; }
  git -C "$source_repo" rev-parse --git-dir >/dev/null 2>&1 || {
    echo "IFHOST_CHANNEL_SOURCE_REPO is not a git repository: $source_repo" >&2
    exit 1
  }
fi

openssl_bin=
for candidate in "${OPENSSL_BIN:-}" openssl \
  /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
  test -n "$candidate" || continue
  command -v "$candidate" >/dev/null 2>&1 || continue
  if "$candidate" version 2>/dev/null | grep -Eq '^OpenSSL 3\.'; then
    openssl_bin=$candidate
    break
  fi
done
test -n "$openssl_bin" || { echo "OpenSSL 3 is required to verify /cli/version" >&2; exit 1; }

verify_root=$(mktemp -d)
trap 'rm -rf "$verify_root"' EXIT HUP INT TERM
curl_args=(
  --fail --silent --show-error
  --proto "$curl_proto" --tlsv1.2
  --connect-timeout 10 --max-time 300 --retry 2
)
fetch() {
  local url=$1 output=$2 limit=$3
  curl "${curl_args[@]}" --max-filesize "$limit" --output "$output" "$url"
  test "$(wc -c < "$output" | tr -d ' ')" -le "$limit" || {
    echo "download exceeds size limit: $url" >&2
    return 1
  }
}

fetch "$origin/dl/release.txt" "$verify_root/release.txt" 1048576
fetch "$origin/dl/release.txt.sshsig" "$verify_root/release.txt.sshsig" 1048576
fetch "$origin/cli/version" "$verify_root/version.json" 1048576

ssh-keygen -Y verify -f "$allowed_signers" -I ifhost -n ifhost-release \
  -s "$verify_root/release.txt.sshsig" < "$verify_root/release.txt" >/dev/null
release_sha256=$(sha256_file "$verify_root/release.txt")

python3 - \
  "$verify_root/release.txt" "$verify_root/version.json" "$allowed_signers" \
  "$previous_state" "$release_sha256" "$verify_root/parsed.json" \
  "$verify_root/public.der" "$verify_root/unsigned.json" \
  "$verify_root/signature.bin" "$verify_root/next-state.json" <<'PY'
import base64
import datetime
import json
import pathlib
import re
import struct
import sys

release_path, manifest_path, signers_path, previous_state_path = map(pathlib.Path, sys.argv[1:5])
release_sha256 = sys.argv[5]
(
    parsed_path,
    public_der_path,
    unsigned_path,
    signature_path,
    next_state_path,
) = map(pathlib.Path, sys.argv[6:])

platforms = [
    "darwin_amd64",
    "darwin_arm64",
    "linux_amd64",
    "linux_arm64",
    "windows_amd64",
    "windows_arm64",
]
# Every platform is one build published under two names. innstance is the
# name the product ships under: the installers download it, and CLIs
# installed as innstance update from its innstance_<os>_<arch> manifest key.
# ifhost is the same build under the name CLIs installed before the rename
# carry; they look up the bare <os>_<arch> key and cannot be taught
# otherwise. Each archive holds one entry named for its family, and the two
# entries for a platform must be the same bytes.
families = ["innstance", "ifhost"]
artifacts = []
for family in families:
    family_artifacts = []
    for platform in platforms:
        windows = platform.startswith("windows_")
        family_artifacts.append(
            {
                "archive": f"{family}_{platform}" + (".zip" if windows else ".tar.gz"),
                "platform": platform,
                "manifest_key": platform if family == "ifhost" else f"{family}_{platform}",
                "member": family + (".exe" if windows else ""),
            }
        )
    # The publisher writes each family's digests in archive-name order,
    # innstance first. The record is pinned exactly so that one release has
    # exactly one signed encoding: a publisher change to its shape has to
    # land together with a matching change here.
    artifacts.extend(sorted(family_artifacts, key=lambda artifact: artifact["archive"]))
identity_keys = ["build_id", "source_repository", "source_commit", "source_workflow"]
expected_release_keys = [
    *identity_keys,
    *[f"artifact.{artifact['archive']}" for artifact in artifacts],
]
assert len(set(expected_release_keys)) == len(expected_release_keys)
expected_downloads = {artifact["manifest_key"]: artifact for artifact in artifacts}
assert len(expected_downloads) == len(artifacts)
hex40 = re.compile(r"[0-9a-f]{40}")
hex64 = re.compile(r"[0-9a-f]{64}")
build_pattern = re.compile(r"(?P<stamp>\d{8}-\d{6})(?:-(?P<commit>[0-9a-f]{40}))?")


def fail(message):
    raise SystemExit(message)


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicates)
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as exc:
        fail(f"invalid JSON in {path}: {exc}")


def parse_build_id(value, label):
    if not isinstance(value, str):
        fail(f"{label} build_id is not a string")
    match = build_pattern.fullmatch(value)
    if not match:
        fail(f"{label} build_id has an invalid release identity")
    try:
        datetime.datetime.strptime(match.group("stamp"), "%Y%m%d-%H%M%S")
    except ValueError as exc:
        fail(f"{label} build_id has an invalid UTC timestamp: {exc}")
    return match.group("stamp"), match.group("commit")


try:
    release_bytes = release_path.read_bytes()
    release_text = release_bytes.decode("ascii")
except (OSError, UnicodeError) as exc:
    fail(f"invalid signed release record: {exc}")
if not release_text.endswith("\n") or "\r" in release_text or "\0" in release_text:
    fail("signed release record must be newline-terminated ASCII")
lines = release_text[:-1].split("\n")
if len(lines) != len(expected_release_keys):
    fail(
        f"signed release record has {len(lines)} fields; expected {len(expected_release_keys)}: "
        f"{len(identity_keys)} identity fields and {len(artifacts)} artifact digests"
    )
release = {}
for number, (expected_key, line) in enumerate(zip(expected_release_keys, lines), start=1):
    if "=" not in line:
        fail(f"malformed signed release line {number}: {line}")
    key, value = line.split("=", 1)
    if key != expected_key:
        fail(f"signed release line {number} is {key}; expected {expected_key}")
    if not value:
        fail(f"signed release field {key} is empty")
    release[key] = value

build_id = release["build_id"]
stamp, build_commit = parse_build_id(build_id, "current")
source_commit = release["source_commit"]
if release["source_repository"] != "ImpossibleFinance/impossible-hosting":
    fail("signed release names an unexpected source repository")
if not hex40.fullmatch(source_commit):
    fail("signed release has an invalid source commit")
if release["source_workflow"] != "docker-build":
    fail("signed release names an unexpected source workflow")
if build_commit is not None and build_commit != source_commit:
    fail("release identity is not bound to its signed source commit")
for artifact in artifacts:
    if not hex64.fullmatch(release[f"artifact.{artifact['archive']}"]):
        fail(f"signed release has an invalid digest for {artifact['archive']}")

manifest = load_json(manifest_path)
if not isinstance(manifest, dict) or set(manifest) != {"build_id", "downloads", "signature"}:
    fail("/cli/version has missing or unexpected fields")
if manifest["build_id"] != build_id:
    fail("/cli/version build_id disagrees with the SSHSIG release record")
if not isinstance(manifest["downloads"], dict):
    fail("/cli/version downloads is not an object")
missing_keys = sorted(set(expected_downloads) - set(manifest["downloads"]))
unexpected_keys = sorted(set(manifest["downloads"]) - set(expected_downloads))
if missing_keys or unexpected_keys:
    fail(
        "/cli/version download keys differ from the signed release: "
        f"missing {missing_keys or 'none'}, unexpected {unexpected_keys or 'none'}"
    )
for key, artifact in expected_downloads.items():
    download = manifest["downloads"][key]
    if not isinstance(download, dict) or set(download) != {"url", "sha256"}:
        fail(f"/cli/version has malformed metadata for {key}")
    if download["url"] != f"/dl/{artifact['archive']}?b={build_id}":
        fail(f"/cli/version has an unexpected URL for {key}")
    if download["sha256"] != release[f"artifact.{artifact['archive']}"]:
        fail(f"/cli/version digest disagrees for {key}")
try:
    signature = base64.b64decode(manifest["signature"], validate=True)
except (TypeError, ValueError) as exc:
    fail(f"/cli/version has an invalid signature encoding: {exc}")
if len(signature) != 64:
    fail("/cli/version has an invalid Ed25519 signature length")
canonical_downloads = {
    key: {
        "url": manifest["downloads"][key]["url"],
        "sha256": manifest["downloads"][key]["sha256"],
    }
    for key in sorted(expected_downloads)
}
unsigned = {"build_id": build_id, "downloads": canonical_downloads}
unsigned_path.write_text(
    json.dumps(unsigned, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
)
signature_path.write_bytes(signature)

try:
    signer_lines = [line for line in signers_path.read_text(encoding="ascii").splitlines() if line]
except (OSError, UnicodeError) as exc:
    fail(f"invalid release-signers: {exc}")
if len(signer_lines) != 1:
    fail("release-signers must contain exactly one signer")
parts = signer_lines[0].split()
if len(parts) != 3 or parts[:2] != ["ifhost", "ssh-ed25519"]:
    fail("release-signers has an unexpected identity or key type")
try:
    key_blob = base64.b64decode(parts[2], validate=True)
except ValueError as exc:
    fail(f"release-signers has invalid base64: {exc}")


def read_string(data):
    if len(data) < 4:
        fail("release-signers has a truncated SSH key")
    length = struct.unpack(">I", data[:4])[0]
    if len(data) < 4 + length:
        fail("release-signers has a truncated SSH key")
    return data[4 : 4 + length], data[4 + length :]


key_type, key_rest = read_string(key_blob)
public_key, key_rest = read_string(key_rest)
if key_type != b"ssh-ed25519" or len(public_key) != 32 or key_rest:
    fail("release-signers is not a canonical Ed25519 SSH key")
public_der_path.write_bytes(bytes.fromhex("302a300506032b6570032100") + public_key)

previous = load_json(previous_state_path)
expected_state_keys = {"schema", "build_id", "source_commit", "release_sha256"}
if not isinstance(previous, dict) or set(previous) != expected_state_keys or previous["schema"] != 1:
    fail("previous channel state has an unsupported schema")
previous_stamp, previous_build_commit = parse_build_id(previous["build_id"], "previous")
if not hex40.fullmatch(previous.get("source_commit", "")):
    fail("previous channel state has an invalid source commit")
if not hex64.fullmatch(previous.get("release_sha256", "")):
    fail("previous channel state has an invalid release digest")
if previous_build_commit is not None and previous_build_commit != previous["source_commit"]:
    fail("previous release identity is not bound to its source commit")

if stamp < previous_stamp:
    fail("release rollback detected: build timestamp is older than the accepted state")
if stamp == previous_stamp:
    # A build ID repeats when the same commit is deployed again, and, once
    # the CLI is built from the newest commit that changed it, whenever a
    # server deploy leaves the CLI alone. Either way the deploy must
    # republish the same release: one identity names one exact signed
    # record, and any change under it is equivocation, however harmless the
    # reason (a rebuilt archive with a new timestamp inside, or a deploy
    # commit written into source_commit).
    if build_id != previous["build_id"]:
        fail("non-monotonic release identity: the timestamp was reused")
    if source_commit != previous["source_commit"] or release_sha256 != previous["release_sha256"]:
        fail("release snapshot changed without a new release identity")
else:
    # The live publisher historically emitted a timestamp-only build ID.
    # Permit that signed format only until the channel first advances to the
    # commit-bound format; after that transition, rollback to the legacy
    # identity is rejected permanently by the persisted state.
    if previous_build_commit is not None and (build_commit is None or build_commit != source_commit):
        fail("a new release identity must include its full signed source commit")

next_state = {
    "schema": 1,
    "build_id": build_id,
    "source_commit": source_commit,
    "release_sha256": release_sha256,
}
next_state_path.write_text(json.dumps(next_state, indent=2) + "\n", encoding="utf-8")
parsed_path.write_text(
    json.dumps(
        {
            "build_id": build_id,
            "source_commit": source_commit,
            "artifacts": [
                {
                    "archive": artifact["archive"],
                    "digest": release[f"artifact.{artifact['archive']}"],
                    "member": artifact["member"],
                    "platform": artifact["platform"],
                }
                for artifact in artifacts
            ],
        },
        separators=(",", ":"),
    ),
    encoding="utf-8",
)
PY

"$openssl_bin" pkeyutl -verify -pubin -inkey "$verify_root/public.der" -keyform DER -rawin \
  -in "$verify_root/unsigned.json" -sigfile "$verify_root/signature.bin" >/dev/null || {
  echo "/cli/version Ed25519 signature verification failed" >&2
  exit 1
}

build_id=$(jq -r .build_id "$verify_root/parsed.json")

# The build ID's timestamp is the UTC committer time of the signed source
# commit. The source repository is private, so a public audit cannot check
# that; a maintainer with a clone can, by naming it here.
if [[ -n $source_repo ]]; then
  source_commit=$(jq -r .source_commit "$verify_root/parsed.json")
  test "$(git -C "$source_repo" cat-file -t "$source_commit" 2>/dev/null)" = commit || {
    echo "signed source commit $source_commit is not a commit in $source_repo" >&2
    exit 1
  }
  git -C "$source_repo" cat-file commit "$source_commit" > "$verify_root/source-commit.txt"
  python3 - "$verify_root/source-commit.txt" "$build_id" <<'PY'
import datetime
import pathlib
import re
import sys

commit_path, build_id = pathlib.Path(sys.argv[1]), sys.argv[2]
headers = commit_path.read_bytes().split(b"\n\n", 1)[0].decode("utf-8", "replace").split("\n")
committers = [line for line in headers if line.startswith("committer ")]
match = re.fullmatch(r"committer .* (\d+) [+-]\d{4}", committers[0]) if len(committers) == 1 else None
if not match:
    raise SystemExit("signed source commit has no readable committer time")
committed = datetime.datetime.fromtimestamp(int(match.group(1)), datetime.timezone.utc)
if build_id[:15] != committed.strftime("%Y%m%d-%H%M%S"):
    raise SystemExit(
        f"build_id {build_id} is not the commit time of its signed source commit "
        f"({committed.strftime('%Y%m%d-%H%M%S')} UTC)"
    )
PY
fi

expected_archives=$(jq '.artifacts | length' "$verify_root/parsed.json")
checked_archives=0
mkdir "$verify_root/payloads"
while IFS=$'\t' read -r name digest member platform; do
  fetch "$origin/dl/$name?b=$build_id" "$verify_root/$name" 67108864
  actual=$(sha256_file "$verify_root/$name")
  test "$actual" = "$digest" || { echo "live archive digest mismatch for $name" >&2; exit 1; }

  fetch "$origin/dl/$name.sha256" "$verify_root/$name.sha256" 1024
  test "$(cat "$verify_root/$name.sha256")" = "$digest  $name" || {
    echo "live checksum sidecar mismatch for $name" >&2
    exit 1
  }

  python3 - "$verify_root/$name" "$name" "$member" > "$verify_root/$name.payload" <<'PY'
import hashlib
import stat
import sys
import tarfile
import zipfile

path, archive_name, expected = sys.argv[1:]

def verify_payload(stream, expected_size, archive_name):
    total = 0
    digest = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        total += len(chunk)
        digest.update(chunk)
    if total != expected_size:
        raise SystemExit(f"truncated release entry in {archive_name}")
    print(digest.hexdigest())
if archive_name.endswith(".zip"):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) != 1 or entries[0].filename != expected:
            raise SystemExit(f"unexpected files in {archive_name}")
        entry = entries[0]
        unix_type = (entry.external_attr >> 16) & 0o170000
        if unix_type not in (0, stat.S_IFREG):
            raise SystemExit(f"non-regular release entry in {archive_name}")
        if not 0 < entry.file_size <= 64 * 1024 * 1024:
            raise SystemExit(f"invalid release entry size in {archive_name}")
        with archive.open(entry) as payload:
            verify_payload(payload, entry.file_size, archive_name)
else:
    with tarfile.open(path, mode="r:gz") as archive:
        entries = archive.getmembers()
        if len(entries) != 1 or entries[0].name != expected or not entries[0].isfile():
            raise SystemExit(f"unexpected or non-regular entry in {archive_name}")
        entry = entries[0]
        if not 0 < entry.size <= 64 * 1024 * 1024:
            raise SystemExit(f"invalid release entry size in {archive_name}")
        extracted = archive.extractfile(entry)
        if extracted is None:
            raise SystemExit(f"unreadable release entry in {archive_name}")
        with extracted:
            verify_payload(extracted, entry.size, archive_name)
PY

  # Both names carry one build. An innstance and an ifhost CLI that report
  # the same build ID must be the same program, so the entries have to match
  # byte for byte, not merely both be well formed.
  payload=$(cat "$verify_root/$name.payload")
  [[ $payload =~ ^[0-9a-f]{64}$ ]] || { echo "could not digest the entry in $name" >&2; exit 1; }
  if test -f "$verify_root/payloads/$platform"; then
    test "$(cat "$verify_root/payloads/$platform")" = "$payload" || {
      echo "$name carries a different binary from the other $platform archive" >&2
      exit 1
    }
  else
    printf '%s\n' "$payload" > "$verify_root/payloads/$platform"
  fi
  checked_archives=$((checked_archives + 1))
done < <(jq -r '.artifacts[] | [.archive, .digest, .member, .platform] | @tsv' "$verify_root/parsed.json")
test "$checked_archives" -eq "$expected_archives" || {
  echo "checked $checked_archives of $expected_archives signed archives" >&2
  exit 1
}

cp "$verify_root/next-state.json" "$next_state"
echo "verified server-signed CLI channel $build_id ($checked_archives archives)"
if [[ -n $source_repo ]]; then
  echo "build_id is the commit time of source commit $source_commit in $source_repo"
fi
