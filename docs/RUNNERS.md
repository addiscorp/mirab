# CI runners

A runner takes exactly one CI job in a fresh VM, and the VM is thrown away
afterwards. Nothing runs on the host. mirab knows nothing about any forge: an
adapter (woreda's `github()`; later gild, GitLab, Forgejo) says how to register
for one job and what to run in the VM. Design and review: addiscorp/mirab#59.

```ts
import { defineRunner } from 'mirab'
import { github } from 'woreda'

export default defineRunner({
  name: 'zegadb-arm64',
  forge: github({ scope: 'zegadb', app: { … } }),
  image: { tools: { rust: '1.91.0', node: '24', go: '1.25' }, packages: ['build-essential'] },
  vm: { vcpus: 4, memoryMiB: 3072, diskGiB: 30 },
  pool: { warm: 0 },  // boot a VM when a job is queued
  timeoutMinutes: 90,
})
```

Every runner is labelled `mirab-<os>-<arch>` (`mirab-linux-arm64`,
`mirab-linux-x64`), so a workflow asks for a fresh VM with one label:
`runs-on: mirab-linux-arm64`. `labels` adds more (a forge adapter may add its
own too: woreda's `github()` keeps GitHub's `self-hosted`, `Linux`, `ARM64`).

The host side (`serveRunners`, `runnerImage`) is in `mirab/runner`; woreda's
`woreda serve` runs it.

## What each job gets

- **A fresh VM** from a copy-on-write clone of the runner image: a new disk
  every job, discarded after.
- **Nothing of the host's**: no work share or drive (`startVm(work: null)`), no
  guest-to-host port (`listen: []`).
- **Filtered internet**: the forge, package registries and the internet, but
  not the host, its LAN, the tailnet or link-local. The serve refuses to start
  without the filter (`sudo ~/.mirab/bin/mirab vm network setup` on a Mac).
- **The `runner` user** (uid 1001, passwordless sudo inside the VM), home
  `/home/runner` on the job's disk; `TMPDIR` there too (`/tmp` is RAM).
- **A disk of `diskGiB`**: the most one job can take of the host's disk.
- **Its one-job credential** as a 0600 file on tmpfs, read and removed before
  the runner starts. Inside its own VM a job can read its own runner
  credential (as on GitHub-hosted runners); it is good for that one job, which
  dies with the VM. It is never written to the host's disk and is redacted
  from mirab's log.

## The host's budget, and pools on demand

The host's owner sets what runner VMs may use in all: `budgetMiB` and
`budgetVcpus` (default: the host's RAM minus 3 GiB, and all its CPUs). The rest
stays with the host. Each definition says how big its VM is (`vm.memoryMiB`,
`vm.vcpus`); how many run at once follows from the budget. An 8 GB laptop
lending 4096 MiB runs two 2 GiB VMs, or four 1 GiB VMs, or one 2 GiB and two
1 GiB.

VMs get the budget strictly first come, first served: a big VM at the front
waits for room, and smaller ones behind it wait too, so a big job (a large
Linux pool, later a macOS guest) is never starved by a stream of small ones.

- `pool.warm: 1` keeps one VM booted and registered at all times; it holds its
  share of the budget for good.
- `pool.warm: 0` boots a VM only when the forge reports a queued job this pool
  can take (`Forge.queued`, asked every `pool.pollSeconds`). Pools for many
  orgs can then share one host. A VM whose job went to another runner ends
  after `pool.waitMinutes`.

`<config dir>/runners/host.json` shows the budget, the leases held and the
queue (`HostBudget.snapshot()`).

## Images

The runner image is built once per recipe (base image, the forge's runner
release, resolved toolset versions, packages, disk size) in a VM whose only way
out is the station, to the hosts the recipe needs, and cached under
`<config dir>/runner-images/<key>/`. Toolsets use GitHub's tool-cache layout
(`/opt/hostedtoolcache/<tool>/<version>/<arch>/` + `<arch>.complete`), so
`actions/setup-node` and `setup-go` find them without downloading; Rust is in
`/opt/rust` (rustup). The forge's runner release is looked up again daily, and
a new one is a new image, built between jobs.

## macOS runners (Apple silicon)

A `platform: 'darwin-arm64'` runner boots macOS guests on a Mac with Apple
silicon. Each job gets an APFS clone of a provisioned macOS base, so it starts
from a fresh disk like the Linux ones. Set the base up once per Mac:

    mirab image pull macos

This fetches the newest macOS this Mac can run from Apple (`--ipsw <file>` to
use one you have), installs it into a VM disk, and provisions it, all under
`<config dir>/macos/<version>/`. Provisioning asks for an administrator once,
in the terminal (`sudo`) or with macOS's password dialog, because a fresh macOS
boots into Setup Assistant with nobody logged in: before its first boot the
base gets `/private/var/db/.AppleSetupDone` and mirab's guest agent as a
LaunchDaemon, and launchd only runs a LaunchDaemon owned by root. Both files go
into the VM's disk, never onto the Mac. The helper and agent that run as root
come from mirab's release and are checked against its record first.

`mirab image list` shows the bases (`"kind": "macos"`). A runner uses the
newest one unless `vm.macos` in `<config dir>/isolation.json` names another.
macOS allows two macOS VMs per Mac at a time.

## Not in phase 1

More than one VM at a time per host (until VM-to-VM isolation is proven on
each backend), Docker inside jobs (`container:`/`services:`), dependency
caches, macOS and Windows guests.
