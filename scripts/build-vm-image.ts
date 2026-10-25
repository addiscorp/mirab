// Builds the microVM guest image from this checkout and installs it where the
// CLI looks (<config dir>/vm/, see vmImagePaths). One command, no root:
//   bun run vm:image [--config-dir <dir>]
// Needs Docker with BuildKit (rootfs) and network access (pinned downloads).
// The kernel is mirab's own (guest-agent/kernel-x86_64.config, the same
// compile vz boots on Intel Macs); the rootfs is guest-agent/rootfs.Dockerfile.
// Both come from scripts/build-vm-guest.sh, with the guest agent built from
// this checkout, so it always speaks this checkout's protocol.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { vmImagePaths } from '../src/isolation'
import { GUEST_PROTOCOL } from '../src/isolation/session'
import { buildGuest } from './vm-release'

const ROOT = resolve(import.meta.dir, '..')

function arg(name: string) {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
const configDir = resolve(
  arg('--config-dir') ?? join(homedir(), '.config', 'mirab'),
)
const paths = vmImagePaths(configDir)
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex')
function fail(message: string): never {
  console.error(`vm:image: ${message}`)
  process.exit(1)
}

if (process.platform !== 'linux' || process.arch !== 'x64')
  fail('the Firecracker guest image is x86_64 Linux; build it on that host')
await mkdir(join(configDir, 'vm'), { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(configDir, 'vm', '.build-'))
try {
  // Kernel and rootfs: the one recipe the release uses, then swapped in atomically.
  try {
    buildGuest(work)
  } catch (e) {
    fail((e as Error).message)
  }
  await rename(join(work, 'vmlinux'), paths.kernel)
  await rename(join(work, 'rootfs.ext4'), paths.rootfs)

  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim()
  const manifest = {
    protocol: GUEST_PROTOCOL,
    agent: /^version = "(.+)"$/m.exec(
      readFileSync(join(ROOT, 'guest-agent/Cargo.toml'), 'utf8'),
    )?.[1],
    commit,
    kernel: {
      path: paths.kernel,
      sha256: sha256(await readFile(paths.kernel)),
    },
    rootfs: {
      path: paths.rootfs,
      sha256: sha256(await readFile(paths.rootfs)),
    },
    built: new Date().toISOString(),
  }
  await writeFile(
    join(configDir, 'vm', 'image.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )

  // isolation.json: enable `vm` with the default paths unless the owner set it up already.
  const isolation = join(configDir, 'isolation.json')
  const current = existsSync(isolation)
    ? JSON.parse(await readFile(isolation, 'utf8'))
    : {}
  if (!current.vm) {
    current.vm = {}
    await writeFile(isolation, JSON.stringify(current, null, 2) + '\n')
    console.error(`vm:image: enabled vm in ${isolation}`)
  } else
    for (const key of ['kernel', 'rootfs'] as const)
      if (current.vm[key] && resolve(current.vm[key]) !== paths[key])
        console.error(
          `vm:image: note: ${isolation} sets vm.${key} to ${current.vm[key]}; remove it to use ${paths[key]}`,
        )
  console.log(JSON.stringify(manifest, null, 2))
} finally {
  await rm(work, { recursive: true, force: true })
}
