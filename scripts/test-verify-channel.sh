#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
verifier=$repo_root/scripts/verify-channel.sh
for tool in curl ssh-keygen jq python3; do
  command -v "$tool" >/dev/null || { echo "missing required test tool: $tool" >&2; exit 1; }
done
if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | awk '{ print $1 }'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | awk '{ print $1 }'; }
else
  echo "missing required test tool: sha256sum or shasum" >&2
  exit 1
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
test -n "$openssl_bin" || { echo "OpenSSL 3 is required for the verifier test" >&2; exit 1; }

test_root=$(mktemp -d)
server_pid=
trap 'test -z "$server_pid" || kill "$server_pid" 2>/dev/null || true; rm -rf "$test_root"' EXIT HUP INT TERM
channel=$test_root/channel
mkdir -p "$channel/cli" "$channel/dl"

ssh-keygen -q -t ed25519 -N '' -C ifhost-test -f "$test_root/key"
awk '{ print "ifhost " $1 " " $2 }' "$test_root/key.pub" > "$test_root/release-signers"

# The twelve archives in the order the publisher signs them: each name's
# archives in name order, innstance first.
archives=()
for family in innstance ifhost; do
  for platform in darwin_amd64 darwin_arm64 linux_amd64 linux_arm64; do
    archives+=("${family}_${platform}.tar.gz")
  done
  for platform in windows_amd64 windows_arm64; do
    archives+=("${family}_${platform}.zip")
  done
done

# build_archives MTIME [ARCHIVE:member=NAME | ARCHIVE:payload=SUFFIX ...]
#
# Packs one build per platform under both names, the way the publisher does,
# with every timestamp inside the archive set to MTIME. A fixed MTIME
# rebuilds byte-identical archives; a different one stands in for a rebuild
# that stamps the time it ran. The overrides break one archive on purpose.
build_archives() {
  python3 - "$channel/dl" "$@" <<'PY'
import gzip
import hashlib
import io
import pathlib
import stat
import sys
import tarfile
import time
import zipfile

root, mtime = pathlib.Path(sys.argv[1]), int(sys.argv[2])
overrides = {}
for spec in sys.argv[3:]:
    archive, assignment = spec.split(":", 1)
    field, value = assignment.split("=", 1)
    overrides.setdefault(archive, {})[field] = value
for family in ["innstance", "ifhost"]:
    for platform in [
        "darwin_amd64",
        "darwin_arm64",
        "linux_amd64",
        "linux_arm64",
        "windows_amd64",
        "windows_arm64",
    ]:
        windows = platform.startswith("windows_")
        name = f"{family}_{platform}" + (".zip" if windows else ".tar.gz")
        override = overrides.pop(name, {})
        member = override.get("member", family + (".exe" if windows else ""))
        payload = f"#!/bin/sh\n# {platform}{override.get('payload', '')}\nexit 0\n".encode()
        path = root / name
        if windows:
            info = zipfile.ZipInfo(member, date_time=time.gmtime(max(mtime, 315532800))[:6])
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o755) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr(info, payload)
        else:
            info = tarfile.TarInfo(member)
            info.mode = 0o755
            info.mtime = mtime
            info.size = len(payload)
            buffer = io.BytesIO()
            with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w") as archive:
                    archive.addfile(info, io.BytesIO(payload))
            path.write_bytes(buffer.getvalue())
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        root.joinpath(name + ".sha256").write_text(f"{digest}  {name}\n", encoding="ascii")
if overrides:
    raise SystemExit(f"unknown fixture archives: {sorted(overrides)}")
PY
}

# Extract the seed from the unencrypted OpenSSH fixture key and wrap it as a
# PKCS#8 Ed25519 key. OpenSSL can then sign the same canonical JSON as Go.
python3 - "$test_root/key" "$test_root/private.der" <<'PY'
import base64
import pathlib
import struct
import sys

key_path, der_path = map(pathlib.Path, sys.argv[1:])
pem = key_path.read_text(encoding="ascii").splitlines()
blob = base64.b64decode("".join(line for line in pem if not line.startswith("-----")), validate=True)
magic = b"openssh-key-v1\0"
if not blob.startswith(magic):
    raise SystemExit("unexpected OpenSSH private-key format")


def read_u32(data, offset):
    return struct.unpack(">I", data[offset : offset + 4])[0], offset + 4


def read_string(data, offset):
    length, offset = read_u32(data, offset)
    return data[offset : offset + length], offset + length


