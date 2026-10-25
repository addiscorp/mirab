#!/bin/sh
# Build the microVM guest without root on the host, entirely inside docker
# (Colima on macOS), for the docker host's architecture:
#   <out>/mirab-guest-agent   static musl guest agent (guest-agent/)
#   <out>/rootfs.ext4         guest-agent/rootfs.Dockerfile as an ext4 image
#   <out>/Image               arm64: the vz guest kernel (guest-agent/kernel-arm64-vz.config)
#   <out>/bzImage, vmlinux    x86_64: one kernel (guest-agent/kernel-x86_64.config),
#                             bzImage for vz on Intel Macs, vmlinux for Firecracker
# Each stage is skipped when its output exists; delete the file to rebuild it.
# Files go in and out with `docker cp`, never a bind mount: Colima only shares
# $HOME with its VM, and a checkout can live anywhere.
#   scripts/build-vm-guest.sh <out> [rootfs size, default 3G]
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
size=${2:-3G}
# The guest kernel is part of each mirab release: one version, pinned by the
# SHA-256 kernel.org publishes (sha256sums.asc), changed only with mirab.
kernel=6.12.112
kernel_sha256=164dc9d1f6c93c61a15e1f071c48379b467f2b17c469cce7223471968208ed03
tag="mirab-guest-$$"
src=''
cleanup() {
  docker rm -f "$tag-agent" "$tag-kernel" >/dev/null 2>&1 || true
  [ -z "$src" ] || rm -rf "$src"
  rm -f "$out/mirab-guest-agent.part" "$out/rootfs.ext4.part" "$out/Image.part" "$out/bzImage.part" "$out/vmlinux.part"
}
trap cleanup EXIT INT TERM

# Runs <script> in a new container of <image> named <name>, after copying
# each <src>:<dest> pair in; the container is kept for `docker cp` out.
run_in() {
  name=$1 image=$2 script=$3
  shift 3
  docker create --name "$name" "$image" sh -euc "$script" >/dev/null
  for pair in "$@"; do docker cp "${pair%%:*}" "$name:${pair#*:}"; done
  docker start -a "$name"
}

if [ ! -s "$out/mirab-guest-agent" ]; then
  # The agent compiles in src/isolation/guest-protocol.json, so it needs both.
  src=$(mktemp -d "${TMPDIR:-/tmp}/mirab-guest-src.XXXXXX")
  mkdir -p "$src/src/isolation" "$src/guest-agent"
  cp -R "$here/guest-agent/Cargo.toml" "$here/guest-agent/Cargo.lock" "$here/guest-agent/src" "$src/guest-agent/"
  cp "$here/src/isolation/guest-protocol.json" "$src/src/isolation/"
  run_in "$tag-agent" rust:1-alpine '
    apk add -q musl-dev
    CARGO_TARGET_DIR=/build cargo build -q --release --locked --manifest-path /src/guest-agent/Cargo.toml
    cp /build/release/mirab-guest-agent /mirab-guest-agent' "$src/.:/src"
  docker cp "$tag-agent:/mirab-guest-agent" "$out/mirab-guest-agent.part"
  mv "$out/mirab-guest-agent.part" "$out/mirab-guest-agent"
  rm -rf "$src"
  src=''
fi
file "$out/mirab-guest-agent"

if [ ! -s "$out/rootfs.ext4" ]; then
  ctx="$out/rootfs-context"
  mkdir -p "$ctx"
  cp "$here/guest-agent/rootfs.Dockerfile" "$ctx/Dockerfile"
  cp "$here/guest-agent/init-mirab.sh" "$out/mirab-guest-agent" "$ctx/"
  docker build -q -t mirab-vm-rootfs "$ctx" >/dev/null
  cid=$(docker create mirab-vm-rootfs)
  # The filesystem goes in on stdin and the image comes out on stdout as a
  # sparse tar (GNU tar -S), so the mostly empty image stays sparse on the host.
  docker export "$cid" | docker run --rm -i alpine:3 sh -euc "
    apk add -q e2fsprogs tar >&2
    mkdir /r && tar -x -C /r
    printf '127.0.0.1 localhost\n::1 localhost\n' > /r/etc/hosts
    printf 'nameserver 1.1.1.1\n' > /r/etc/resolv.conf
    truncate -s $size /rootfs.ext4.part
    # Fixed UUID, hash seed and filesystem timestamps.
    E2FSPROGS_FAKE_TIME=0 mke2fs -q -t ext4 -L mirab-root -U 6b1d0b9e-3f1a-4c5e-9a57-67696c64766d \\
      -E hash_seed=6b1d0b9e-3f1a-4c5e-9a57-67696c64766d,root_owner=0:0 -d /r -F /rootfs.ext4.part >&2
    tar -cSf - -C / rootfs.ext4.part" | tar -xSf - -C "$out"
  docker rm -f "$cid" >/dev/null
  mv "$out/rootfs.ext4.part" "$out/rootfs.ext4"
fi
ls -l "$out/rootfs.ext4"

case "$(docker info --format '{{.Architecture}}')" in
  aarch64) arch=arm64 config=kernel-arm64-vz.config image=arch/arm64/boot/Image file=Image also='' ;;
  x86_64) arch=x86_64 config=kernel-x86_64.config image=arch/x86/boot/bzImage file=bzImage also=vmlinux ;;
  *) arch='' ;;
esac
if [ -n "$arch" ] && { [ ! -s "$out/$file" ] || { [ -n "$also" ] && [ ! -s "$out/$also" ]; }; }; then
  run_in "$tag-kernel" debian:trixie-slim "
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      build-essential flex bison bc curl xz-utils ca-certificates libelf-dev >/dev/null
    cd /root && curl -fsSL -o linux.tar.xz https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$kernel.tar.xz
    echo '$kernel_sha256  linux.tar.xz' | sha256sum -c - >/dev/null
    tar -xJf linux.tar.xz
    cd linux-$kernel
    KCONFIG_ALLCONFIG=/kernel.config make -s ARCH=$arch allnoconfig
    missing=''
    for o in \$(grep -o '^CONFIG_[A-Z0-9_]*=y' /kernel.config | cut -d= -f1); do
      grep -q \"^\$o=y\" .config || missing=\"\$missing \$o\"
    done
    [ -z \"\$missing\" ] || { echo \"kernel config: did not stick:\$missing\" >&2; exit 1; }
    make -s ARCH=$arch -j\$(nproc) $(basename $image) $also
    cp .config /kernel.built.config
    cp $image /kernel.out
    # The same compile's ELF image, for Firecracker.
    if [ -n '$also' ]; then cp $also /kernel.also; fi" "$here/guest-agent/$config:/kernel.config"
  docker cp "$tag-kernel:/kernel.built.config" "$out/$file.config"
  if [ -n "$also" ]; then
    docker cp "$tag-kernel:/kernel.also" "$out/$also.part"
    mv "$out/$also.part" "$out/$also"
  fi
  docker cp "$tag-kernel:/kernel.out" "$out/$file.part"
  mv "$out/$file.part" "$out/$file"
fi
ls -l "$out"
