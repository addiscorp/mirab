#!/bin/sh
# One platform's mirab, as the release ships it:
#   scripts/package.sh <linux-x64|darwin-x64|darwin-arm64> <release> <out dir>
# <out>/mirab-<platform>.tar.gz holds
#   bin/mirab          the command (a launcher)
#   libexec/bun        Bun, pinned by sha256 (scripts/bun.json)
#   libexec/firecracker  Linux only, pinned by sha256 (scripts/firecracker.json)
#   lib/               mirab's source, release.json and node_modules
# Needs bun, curl, unzip and tar on the build machine.
set -eu
platform=$1 release=$2 out=$3
here=$(cd "$(dirname "$0")/.." && pwd)
stage="$out/mirab-$platform"
case "$platform" in linux-x64|darwin-x64|darwin-arm64) ;; *) echo "no such platform: $platform" >&2; exit 1 ;; esac
rm -rf "$stage" && mkdir -p "$stage/bin" "$stage/libexec" "$stage/lib"
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
field() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval('d'+sys.argv[2]))" "$1" "$2"; }

# mirab itself: the tracked source, and which release this is.
(cd "$here" && git archive --format=tar HEAD package.json bun.lock tsconfig.json src) | tar -xf - -C "$stage/lib"
commit=$(cd "$here" && git rev-parse HEAD)
printf '{\n  "version": "%s",\n  "platform": "%s",\n  "commit": "%s"\n}\n' "$release" "$platform" "$commit" > "$stage/lib/release.json"
# Its modules (node-pty carries prebuilt binaries for every platform).
(cd "$stage/lib" && bun install --production --frozen-lockfile --ignore-scripts >/dev/null)

# Bun, pinned.
bun_version=$(field "$here/scripts/bun.json" "['version']")
zip=$(field "$here/scripts/bun.json" "['zips']['$platform']['name']")
want=$(field "$here/scripts/bun.json" "['zips']['$platform']['sha256']")
curl -fsSL -o "$out/$zip.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/$zip.zip"
[ "$(sha "$out/$zip.zip")" = "$want" ] || { echo "bun $zip.zip does not match its pinned sha256" >&2; exit 1; }
unzip -p "$out/$zip.zip" "$zip/bun" > "$stage/libexec/bun" && chmod 755 "$stage/libexec/bun"
rm "$out/$zip.zip"

# Firecracker on Linux, pinned; mirab looks for it next to Bun (firecracker.ts).
if [ "$platform" = linux-x64 ]; then
  url=$(field "$here/scripts/firecracker.json" "['tarball']")
  want=$(field "$here/scripts/firecracker.json" "['sha256']")
  version=$(field "$here/scripts/firecracker.json" "['version']")
  curl -fsSL -o "$out/firecracker.tgz" "$url"
  [ "$(sha "$out/firecracker.tgz")" = "$want" ] || { echo "firecracker does not match its pinned sha256" >&2; exit 1; }
  tar -xzf "$out/firecracker.tgz" -C "$out" "release-v$version-x86_64/firecracker-v$version-x86_64"
  mv "$out/release-v$version-x86_64/firecracker-v$version-x86_64" "$stage/libexec/firecracker"
  chmod 755 "$stage/libexec/firecracker" && rm -rf "$out/firecracker.tgz" "$out/release-v$version-x86_64"
fi

# The command: Bun running mirab, wherever the install lives (symlinks followed).
cat > "$stage/bin/mirab" <<'SH'
#!/bin/sh
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
root=$(cd "$(dirname "$self")/.." && pwd -P)
exec "$root/libexec/bun" "$root/lib/src/mirab.ts" "$@"
SH
chmod 755 "$stage/bin/mirab"
tar -czf "$out/mirab-$platform.tar.gz" -C "$out" "mirab-$platform"
echo "$out/mirab-$platform.tar.gz"
