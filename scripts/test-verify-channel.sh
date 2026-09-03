#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
verifier=$repo_root/scripts/verify-channel.sh
for tool in curl ssh-keygen sha256sum jq python3; do
  command -v "$tool" >/dev/null || { echo "missing required test tool: $tool" >&2; exit 1; }
done
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

python3 - "$channel/dl" <<'PY'
import hashlib
import io
import pathlib
import stat
import sys
import tarfile
import zipfile

root = pathlib.Path(sys.argv[1])
payload = b"#!/bin/sh\nexit 0\n"
archives = [
    "ifhost_darwin_amd64.tar.gz",
    "ifhost_darwin_arm64.tar.gz",
    "ifhost_linux_amd64.tar.gz",
    "ifhost_linux_arm64.tar.gz",
    "ifhost_windows_amd64.zip",
    "ifhost_windows_arm64.zip",
]
for name in archives:
    path = root / name
    if name.endswith(".zip"):
        info = zipfile.ZipInfo("ifhost.exe")
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o755) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(info, payload)
    else:
        info = tarfile.TarInfo("ifhost")
        info.mode = 0o755
        info.mtime = 0
        info.size = len(payload)
        with tarfile.open(path, "w:gz") as archive:
            archive.addfile(info, io.BytesIO(payload))
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    root.joinpath(name + ".sha256").write_text(f"{digest}  {name}\n", encoding="ascii")
PY

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

publish() {
  local build_id=$1 source_commit=$2 archive digest
  {
    printf 'build_id=%s\n' "$build_id"
    printf 'source_repository=ImpossibleFinance/impossible-hosting\n'
    printf 'source_commit=%s\n' "$source_commit"
    printf 'source_workflow=docker-build\n'
    for archive in \
      ifhost_darwin_amd64.tar.gz ifhost_darwin_arm64.tar.gz \
      ifhost_linux_amd64.tar.gz ifhost_linux_arm64.tar.gz \
      ifhost_windows_amd64.zip ifhost_windows_arm64.zip; do
      digest=$(sha256sum "$channel/dl/$archive" | awk '{ print $1 }')
      printf 'artifact.%s=%s\n' "$archive" "$digest"
    done
  } > "$channel/dl/release.txt"
  rm -f "$channel/dl/release.txt.sig" "$channel/dl/release.txt.sshsig"
  ssh-keygen -q -Y sign -f "$test_root/key" -n ifhost-release "$channel/dl/release.txt"
  mv "$channel/dl/release.txt.sig" "$channel/dl/release.txt.sshsig"

  python3 - "$channel/dl" "$build_id" "$test_root/unsigned.json" <<'PY'
import hashlib
import json
import pathlib
import sys

root, build_id, unsigned_path = pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3])
platforms = {
    "darwin_amd64": "ifhost_darwin_amd64.tar.gz",
    "darwin_arm64": "ifhost_darwin_arm64.tar.gz",
    "linux_amd64": "ifhost_linux_amd64.tar.gz",
    "linux_arm64": "ifhost_linux_arm64.tar.gz",
    "windows_amd64": "ifhost_windows_amd64.zip",
    "windows_arm64": "ifhost_windows_arm64.zip",
}
downloads = {
    platform: {
        "url": f"/dl/{name}?b={build_id}",
        "sha256": hashlib.sha256(root.joinpath(name).read_bytes()).hexdigest(),
    }
    for platform, name in sorted(platforms.items())
}
unsigned_path.write_text(
    json.dumps({"build_id": build_id, "downloads": downloads}, separators=(",", ":")),
    encoding="utf-8",
)
PY
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

legacy_source=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
publish "20260903-010203" "$legacy_source"
legacy_sha=$(sha256sum "$channel/dl/release.txt" | awk '{ print $1 }')
cat > "$test_root/previous-state.json" <<EOF
{
  "schema": 1,
  "build_id": "20260903-010203",
  "source_commit": "$legacy_source",
  "release_sha256": "$legacy_sha"
}
EOF
IFHOST_CHANNEL_ALLOW_HTTP=1 OPENSSL_BIN="$openssl_bin" \
  "$verifier" "$origin" "$test_root/release-signers" \
  "$test_root/previous-state.json" "$test_root/legacy-state.json" >/dev/null