offset = len(magic)
cipher, offset = read_string(blob, offset)
kdf, offset = read_string(blob, offset)
_, offset = read_string(blob, offset)
key_count, offset = read_u32(blob, offset)
if cipher != b"none" or kdf != b"none" or key_count != 1:
    raise SystemExit("test key must be one unencrypted OpenSSH key")
_, offset = read_string(blob, offset)
private_block, offset = read_string(blob, offset)
private_offset = 8
key_type, private_offset = read_string(private_block, private_offset)
public_key, private_offset = read_string(private_block, private_offset)
private_key, private_offset = read_string(private_block, private_offset)
if key_type != b"ssh-ed25519" or len(public_key) != 32 or len(private_key) != 64:
    raise SystemExit("unexpected Ed25519 test-key encoding")
if private_key[32:] != public_key:
    raise SystemExit("OpenSSH test-key public half does not match")
der_path.write_bytes(bytes.fromhex("302e020100300506032b657004220420") + private_key[:32])
PY

write_release() {
  local build_id=$1 source_commit=$2 archive
  {
    printf 'build_id=%s\n' "$build_id"
    printf 'source_repository=ImpossibleFinance/impossible-hosting\n'
    printf 'source_commit=%s\n' "$source_commit"
    printf 'source_workflow=docker-build\n'
    for archive in "${archives[@]}"; do
      printf 'artifact.%s=%s\n' "$archive" "$(sha256_file "$channel/dl/$archive")"
    done
  } > "$channel/dl/release.txt"
}

sign_release() {
  rm -f "$channel/dl/release.txt.sig" "$channel/dl/release.txt.sshsig"
  ssh-keygen -q -Y sign -f "$test_root/key" -n ifhost-release "$channel/dl/release.txt"
  mv "$channel/dl/release.txt.sig" "$channel/dl/release.txt.sshsig"
}

# write_manifest BUILD_ID [drop:KEY | add:KEY=ARCHIVE | url:KEY=URL ...]
#
# Writes the unsigned /cli/version body the server would sign: the twelve
# download keys in Go's sorted map order, url before sha256. The edits
# reproduce one publisher mistake each.
write_manifest() {
  python3 - "$channel/dl" "$test_root/unsigned.json" "$@" <<'PY'
import hashlib
import json
import pathlib
import sys

root, unsigned_path, build_id = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]


def entry(archive):
    return {
        "url": f"/dl/{archive}?b={build_id}",
        "sha256": hashlib.sha256(root.joinpath(archive).read_bytes()).hexdigest(),
    }


downloads = {}
for family in ["innstance", "ifhost"]:
    for platform in [
        "darwin_amd64",
        "darwin_arm64",
        "linux_amd64",
        "linux_arm64",
        "windows_amd64",
        "windows_arm64",
    ]:
        archive = f"{family}_{platform}" + (".zip" if platform.startswith("windows_") else ".tar.gz")
        key = platform if family == "ifhost" else f"{family}_{platform}"
        downloads[key] = entry(archive)
for edit in sys.argv[4:]:
    action, argument = edit.split(":", 1)
    if action == "drop":
        del downloads[argument]
    elif action == "add":
        key, archive = argument.split("=", 1)
        downloads[key] = entry(archive)
    elif action == "url":
        key, url = argument.split("=", 1)
        downloads[key]["url"] = url
    else:
        raise SystemExit(f"unknown manifest edit: {edit}")
unsigned_path.write_text(
    json.dumps(
        {"build_id": build_id, "downloads": dict(sorted(downloads.items()))},
        separators=(",", ":"),
    ),
    encoding="utf-8",
)
PY
}

