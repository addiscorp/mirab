# Changelog

What changed in each mirab release, written so that code using mirab can be
updated from this file alone. One `## X.Y.Z` section per base version: its
canaries (`X.Y.Z-canary-<sha>`) carry the section as it stands at their
commit, and promoting `X.Y.Z` to stable publishes it as the release notes
(`.github/workflows/promote.yml` refuses a missing or empty section).

Each section has up to five parts, and each entry names the CLI command,
library export (`mirab`, `mirab/runner`, `mirab/tools`), config key or file
involved:

- **Breaking**: what changed, who it affects, and the exact change to make,
  with before and after;
- **Changed**: behaviour that changed without breaking anything;
- **Added**;
- **Fixed**;
- **Upgrade notes**: the steps in order, and anything to re-run.

Every pull request that changes what mirab ships (`src/`, `guest-agent/`,
`scripts/`, `vz/`, `install.sh`, `types/`) adds its entry under the current
version; CI checks it (`scripts/changelog.ts check`), and the `no-changelog`
label skips the check for CI-only or docs-only changes. The version bump PR
opens the next section.

## 0.2.1

### Breaking

- **Setup hints in errors and constants name the installed binary, not the
  checkout's script.** Affects code that matches on mirab's error text or on
  these library constants; code that only prints them needs nothing.
  - `NETWORK_SETUP` (`src/isolation/container.ts`) and `SETUP_COMMAND`
    (`src/isolation/network.ts`) are now typed `string`, not a string literal,
    and their value depends on `$USER`:
    ```diff
    - "sudo scripts/vm-network-setup.sh"
    + "sudo mirab vm network setup --user <$USER, or <name> when unset>"
    ```
  - Fix hints in errors start with `To fix:` (host user tier, Colima mounts,
    the `mirab-egress` container network, a missing Colima) or
    `set it up with:` (VM network, vz network filter) instead of
    `Needs Sami:`:
    ```diff
    - egress is set to allow but the VM network is not set up (…). Needs Sami: sudo scripts/vm-network-setup.sh
    + egress is set to allow but the VM network is not set up (…). set it up with: sudo mirab vm network setup --user <name>
    ```
    Match on the reason before the hint, not on the hint.
- **License: MIT** (was Apache-2.0; APS 17). `LICENSE` and `package.json`'s
  `license` changed. Nothing to change in code; update any license inventory
  that lists mirab.

### Changed

