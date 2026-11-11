# microVM guest image

`mirab spawn --vm`, agent sessions and CI runners (docs/RUNNERS.md) boot a microVM from a
kernel and a read-only ext4 root filesystem holding `mirab-guest-agent` and
`/init-mirab.sh`. All of it comes out of this repository.

Which VM `--vm` uses:

| host | backend |
|---|---|
| Linux x64 | Firecracker (on `PATH`, below) |
| macOS, Windows | Multipass: not yet in mirab (its VM installs mirab from npm, where mirab isn't published); `--vm` refuses with that reason |
| macOS with a `vm` block in `<config dir>/isolation.json` | Virtualization.framework (`vz`), the guest image below |

## Firecracker (Linux x64)

gild shipped Firecracker inside its npm platform package. mirab has no npm
package yet, so install Firecracker v1.17.0 yourself (`scripts/firecracker.json`
pins the version and sha256 gild used).

mirab runs, in this order: `vm.firecracker` from `isolation.json`, the
`firecracker` next to the mirab executable, then `firecracker` on `PATH`. The
host still needs `/dev/kvm` (read and write for your user) and `mke2fs`
(e2fsprogs).

## Network, git and getting work out

A Firecracker guest has **no network device** until the owner runs, once,
from the installed binary:

```sh
sudo mirab vm network setup --user <name>   # the user whose VMs use it
mirab vm network status
```

It creates a `mirabbr0` bridge and `--slots` (default 16) tap devices owned by
that user and isolated from each other, with nftables rules that allow the
internet and deny the host, the LAN, the tailnet and metadata addresses. The
rules load before any device exists. A systemd unit (`mirab-vm-network`)
recreates it all at boot; `sudo mirab vm network remove` undoes it, and
`--dry-run` prints every file and command first. It needs iproute2, nftables
and systemd. On NixOS, `/etc` comes from the configuration, so enable it
declaratively instead. Until then `mirab spawn --vm` says so:

```
mirab: vm network: none, egress blocked (no mirabbr0 bridge; enable with: sudo mirab vm network setup --user <you>)
```

A `vz` guest on a Mac is the same: no network device until the owner runs,
once, from the installed binary:

```sh
sudo ~/.mirab/bin/mirab vm network setup --dry-run   # what it writes and runs
sudo ~/.mirab/bin/mirab vm network setup
mirab vm network status
```

It writes a pf anchor (the internet passes; the Mac, its LAN, the tailnet,
link-local and multicast don't), checks it with `pfctl -n`, loads it from a
LaunchDaemon that runs only `/sbin/pfctl`, and writes the root-owned marker
`/etc/mirab/vz-network.json` that mirab reads. `sudo ~/.mirab/bin/mirab vm
network remove` undoes all of it.

So on Linux the agent **edits in the VM and the host commits and pushes**:

- The working directory, `.git` included, is copied into the guest at
  `/workspace`. Git works there (mirab sets `safe.directory=/workspace` for the
  guest, whose files keep your uid while the agent runs as root), so the agent
  can diff, branch and commit locally.
- File changes come back to the host at exit and with `mirab sync <id>`,
  three-way against what was copied in; a file you changed on the host
  meanwhile is kept and the guest's copy saved aside.
- Changes under `.git` never come back (host Git metadata is protected): a
  commit made in the guest stays in the guest, and the session keeps its VM
  workspace for recovery (`~/.mirab/sessions/<id>.vm-*`, `recovery.json`) and
  exits nonzero. Have the agent leave its changes uncommitted, then commit,
  push and open the pull request on the host (`mirab pr create … --agent <label>`).
- No token, mirab key or `mirab` binary enters a Firecracker guest; the clone's
  credential helper points at the host's mirab and is not usable inside.

Multipass (macOS and Windows) is not available in mirab yet: gild copied the
agent's key and token into that VM, which mirab won't do, and its VM installs
mirab from npm, where mirab isn't published. `--vm` refuses with that reason.

## Published images (nothing to build)

Every release publishes the guest image for each VM platform next to the CLI
binaries on `https://mirab-releases.addis.gg` (`<releases>`), built by
`.github/workflows/release.yml` on our release runners:

| platform | files | built on |
|---|---|---|
| `linux-x64` (Firecracker) | `vmlinux`, `rootfs.ext4` | `host-linux-x64`: `bun scripts/vm-release.ts build x64` (one kernel compile gives this `vmlinux` and darwin-x64's `bzImage`) |
| `darwin-x64` (vz) | `bzImage`, `rootfs.ext4`, `mirab-vz` | the same x64 build; `host-macos-x64`: `scripts/build-vz-helper.sh` (ad hoc signed) |
| `darwin-arm64` (vz) | `Image`, `rootfs.ext4`, `mirab-vz`, `mirab-guest-agent` | `host-macos-arm64`: `bun scripts/vm-release.ts build arm64` (Colima), `scripts/build-vz-helper.sh`, the macOS guest agent |

```
<releases>/<version>/vm/manifest.json         version, guest protocol, commit, sha256 of every file
<releases>/<version>/vm/<platform>/<name>.gz
```

`<version>` has no `v`: `0.2.1-canary-b0b093c` for a canary, `0.2.1` once
promoted.

Every canary publishes them, and a promotion (`.github/workflows/promote.yml`)
copies the canary's `vm/` to the stable `<version>/vm/` unchanged, with the
manifest rewritten to name the stable version. To follow the latest stable,
read `version` from `<releases>/latest.json` and fetch
`<releases>/<version>/vm/manifest.json`; check every file against its sha256.

On first VM use (`--vm`, `--isolation vm`, a job or host default asking for
`vm`) mirab downloads the image for its own version and platform into
`~/.config/mirab/vm/`, showing progress. It refuses a manifest for another mirab
version or guest protocol, and any file whose sha256 (gzipped or unpacked) is
not the manifest's; nothing is replaced until every file checks out, and
`vm/image.json` records what was installed. Later runs use it offline. At
boot the guest agent handshake below checks the protocol again.

When the image cannot be fetched (offline, no image for this version or
platform), `mirab spawn --vm` fails with the reason, since it never runs an
agent on the host; `mirab runner` falls to the next tier the floor allows
(`container`, then `host`, never `none`) and says so in its log line:

```
isolation: container (oci), requested by flag (vm image unavailable, fell back to container: could not fetch …)
```

Nothing is downloaded when isolation.json points `vm` at your own kernel and
rootfs, when `vm/image.json` is a local build (`bun run vm:image`), or when
the host cannot run the backend anyway (no Firecracker, `/dev/kvm` or
`mke2fs`; a Mac without a hypervisor). Firecracker comes with the Linux x64
package (above).

## Build it yourself

On an x86_64 Linux host with `/dev/kvm`, Firecracker (the bundled one or your
own), `mke2fs` and Docker
(BuildKit), from a checkout of the mirab version you run:

```sh
bun run vm:image                         # writes ~/.config/mirab/vm/
bun run vm:image --config-dir <dir>      # or another mirab config directory
```

It writes:

| file | what |
|---|---|
| `vm/vmlinux` | mirab's kernel (Linux 6.12.112, `guest-agent/kernel-x86_64.config`, with Landlock and seccomp filters for sandboxes in the guest): the same compile Intel Macs boot as `bzImage` under vz |
| `vm/rootfs.ext4` | `guest-agent/rootfs.Dockerfile` (one recipe for every platform): Ubuntu 24.04 with bash, git, curl, python3, ripgrep, Node 24, Bun and Claude Code (pinned by sha256), plus the guest agent compiled from this checkout |
| `vm/image.json` | protocol, agent version, commit and sha256 of both files |

and, if `isolation.json` has no `vm` block yet, adds `"vm": {}`. With no
`kernel`/`rootfs` in that block, mirab uses `vm/vmlinux` and `vm/rootfs.ext4`.
If the block names other files, the script says so and leaves it alone.

The mke2fs step uses a fixed UUID, hash seed and timestamp, so the same tree
packs to the same bytes; apt packages still follow the Ubuntu mirror.

## macOS (`vz`)

Used when `<config dir>/isolation.json` has a `vm` block; without one, `--vm`
on macOS refuses (Multipass is not available in mirab yet). The
Virtualization.framework backend boots a guest built for the Mac's own
architecture by `scripts/build-vm-guest.sh <dir>` (docker or Colima): an arm64
`Image` on Apple silicon, an x86_64 `bzImage` on Intel Macs. It compiles the
same guest agent from this checkout, so the handshake below applies to both.

On an Intel Mac (proven on a 2020 iMac, i9, macOS 26):

```sh
scripts/build-vz-helper.sh <bin>/mirab-vz            # x86_64, ad hoc signed; prints ok
scripts/build-vm-guest.sh <dir>                       # mirab-guest-agent, rootfs.ext4, bzImage
```

```json
{ "vm": { "vz": "<bin>/mirab-vz", "kernel": "<dir>/bzImage", "rootfs": "<dir>/rootfs.ext4" } }
```

The x86_64 kernel must be relocatable (`CONFIG_RELOCATABLE`, in
`guest-agent/kernel-x86_64.config`): the framework places the kernel itself,
and one built for a fixed address fails with "Internal Virtualization error"
before it runs. Paths in `isolation.json` are absolute (`~` is not expanded).
The build script copies files in and out of docker instead of mounting them,
because Colima only shares `$HOME` with its VM.

## Version handshake

Automatic sync protects host Git metadata and retains incomplete work instead
of deleting it at exit. See [the support and recovery matrix](ISOLATION-SUPPORT.md)
for the current interactive-mode gaps and real-agent rehearsal requirements.

The CLI and the guest agent share one protocol number,
`src/isolation/guest-protocol.json` (the agent compiles it in). On boot the
host (Firecracker or vz) pings the agent; the reply carries the agent's protocol and version, and
any difference stops the VM before the session starts:

```
--vm failed: The guest image /home/me/.config/mirab/vm/rootfs.ext4 is outdated:
its mirab-guest-agent (no version, before 0.2.0) speaks protocol 1, this mirab
needs 2. Rebuild the guest image from a mirab checkout at this version:
`bun run vm:image` (docs/VM.md).
```

Bump the number with any new guest op. Protocol 1 was ping, pty, put and
exec; protocol 2 added list and get (`mirab sync`).

## Live VM tests

The tests that boot real VMs (`src/**/*.e2e.test.ts`) run the same way on
both backends: point `TEST_VM_CONFIG_DIR` at a config directory whose
`isolation.json` has a `vm` block (vz on a Mac, Firecracker on Linux).

```sh
TEST_VM_CONFIG_DIR=<dir> bun test src/dev.e2e.test.ts src/dev-sync.e2e.test.ts
```

CI runs them under Firecracker on Linux (`.github/workflows/ci.yml`, job
`vm-linux`), with the guest built from the checkout.
