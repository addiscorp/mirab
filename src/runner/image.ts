// A runner's image: the base, grown to the job's disk size, plus the runner
// user, apt packages, toolsets and the forge's runner, built once in a VM
// whose only way out is the station (to the hosts the recipe needs) and cached
// under the hash of all of it. Every job boots a copy-on-write clone of it.
import {
  mkdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  BUILD_ENV,
  GROW_ROOT_FS,
  UBUNTU_MIRRORS,
  baseId,
  bootForBuild,
  keep,
  recipeKey,
  run,
} from '../images'
import { startVm, type VmConfig } from '../isolation'
import { newestMacosBase } from '../isolation/macos'
import {
  RUNNER_USER,
  hostRunnerPlatform,
  isDarwin,
  runnerUser,
  type RunnerDefinition,
  type RunnerPlatform,
  type RunnerStep,
} from './define'
import {
  RUST_HOME,
  TOOL_CACHE,
  resolveTools,
  toolEnv,
  toolSteps,
  type Fetcher,
  type ResolvedTool,
  type ByteFetcher,
} from './toolsets'

/** Bump when the build recipe below changes in a way that needs new images. */
const RECIPE_VERSION = 3

export const runnerImagesDir = (configDir: string) =>
  join(configDir, 'runner-images')

export interface RunnerImageMeta {
  key: string
  platform: RunnerPlatform
  forge: { name: string; key: string }
  tools: ResolvedTool[]
  packages: string[]
  diskGiB: number
  /** The toolsets' env, and PATH entries to put first, for every job. */
  env: Record<string, string>
  path: string[]
  builtAt: string
}

export interface RunnerImage {
  rootfs: string
  /** A macOS image: the directory with its disk and platform files. */
  macos?: string
  meta: RunnerImageMeta
}

export interface RunnerRecipe {
  platform: RunnerPlatform
  forge: { name: string; key: string; steps: RunnerStep[]; egress: string[] }
  tools: ResolvedTool[]
  packages: string[]
  diskGiB: number
}

/** Everything that decides an image, resolved: the key is the hash of it. */
export async function runnerRecipe(
  def: RunnerDefinition,
  o: {
    platform?: RunnerPlatform
    fetch?: Fetcher
    fetchBytes?: ByteFetcher
  } = {},
): Promise<RunnerRecipe> {
  const platform = def.platform ?? o.platform ?? hostRunnerPlatform()
  if (isDarwin(platform) && def.image.packages.length)
    throw new Error(
      `${def.name}: image.packages are apt packages, and macOS has no apt`,
    )
  const install = await def.forge.guest.install(platform)
  return {
    platform,
    forge: {
      name: def.forge.name,
      key: install.key,
      steps: install.steps,
      egress: def.forge.guest.buildEgress,
    },
    tools: await resolveTools(def.image.tools, platform, o.fetch, o.fetchBytes),
    // The aws toolset verifies AWS's signature (gnupg) and unpacks a zip.
    packages: [
      ...new Set([
        ...def.image.packages,
        ...(def.image.tools.aws ? ['gnupg', 'unzip'] : []),
      ]),
    ].sort(),
    diskGiB: def.vm.diskGiB,
  }
}

export function runnerImageKey(base: string, r: RunnerRecipe) {
  return recipeKey(base, {
    v: RECIPE_VERSION,
    platform: r.platform,
    forge: { name: r.forge.name, key: r.forge.key },
    tools: r.tools.map((t) => ({
      tool: t.tool,
      version: t.version,
      sha256: t.sha256,
    })),
    packages: r.packages,
    diskGiB: r.diskGiB,
  })
}

/** Xcode's command line tools (compilers, git, make), headless: softwareupdate
 *  offers them while the on-demand marker exists. */
export const XCODE_CLT = [
  'touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress',
  `label=$(softwareupdate -l 2>/dev/null | sed -n 's/^\\* Label: \\(Command Line Tools for Xcode.*\\)$/\\1/p' | tail -1)`,
  'test -n "$label" || { echo "softwareupdate offers no Command Line Tools" >&2; exit 1; }',
  'softwareupdate -i "$label" --agree-to-license',
  'rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress',
  'xcode-select -p',
].join('\n')