sign_manifest() {
  "$openssl_bin" pkeyutl -sign -inkey "$test_root/private.der" -keyform DER -rawin \
    -in "$test_root/unsigned.json" -out "$test_root/signature.bin"
  python3 - "$test_root/unsigned.json" "$test_root/signature.bin" "$channel/cli/version" <<'PY'
import base64
import json
import pathlib
import sys

unsigned_path, signature_path, manifest_path = map(pathlib.Path, sys.argv[1:])
manifest = json.loads(unsigned_path.read_text(encoding="utf-8"))
manifest["signature"] = base64.b64encode(signature_path.read_bytes()).decode("ascii")
manifest_path.write_text(json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8")
PY
}

publish() {
  local build_id=$1 source_commit=$2
  write_release "$build_id" "$source_commit"
  sign_release
  write_manifest "$build_id"
  sign_manifest
}

# edit_release PYTHON_STATEMENTS re-signs the release record after the
# statements have rewritten `lines`, the record without its final newline.
edit_release() {
  python3 - "$channel/dl/release.txt" "$1" <<'PY'
import pathlib
import sys

path, statements = pathlib.Path(sys.argv[1]), sys.argv[2]
lines = path.read_text(encoding="ascii")[:-1].split("\n")
exec(statements)
path.write_text("\n".join(lines) + "\n", encoding="ascii")
PY
  sign_release
}

python3 - "$channel" "$test_root/port" <<'PY' &
import http.server
import os
import pathlib
import sys

root, port_path = sys.argv[1:]
os.chdir(root)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
pathlib.Path(port_path).write_text(str(server.server_port), encoding="ascii")
server.serve_forever()
PY
server_pid=$!
for _ in $(seq 1 100); do
  test -s "$test_root/port" && break
  sleep 0.05
done
test -s "$test_root/port" || { echo "fixture server did not start" >&2; exit 1; }
origin=http://127.0.0.1:$(cat "$test_root/port")

run_verifier() {
  IFHOST_CHANNEL_ALLOW_HTTP=1 OPENSSL_BIN="$openssl_bin" \
    "$verifier" "$origin" "$test_root/release-signers" "$1" "$2" \
    > "$test_root/verifier.out" 2> "$test_root/verifier.err"
}

# accept DESCRIPTION PREVIOUS_STATE NEXT_STATE
accept() {
  local description=$1 previous=$2 next=$3
  run_verifier "$previous" "$next" || {
    echo "channel verifier rejected $description:" >&2
    cat "$test_root/verifier.err" >&2
    exit 1
  }
}

# reject DESCRIPTION REASON PREVIOUS_STATE
#
# The verifier must fail for REASON, not merely fail: a fixture that breaks
# something else first would otherwise pass without testing anything.
reject() {
  local description=$1 reason=$2 previous=$3
  rm -f "$test_root/rejected-state.json"
  if run_verifier "$previous" "$test_root/rejected-state.json"; then
    echo "channel verifier accepted $description" >&2
    exit 1
  fi
  grep -Fq -- "$reason" "$test_root/verifier.err" || {
    echo "channel verifier rejected $description for the wrong reason:" >&2
    cat "$test_root/verifier.err" >&2
    exit 1
  }
  test ! -e "$test_root/rejected-state.json" || {
    echo "channel verifier wrote a state after rejecting $description" >&2
    exit 1
  }
}

same_state() {
  test "$(jq -cS . "$1")" = "$(jq -cS . "$2")" || {
    echo "channel state moved: $(jq -c . "$1") became $(jq -c . "$2")" >&2
    exit 1
  }
}

build_archives 0
legacy_source=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
publish "20260903-010203" "$legacy_source"
legacy_sha=$(sha256_file "$channel/dl/release.txt")
cat > "$test_root/legacy-state.json" <<EOF
{
  "schema": 1,
  "build_id": "20260903-010203",
  "source_commit": "$legacy_source",
  "release_sha256": "$legacy_sha"
}
EOF
accept "the accepted release, observed again" \
  "$test_root/legacy-state.json" "$test_root/legacy-again-state.json"
same_state "$test_root/legacy-state.json" "$test_root/legacy-again-state.json"
grep -Fq "verified server-signed CLI channel 20260903-010203 (12 archives)" "$test_root/verifier.out"

# A newer signed timestamp-only release remains valid during the publisher
# transition, before the channel records its first commit-bound identity.
legacy_advance_source=cccccccccccccccccccccccccccccccccccccccc
publish "20260903-020304" "$legacy_advance_source"
accept "a newer timestamp-only release" \
  "$test_root/legacy-state.json" "$test_root/legacy-advanced-state.json"

current_source=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
publish "20260904-010203-$current_source" "$current_source"
accept "the first commit-bound release" \
  "$test_root/legacy-advanced-state.json" "$test_root/accepted-state.json"
test "$(jq -r .build_id "$test_root/accepted-state.json")" = "20260904-010203-$current_source"

# Once a commit-bound identity is accepted, the channel cannot fall back to
# the legacy timestamp-only format even with a newer signed timestamp.
legacy_fallback_source=cccccccccccccccccccccccccccccccccccccccc
publish "20260905-000000" "$legacy_fallback_source"
reject "a legacy identity after the commit-bound transition" \
  "a new release identity must include its full signed source commit" "$test_root/accepted-state.json"

# A complete, correctly signed older snapshot must not pass once a newer state
# has been accepted.
rollback_source=dddddddddddddddddddddddddddddddddddddddd
publish "20260902-010203-$rollback_source" "$rollback_source"
reject "a whole-snapshot rollback" "release rollback detected" "$test_root/accepted-state.json"

# Even a correctly signed newer snapshot cannot claim a source commit that is
# different from the commit carried in its release identity.
identity_commit=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
claimed_commit=ffffffffffffffffffffffffffffffffffffffff
publish "20260905-010203-$identity_commit" "$claimed_commit"
reject "an unbound source commit" \
  "release identity is not bound to its signed source commit" "$test_root/accepted-state.json"

# The signed record has exactly one shape: four identity fields, then both
# names' digests in the publisher's order. Each case below is otherwise the
# valid next release.
next_source=1111111111111111111111111111111111111111
next_build=20260905-020304-$next_source

publish "$next_build" "$next_source"
edit_release 'lines = [line for line in lines if not line.startswith("artifact.innstance_")]'
reject "the pre-rename record with six digests" \
  "signed release record has 10 fields; expected 16" "$test_root/accepted-state.json"

publish "$next_build" "$next_source"
edit_release 'lines.append("artifact.innstance_freebsd_amd64.tar.gz=" + "0" * 64)'
reject "an extra artifact digest" \
  "signed release record has 17 fields; expected 16" "$test_root/accepted-state.json"

publish "$next_build" "$next_source"
edit_release 'lines[6] = lines[6].replace("linux_amd64", "linux_riscv64")'
reject "a digest for an unknown archive" \
  "signed release line 7 is artifact.innstance_linux_riscv64.tar.gz; expected artifact.innstance_linux_amd64.tar.gz" \
  "$test_root/accepted-state.json"

publish "$next_build" "$next_source"
edit_release 'lines[12] = lines[6]'
reject "a repeated artifact digest" \
  "signed release line 13 is artifact.innstance_linux_amd64.tar.gz; expected artifact.ifhost_linux_amd64.tar.gz" \
  "$test_root/accepted-state.json"

publish "$next_build" "$next_source"
edit_release 'lines = lines[:4] + lines[10:] + lines[4:10]'
reject "the two names' digests in the other order" \
  "signed release line 5 is artifact.ifhost_darwin_amd64.tar.gz; expected artifact.innstance_darwin_amd64.tar.gz" \
  "$test_root/accepted-state.json"

# The update manifest must offer exactly the twelve signed archives, each
# under the key its CLI looks up.
publish "$next_build" "$next_source"
write_manifest "$next_build" drop:innstance_linux_amd64
sign_manifest
reject "an update manifest without an innstance key" \
  "missing ['innstance_linux_amd64'], unexpected none" "$test_root/accepted-state.json"

write_manifest "$next_build" add:freebsd_amd64=ifhost_linux_amd64.tar.gz
sign_manifest
reject "an update manifest with an extra key" \
  "missing none, unexpected ['freebsd_amd64']" "$test_root/accepted-state.json"

write_manifest "$next_build" "url:innstance_linux_amd64=/dl/ifhost_linux_amd64.tar.gz?b=$next_build"
sign_manifest
reject "an innstance key that serves the ifhost archive" \
  "/cli/version has an unexpected URL for innstance_linux_amd64" "$test_root/accepted-state.json"

# Each archive holds one entry named for its family, and both names carry
# the same binary.
build_archives 0 innstance_linux_arm64.tar.gz:member=ifhost
publish "$next_build" "$next_source"
reject "an innstance archive holding the ifhost entry" \
  "unexpected or non-regular entry in innstance_linux_arm64.tar.gz" "$test_root/accepted-state.json"

build_archives 0 ifhost_windows_amd64.zip:member=innstance.exe
publish "$next_build" "$next_source"
reject "an ifhost archive holding the innstance entry" \
  "unexpected files in ifhost_windows_amd64.zip" "$test_root/accepted-state.json"

build_archives 0 ifhost_windows_arm64.zip:payload=-other
publish "$next_build" "$next_source"
reject "different binaries under the two names" \
  "ifhost_windows_arm64.zip carries a different binary from the other windows_arm64 archive" \
  "$test_root/accepted-state.json"

# Digests are checked against the bytes served by the production-shaped URL,
# not merely for agreement between the two signed metadata formats.
build_archives 0
publish "$next_build" "$next_source"
printf tampered >> "$channel/dl/innstance_linux_amd64.tar.gz"
reject "a tampered live archive" \
  "live archive digest mismatch for innstance_linux_amd64.tar.gz" "$test_root/accepted-state.json"

build_archives 0
publish "$next_build" "$next_source"
accept "the well-formed next release" "$test_root/accepted-state.json" "$test_root/next-state.json"
test "$(jq -r .build_id "$test_root/next-state.json")" = "$next_build"

echo "verified the twelve-archive channel fixture, source binding, and rollback rejection"