- **Seccomp filters set inside a guest now take effect** (PR #91, #89). The
  x86_64 guest kernel (`guest-agent/kernel-x86_64.config`, Firecracker's
  `vmlinux` and the Intel-Mac vz `bzImage`) has `CONFIG_SECCOMP` and
  `CONFIG_SECCOMP_FILTER`: Docker's default profile, systemd's
  `SystemCallFilter=` and Chromium's sandbox now apply in a guest, as on a
  stock Ubuntu kernel. A guest program that set a filter and relied on it
  being ignored now gets the filter. Before, `/proc/self/status` had no
  `Seccomp:` line; now it reads `Seccomp: 0` until a filter is set. The arm64
  vz kernel (`Image`) is unchanged.
- The `vm network` commands describe both platforms: `mirab vm network setup
  | remove | status` work on Linux as well as macOS (see Added).
- Release builds run on our own runners (`ci-release` group:
  `host-linux-x64`, `host-macos-x64`, `host-macos-arm64`); pull request CI
  stays on GitHub-hosted runners. No change to what is published.

### Added

- **`sudo mirab vm network setup --user <name> [--slots N] [--dry-run]` on
  Linux**, from the installed binary (was `sudo scripts/vm-network-setup.sh`
  from a checkout). It writes `/etc/mirab/vm-network.nft` (table
  `inet mirab_vm`), `/usr/local/libexec/mirab-vm-network`,
  `/etc/systemd/system/mirab-vm-network.service` and
  `/etc/sysctl.d/90-mirab-vm.conf`, then brings up bridge `mirabbr0`
  (172.31.250.1/24) and `--slots` (default 16) isolated tap devices owned by
  `<name>`. Guests reach the internet, never the host, the LAN, the tailnet
  (100.64/10), link-local or each other. `sudo mirab vm network remove`
  undoes it; `mirab vm network status` reports it. It refuses on NixOS
  (`/etc` comes from the configuration: enable it declaratively).
- `mirab/runner` exports, for a forge adapter's Linux service install:
  `setupLinuxNetwork`, `removeLinuxNetwork` (the command above as functions;
  options `{ user?, slots?, dryRun?, log? }`), `FIRECRACKER_PIN` (the
  contents of `scripts/firecracker.json`) and `installFirecracker(dir, { fetcher?, log? })`,
  which puts the pinned Firecracker at `<dir>/firecracker` and keeps a
  matching one. The npm package now ships `scripts/firecracker.json`.
- **An `aws` runner toolset**: `defineRunner({ image: { tools: { aws: '2' } } })`
  (`'2'`, `'2.31'` or `'2.31.20'`; Linux images) installs AWS CLI v2 at
  `/usr/local/bin/aws`, its download checked against AWS's signing key
  (fingerprint `FB5DB77FD5C118B80511ADA8A6310ACC4672475C`, pinned in
  `src/runner/aws-key.ts`) and
  adds `gnupg` and `unzip` to the image's packages. `ResolvedTool['tool']`
  gains `'aws'`; `runnerRecipe(def, { fetchBytes })` and
  `resolveTools(tools, platform, fetch, fetchBytes)` take a byte fetcher for
  the signature.
- **Landlock in the x86_64 guest kernel** (PR #91): `CONFIG_SECURITY`,
  `CONFIG_SECURITYFS`, `CONFIG_SECURITY_LANDLOCK`, `CONFIG_LSM="landlock"`.
  `landlock_restrict_self` works in a guest (gelada), and
  `/sys/kernel/security/lsm` lists `capability,landlock` once securityfs is
  mounted. Landlock does nothing until a program asks for it.
- **`CONFIG_VMGENID` in the x86_64 guest kernel** (PR #91): the guest reseeds
  its random number generator after a Firecracker snapshot restore (the
  driver binds Firecracker's `VMGENCTR` device).
- `scripts/firecracker.json` lists the jailer's sha256
  (`jailer-v1.17.0-x86_64`), for consumers that run the jailer (PR #91).

### Fixed

- **Stable releases carry the guest images** (PR #91). Promoting a canary now
  copies its `vm/` to `<X.Y.Z>/vm/` (same bytes, each checked against the
  canary's manifest) with `vm/manifest.json` naming `X.Y.Z`, and reads every
  file back before `latest.json` moves. Before, stable 0.2.0 had no
  `0.2.0/vm/manifest.json`, so the npm library at a stable version could not
  fetch its VM image. To follow the latest stable: read `version` from
  `https://mirab-releases.addis.gg/latest.json`, then fetch
  `<version>/vm/manifest.json`. New: `bun scripts/vm-release.ts promote`.
- The `aws` toolset checks its install by full path (`/usr/local/bin/aws
  --version`): runner build steps run with a minimal `PATH`.

### Upgrade notes

1. Install 0.2.1: `curl -fsSL https://mirab-releases.addis.gg/install.sh | sh`,
   or `npm install mirab@0.2.1` for the library.
2. Linux hosts that ran `sudo scripts/vm-network-setup.sh`: run
   `sudo mirab vm network setup --user <the user whose VMs use it>` once,
   then `mirab vm network status`. Without it, Firecracker guests have no
   network device (`mirab spawn --vm` says so).
3. The guest image is fetched again on first VM use (it is per release): no
   step needed. A hand-built image (`bun run vm:image`) is never replaced;
   rebuild it from a 0.2.1 checkout to get the new kernel.
4. Code matching mirab's setup hints: see Breaking.

## 0.2.0

The first release on `mirab-releases.addis.gg` and npm (`mirab`), brought
over from gild with its history.

- Agents in VMs on your own machine: `mirab init`, `mirab spawn --vm`,
  `mirab dev` (the agent in its own VM, live sync and sync-back), Claude Code
  in a VM on the person's own subscription.
- VM backends: Firecracker on Linux x64, Virtualization.framework (`vz`) on
  Apple silicon and Intel Macs, one mirab kernel (Linux 6.12) and one rootfs
  recipe; published guest images per release, fetched and verified on first
  use. macOS guests on Apple silicon (`mirab image pull macos`).
- The way out of a VM is the station: a domain whitelist, model routes and
  keys from harar swapped in on each key's own host (the VM holds
  placeholders), escalation asked of a person outside the VM, rixse's gateway.
- Agent images (`packages`, built once, cached, updated by booting) and
  `mirab image list | prune`.
- CI runners (`mirab/runner`): `defineRunner`, one job per fresh VM,
  forge-neutral, `mirab-<os>-<arch>` labels, a host budget and on-demand
  pools; rust, node and go toolsets.
- `mirab vm network setup` for vz on macOS (a pf anchor).
- Releases: nightly canaries, promoted to stable with the same bytes; the npm
  library follows each release.
