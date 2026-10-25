# Guest root filesystem for the microVM backends, any architecture (the
# docker host's). Same package set and layout as the Firecracker image
# (blue.git build-ubuntu.sh): Ubuntu 24.04, ca-certificates, git, iproute2,
# unzip, bun, node, claude, the runtime user, /workspace; plus python3 (fixture
# agents), busybox (udhcpc for NAT networking) and the tools agent CLIs expect
# (bash, ripgrep, ssh, procps). One recipe for every platform, vz and
# Firecracker alike.
# scripts/build-vm-guest.sh turns it into an ext4 image without root on the host.
FROM ubuntu:24.04
ARG BUN_VERSION=1.4.3
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates git iproute2 unzip curl python3 busybox-static \
    bash less openssh-client procps ripgrep xz-utils \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
# Pinned: the station's TLS checks rely on this Bun (1.4 sends no
# encrypted ClientHello). Digests from the release's SHASUMS256.txt.
ARG BUN_SHA256_X64=3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18
ARG BUN_SHA256_AARCH64=efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21
RUN arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/aarch64/') \
 && case "$arch" in x64) sum=$BUN_SHA256_X64 ;; aarch64) sum=$BUN_SHA256_AARCH64 ;; *) echo "no pinned bun for $arch" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${arch}.zip" \
 && echo "$sum  /tmp/bun.zip" | sha256sum -c - \
 && unzip -p /tmp/bun.zip "*/bun" > /usr/local/bin/bun && chmod 755 /usr/local/bin/bun && rm /tmp/bun.zip
# Node, for agent CLIs that ship on npm. Digests from the release's SHASUMS256.txt.
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256_X64=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
ARG NODE_SHA256_ARM64=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
RUN arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') \
 && case "$arch" in x64) sum=$NODE_SHA256_X64 ;; arm64) sum=$NODE_SHA256_ARM64 ;; *) echo "no pinned node for $arch" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
 && echo "$sum  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' \
 && rm /tmp/node.tar.xz
# Claude Code, pinned like Bun: agents run it on the person's own subscription,
# its token added by the station on the way out (never in the VM). Digests from
# the release's manifest.json.
ARG CLAUDE_CODE_VERSION=2.1.310
ARG CLAUDE_SHA256_X64=b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56
ARG CLAUDE_SHA256_ARM64=9c64d9a7442436b65fcd7cc02c1aa0051bb5a7041e7788576ed3b5f29c447d54
RUN arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') \
 && case "$arch" in x64) sum=$CLAUDE_SHA256_X64 ;; arm64) sum=$CLAUDE_SHA256_ARM64 ;; *) echo "no pinned claude for $arch" >&2; exit 1 ;; esac \
 && curl -fsSL -o /usr/local/bin/claude "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/linux-${arch}/claude" \
 && echo "$sum  /usr/local/bin/claude" | sha256sum -c - \
 && chmod 755 /usr/local/bin/claude
# _apt is apt's own user: downloads run as it, not root.
RUN printf 'root:x:0:0:root:/root:/bin/sh\nruntime:x:1000:1000:mirab runtime:/workspace:/bin/sh\n_apt:x:42:65534::/nonexistent:/usr/sbin/nologin\n' > /etc/passwd \
 && printf 'root:x:0:\nruntime:x:1000:\nnogroup:x:65534:\n' > /etc/group \
 && mkdir -p /workspace /artifacts /toolchain \
 && printf '[safe]\n\tdirectory = *\n' > /etc/gitconfig
COPY init-mirab.sh /init-mirab.sh
COPY mirab-guest-agent /usr/local/bin/mirab-guest-agent
RUN chmod 755 /init-mirab.sh /usr/local/bin/mirab-guest-agent
