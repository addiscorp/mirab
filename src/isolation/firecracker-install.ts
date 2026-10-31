// Installs the Firecracker release mirab is pinned to (scripts/firecracker.json)
// for a host that runs VMs without the npm package next to it: woreda's Linux
// service install calls this. The tarball and the binary are both checked
// against the pinned sha256 before the binary is put in place.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pin from '../../scripts/firecracker.json'

export const FIRECRACKER_PIN = pin as {
  version: string
  tarball: string
  sha256: string
  files: Record<string, string>
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** `<dir>/firecracker`, the pinned release; a matching one already there is kept. */
export async function installFirecracker(
  dir: string,
  o: { fetcher?: typeof fetch; log?: (line: string) => void } = {},
): Promise<string> {
  const log = o.log ?? (() => {})
  const name = `firecracker-v${FIRECRACKER_PIN.version}-x86_64`
  const want = FIRECRACKER_PIN.files[name]
  if (!want) throw new Error(`scripts/firecracker.json names no ${name}`)
  const dest = join(dir, 'firecracker')
  if (existsSync(dest) && sha(readFileSync(dest)) === want) return dest
  if (process.arch !== 'x64')
    throw new Error(
      `Firecracker ${FIRECRACKER_PIN.version} is pinned for x86_64 hosts; this one is ${process.arch}`,
    )
  log(`downloading Firecracker ${FIRECRACKER_PIN.version}`)
  const res = await (o.fetcher ?? fetch)(FIRECRACKER_PIN.tarball)
  if (!res.ok)
    throw new Error(
      `could not fetch ${FIRECRACKER_PIN.tarball}: HTTP ${res.status}`,
    )
  const tgz = new Uint8Array(await res.arrayBuffer())
  if (sha(tgz) !== FIRECRACKER_PIN.sha256)
    throw new Error(
      `refusing ${FIRECRACKER_PIN.tarball}: its sha256 is not the pinned ${FIRECRACKER_PIN.sha256}`,
    )
  await mkdir(dir, { recursive: true, mode: 0o755 })
  const work = await mkdtemp(join(dir, '.firecracker-'))
  try {
    await writeFile(join(work, 'fc.tgz'), tgz)
    const member = `release-v${FIRECRACKER_PIN.version}-x86_64/${name}`
    const r = spawnSync('tar', [
      '-xzf',
      join(work, 'fc.tgz'),
      '-C',
      work,
      member,
    ])
    if (r.status !== 0)
      throw new Error(`could not unpack ${member}: ${String(r.stderr).trim()}`)
    const bin = join(work, member)
    if (sha(readFileSync(bin)) !== want)
      throw new Error(
        `refusing ${member}: its sha256 is not the pinned ${want}`,
      )
    chmodSync(bin, 0o755)
    renameSync(bin, dest)
    return dest
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