/** The build on macOS, as root in the build VM, in order. */
export function darwinBuildSteps(r: RunnerRecipe): RunnerStep[] {
  const u = runnerUser(r.platform)
  return [
    { argv: ['/bin/sh', '-euc', XCODE_CLT] },
    {
      argv: [
        '/bin/sh',
        '-euc',
        [
          `sysadminctl -addUser ${u.name} -UID ${u.uid} -home ${u.home} -shell /bin/zsh -password "$(openssl rand -hex 24)"`,
          `createhomedir -c -u ${u.name} >/dev/null`,
          `printf '%s\\n' '${u.name} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${u.name}`,
          `chmod 0440 /etc/sudoers.d/${u.name}`,
          `mkdir -p ${u.home}/tmp ${TOOL_CACHE}`,
          // A sleeping guest stalls the job it's running.
          'pmset -a sleep 0 disksleep 0 displaysleep 0',
        ].join(' && '),
      ],
    },
    ...toolSteps(r.tools, r.platform),
    ...r.forge.steps,
    {
      argv: [
        '/bin/sh',
        '-euc',
        [
          // By name: sysadminctl may not give the user the UID it was asked
          // for (it made runner 501 on macOS 27).
          `chown -R ${u.name}:staff ${u.home} ${TOOL_CACHE}`,
          r.tools.some((t) => t.tool === 'rust')
            ? `chown -R ${u.name}:staff ${RUST_HOME}`
            : 'true',
          'sync',
        ].join(' && '),
      ],
    },
  ]
}

/** The build, as root in the build VM, in order. */
export function buildSteps(r: RunnerRecipe): RunnerStep[] {
  if (isDarwin(r.platform)) return darwinBuildSteps(r)
  const u = RUNNER_USER
  return [
    { argv: ['sh', '-c', GROW_ROOT_FS] },
    // The base's own /etc/group lacks Ubuntu's standard system groups, and
    // package scripts expect them (fontconfig's postinst chowns to
    // root:staff): restore them before anything is installed.
    {
      argv: [
        'sh',
        '-euc',
        `while IFS=: read -r g _ gid _; do getent group "$g" >/dev/null || groupadd -g "$gid" "$g" 2>/dev/null || groupadd "$g"; done < /usr/share/base-passwd/group.master`,
      ],
    },
    { argv: ['apt-get', 'update'] },
    {
      argv: [
        'apt-get',
        'install',
        '-y',
        '--no-install-recommends',
        ...new Set(['sudo', ...r.packages]),
      ],
    },
    // The base writes /etc/passwd and /etc/group itself; useradd adds the
    // runner (and its group, and a shadow entry sudo's PAM wants). sudo by a
    // sudoers file, not a sudo group the base doesn't have.
    {
      argv: [
        'sh',
        '-euc',
        [
          `useradd -m -d ${u.home} -u ${u.uid} -U -s /bin/bash ${u.name}`,
          `printf '%s\\n' '${u.name} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${u.name}`,
          `chmod 0440 /etc/sudoers.d/${u.name}`,
          `mkdir -p ${u.home}/tmp ${TOOL_CACHE}`,
        ].join(' && '),
      ],
    },
    ...toolSteps(r.tools, r.platform),
    ...r.forge.steps,
    {
      argv: [
        'sh',
        '-euc',
        [
          `chown -R ${u.uid}:${u.uid} ${u.home} ${TOOL_CACHE}`,
          r.tools.some((t) => t.tool === 'rust')
            ? `chown -R ${u.uid}:${u.uid} ${RUST_HOME}`
            : 'true',
          'apt-get clean',
          'rm -rf /var/lib/apt/lists/*',
        ].join(' && '),
      ],
    },
  ]
}

/** The cached image for `r`, if it was built on this base. */
export async function cachedRunnerImage(
  configDir: string,
  key: string,
): Promise<RunnerImage | undefined> {
  const dir = join(runnerImagesDir(configDir), key)
  try {
    const meta = JSON.parse(
      await readFile(join(dir, 'meta.json'), 'utf8'),
    ) as RunnerImageMeta
    if (meta.key !== key) return undefined
    return isDarwin(meta.platform)
      ? { rootfs: join(dir, 'disk.img'), macos: dir, meta }
      : { rootfs: join(dir, 'rootfs.ext4'), meta }
  } catch {
    return undefined
  }
}

