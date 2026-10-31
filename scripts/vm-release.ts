// The published microVM guest images (src/isolation/image.ts reads them), all
// from the one recipe (guest-agent/rootfs.Dockerfile via
// scripts/build-vm-guest.sh). The release workflow builds each architecture on
// its own runner, gzips the files, and the publish job writes the manifest:
//
//   bun scripts/vm-release.ts build x64 <out>     linux-x64 (vmlinux) and darwin-x64
//                                                 (bzImage): one kernel, one rootfs
//   bun scripts/vm-release.ts build arm64 <out>   darwin-arm64 (Image, arm64 rootfs)
//   scripts/build-vz-helper.sh                    mirab-vz for each Mac (macOS)
//   gzip -n <out>/<platform>/*                    what is uploaded
//   bun scripts/vm-release.ts manifest <vm dir>   <vm dir>/manifest.json from <vm dir>/<platform>/*.gz
//
// `bun run vm:image` (scripts/build-vm-image.ts) builds the guest with the
// same recipe for a local install.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import pkg from '../package.json'
import {
  VM_PLATFORMS,
  vmManifestSchema,
  type VmFileEntry,
  type VmManifest,
  type VmPlatform,
} from '../src/isolation/image'
import { GUEST_PROTOCOL } from '../src/isolation/session'

const ROOT = resolve(import.meta.dir, '..')

function run(argv: string[], env: Record<string, string> = {}) {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (r.status !== 0)
    throw new Error(`${argv.join(' ')} exited ${r.status ?? r.signal}`)
}

/** The guest from the one recipe, into `<work>`: rootfs.ext4, the guest
 *  agent, and mirab's kernel for this architecture (Image on arm64; bzImage
 *  and vmlinux from one x86_64 compile). */
export function buildGuest(work: string) {
  run(['sh', join(ROOT, 'scripts/build-vm-guest.sh'), work])
}

/** Every platform's image this runner's architecture builds. */
async function build(arch: 'x64' | 'arm64', out: string) {
  // Linux with Docker, or a Mac whose Docker (Colima) runs this architecture.
  const docker = spawnSync(
    'docker',
    ['info', '--format', '{{.Architecture}}'],
    {
      encoding: 'utf8',
    },
  ).stdout.trim()
  const want = arch === 'x64' ? 'x86_64' : 'aarch64'
  if (docker !== want)
    throw new Error(
      `the ${arch} images build with a ${want} Docker (this one: ${docker || 'none'})`,
    )
  const work = join(out, '.guest')
  buildGuest(work)
  const take = async (platform: VmPlatform, name: string, from: string) => {
    await mkdir(join(out, platform), { recursive: true })
    if (!existsSync(join(work, from)))
      throw new Error(`build-vm-guest.sh produced no ${from}`)
    // GNU cp keeps the rootfs sparse; on a Mac, an APFS clone does.
    run([
      'cp',
      process.platform === 'darwin' ? '-c' : '--sparse=always',
      join(work, from),
      join(out, platform, name),
    ])
  }
  if (arch === 'x64') {
    await take('linux-x64', 'vmlinux', 'vmlinux')
    await take('linux-x64', 'rootfs.ext4', 'rootfs.ext4')
    await take('darwin-x64', 'bzImage', 'bzImage')
    await take('darwin-x64', 'rootfs.ext4', 'rootfs.ext4')
  } else {
    await take('darwin-arm64', 'Image', 'Image')
    await take('darwin-arm64', 'rootfs.ext4', 'rootfs.ext4')
  }
}

async function digest(path: string): Promise<VmFileEntry> {
  const packed = createHash('sha256'),
    unpacked = createHash('sha256')
  let unpackedSize = 0
  const tap = (hash: ReturnType<typeof createHash>, count?: true) =>
    new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk)
        if (count) unpackedSize += chunk.length
        done(null, chunk)
      },
    })
  const sink = new Transform({ transform: (_c, _e, done) => done() })
  sink.resume()
  await pipeline(
    createReadStream(path),
    tap(packed),
    createGunzip(),
    tap(unpacked, true),
    sink,
  )
  return {
    file: '',
    sha256: packed.digest('hex'),
    size: (await stat(path)).size,
    unpacked: { sha256: unpacked.digest('hex'), size: unpackedSize },
  }
}

/** `<dir>/manifest.json` for every complete platform under `<dir>`; refuses a partial one. */
export async function writeVmManifest(
  dir: string,
  o: { version?: string; commit?: string; require?: VmPlatform[] } = {},
): Promise<VmManifest> {
  const platforms: Record<string, Record<string, VmFileEntry>> = {}
  for (const [platform, roles] of Object.entries(VM_PLATFORMS)) {
    if (!existsSync(join(dir, platform))) {
      if (o.require?.includes(platform as VmPlatform))
        throw new Error(`no ${platform} image under ${dir}`)
      continue
    }
    platforms[platform] = {}
    for (const [role, name] of Object.entries(roles)) {
      const file = `${platform}/${name}.gz`
      if (!existsSync(join(dir, file)))
        throw new Error(`${platform} image is missing ${file}`)
      platforms[platform][role] = { ...(await digest(join(dir, file))), file }
    }
  }
  const manifest = vmManifestSchema.parse({
    version: o.version ?? pkg.version,
    protocol: GUEST_PROTOCOL,
    commit:
      o.commit ??
      spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).stdout.trim(),
    platforms,
  })
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  return manifest
}

if (import.meta.main) {
  const [command, a, b] = process.argv.slice(2)
  try {
    if (command === 'build' && b && (a === 'x64' || a === 'arm64'))
      await build(a, resolve(b))
    else if (command === 'manifest' && a)
      console.log(
        JSON.stringify(
          await writeVmManifest(resolve(a), {
            // The release this manifest belongs to (its directory's name).
            version: b,
            require: Object.keys(VM_PLATFORMS) as VmPlatform[],
          }),
          null,
          2,
        ),
      )
    else
      throw new Error(
        'usage: vm-release.ts build <x64|arm64> <out> | manifest <vm dir> [release]',
      )
  } catch (e) {
    console.error(`vm-release: ${(e as Error).message}`)
    process.exit(1)
  }
}
