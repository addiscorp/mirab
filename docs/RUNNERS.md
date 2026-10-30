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
  pool: { warm: 1, max: 1, idleHours: 12 },
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

## Images

The runner image is built once per recipe (base image, the forge's runner
release, resolved toolset versions, packages, disk size) in a VM whose only way
out is the station, to the hosts the recipe needs, and cached under
`<config dir>/runner-images/<key>/`. Toolsets use GitHub's tool-cache layout
(`/opt/hostedtoolcache/<tool>/<version>/<arch>/` + `<arch>.complete`), so
`actions/setup-node` and `setup-go` find them without downloading; Rust is in
`/opt/rust` (rustup). The forge's runner release is looked up again daily, and
a new one is a new image, built between jobs.

## Not in phase 1

More than one VM at a time per host (until VM-to-VM isolation is proven on
each backend), Docker inside jobs (`container:`/`services:`), dependency
caches, macOS and Windows guests.