/** The runner's image: from the cache, or built now (a few minutes). */
export async function runnerImage(o: {
  configDir: string
  vm: VmConfig
  recipe: RunnerRecipe
  log?: (line: string) => void
}): Promise<RunnerImage> {
  const r = o.recipe
  if (isDarwin(r.platform)) return darwinRunnerImage(o)
  const base = await baseId(o.vm.rootfs)
  const key = runnerImageKey(base, r)
  const hit = await cachedRunnerImage(o.configDir, key)
  if (hit) {
    const now = new Date()
    await utimes(
      join(runnerImagesDir(o.configDir), key, 'meta.json'),
      now,
      now,
    ).catch(() => {})
    return hit
  }
  o.log?.(
    `building runner image ${key.slice(0, 12)}: ${r.forge.name} ${r.forge.key}` +
      (r.tools.length
        ? `, ${r.tools.map((t) => `${t.tool} ${t.version}`).join(', ')}`
        : '') +
      (r.packages.length ? `, apt: ${r.packages.join(' ')}` : ''),
  )
  const dir = join(runnerImagesDir(o.configDir), key)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const allow = [
    ...new Set([
      ...UBUNTU_MIRRORS,
      ...r.tools.flatMap((t) => t.hosts),
      ...r.forge.egress,
    ]),
  ]
  const { iso, cleanup } = await bootForBuild({
    configDir: o.configDir,
    // A Rust toolchain unpacks in memory-hungry steps; the build VM is short-lived.
    vm: { ...o.vm, memoryMiB: Math.max(o.vm.memoryMiB, 2048) },
    rootfs: o.vm.rootfs,
    key,
    allow,
    rootGiB: r.diskGiB,
    log: o.log,
  })
  try {
    for (const step of buildSteps(r))
      await run(iso, step.argv, o.log, { ...BUILD_ENV, ...step.env })
    const { env, path } = toolEnv(r.tools, r.platform)
    const meta: RunnerImageMeta = {
      key,
      platform: r.platform,
      forge: { name: r.forge.name, key: r.forge.key },
      tools: r.tools,
      packages: r.packages,
      diskGiB: r.diskGiB,
      env,
      path,
      builtAt: new Date().toISOString(),
    }
    await keep(iso, dir, meta, { previous: false })
    return { rootfs: join(dir, 'rootfs.ext4'), meta }
  } catch (e) {
    await iso.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
    throw e
  } finally {
    await cleanup()
  }
}

/** A macOS runner image: the host's provisioned macOS base, plus the build
 *  steps run as root by the guest agent, kept as a directory every job clones. */
async function darwinRunnerImage(o: {
  configDir: string
  vm: VmConfig
  recipe: RunnerRecipe
  log?: (line: string) => void
}): Promise<RunnerImage> {
  const r = o.recipe
  const macos = o.vm.macos ?? newestMacosBase(o.configDir)
  if (!macos)
    throw new Error(
      'a darwin-arm64 runner needs a macOS base: run `mirab image pull macos` on this Mac (or name one as vm.macos in <config dir>/isolation.json)',
    )
  const base = await baseId(join(macos, 'disk.img'))
  const key = runnerImageKey(base, r)
  const hit = await cachedRunnerImage(o.configDir, key)
  if (hit) return hit
  o.log?.(
    `building macOS runner image ${key.slice(0, 12)}: ${r.forge.name} ${r.forge.key}` +
      (r.tools.length
        ? `, ${r.tools.map((t) => `${t.tool} ${t.version}`).join(', ')}`
        : ''),
  )
  const dir = join(runnerImagesDir(o.configDir), key)
  const build = `${dir}.build`
  await rm(build, { recursive: true, force: true })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // The build reaches the internet directly through VZ NAT (Apple's update
  // servers, the toolsets, the forge); the vz filter still keeps it off the
  // host, the LAN and the tailnet.
  const iso = await startVm(
    { ...o.vm, memoryMiB: Math.max(o.vm.memoryMiB, 4096), egress: 'allow' },
    null,
    build,
    o.log,
    undefined,
    { listen: [], macos },
  )
  try {
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin' }
    for (const step of darwinBuildSteps(r))
      await run(iso, step.argv, o.log, { ...env, ...step.env })
    await iso.close({
      keepRoot: join(dir, 'disk.img'),
      preserveWorkspace: true,
    })
    // The NVRAM the build left, and the platform files, go with the disk.
    for (const f of ['aux.img', 'hardware-model', 'machine-id'])
      await rename(join(build, 'macos', f), join(dir, f))
    const { env: toolsEnv, path } = toolEnv(r.tools, r.platform)
    const meta: RunnerImageMeta = {
      key,
      platform: r.platform,
      forge: { name: r.forge.name, key: r.forge.key },
      tools: r.tools,
      packages: [],
      diskGiB: r.diskGiB,
      env: toolsEnv,
      path,
      builtAt: new Date().toISOString(),
    }
    await writeFile(
      join(dir, 'meta.json'),
      JSON.stringify(meta, null, 2) + '\n',
    )
    return { rootfs: join(dir, 'disk.img'), macos: dir, meta }
  } catch (e) {
    await iso.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
    throw e
  } finally {
    await rm(build, { recursive: true, force: true })
  }
}