# A newer signed timestamp-only release remains valid during the publisher
# transition, before the channel records its first commit-bound identity.
legacy_advance_source=cccccccccccccccccccccccccccccccccccccccc
publish "20260903-020304" "$legacy_advance_source"
IFHOST_CHANNEL_ALLOW_HTTP=1 OPENSSL_BIN="$openssl_bin" \
  "$verifier" "$origin" "$test_root/release-signers" \
  "$test_root/legacy-state.json" "$test_root/legacy-advanced-state.json" >/dev/null

current_source=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
publish "20260904-010203-$current_source" "$current_source"
IFHOST_CHANNEL_ALLOW_HTTP=1 OPENSSL_BIN="$openssl_bin" \
  "$verifier" "$origin" "$test_root/release-signers" \
  "$test_root/legacy-advanced-state.json" "$test_root/accepted-state.json" >/dev/null
test "$(jq -r .build_id "$test_root/accepted-state.json")" = "20260904-010203-$current_source"

# Once a commit-bound identity is accepted, the channel cannot fall back to
# the legacy timestamp-only format even with a newer signed timestamp.
legacy_fallback_source=cccccccccccccccccccccccccccccccccccccccc
publish "20260905-000000" "$legacy_fallback_source"
if IFHOST_CHANNEL_ALLOW_HTTP=1 OPENSSL_BIN="$openssl_bin" \
  "$verifier" "$origin" "$test_root/release-signers" \
  "$test_root/accepted-state.json" "$test_root/rejected-state.json" >/dev/null 2>&1; then
  echo "channel verifier accepted a legacy identity after the commit-bound transition" >&2
  exit 1
fi

# A complete, correctly signed older snapshot must not pass once a newer state
# has been accepted.
rollback_source=dddddddddddddddddddddddddddddddddddddddd
publish "20260902-010203-$rollback_source" "$rollback_source"
if IFHOST_CHANNEL_ALLOW_HTTP=1 OPENSSL_BIN="$openssl_bin" \
  "$verifier" "$origin" "$test_root/release-signers" \
  "$test_root/accepted-state.json" "$test_root/rejected-state.json" >/dev/null 2>&1; then
  echo "channel verifier accepted a whole-snapshot rollback" >&2
  exit 1
fi

# Even a correctly signed newer snapshot cannot claim a source commit that is
# different from the commit carried in its release identity.
identity_commit=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
claimed_commit=ffffffffffffffffffffffffffffffffffffffff
publish "20260905-010203-$identity_commit" "$claimed_commit"
if IFHOST_CHANNEL_ALLOW_HTTP=1 OPENSSL_BIN="$openssl_bin" \
  "$verifier" "$origin" "$test_root/release-signers" \
  "$test_root/accepted-state.json" "$test_root/rejected-state.json" >/dev/null 2>&1; then
  echo "channel verifier accepted an unbound source commit" >&2
  exit 1
fi

# Digests are checked against the bytes served by the production-shaped URL,
# not merely for agreement between the two signed metadata formats.
next_source=1111111111111111111111111111111111111111
publish "20260905-020304-$next_source" "$next_source"
printf tampered >> "$channel/dl/ifhost_linux_amd64.tar.gz"
if IFHOST_CHANNEL_ALLOW_HTTP=1 OPENSSL_BIN="$openssl_bin" \
  "$verifier" "$origin" "$test_root/release-signers" \
  "$test_root/accepted-state.json" "$test_root/rejected-state.json" >/dev/null 2>&1; then
  echo "channel verifier accepted a tampered live archive" >&2
  exit 1
fi

echo "verified live-channel fixture, source binding, and rollback rejection"
