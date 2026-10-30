// A runner's image: the base, grown to the job's disk size, plus the runner
// user, apt packages, toolsets and the forge's runner, built once in a VM
// whose only way out is the station (to the hosts the recipe needs) and cached
// under the hash of all of it. Every job boots a copy-on-write clone of it.
import { mkdir, readFile, rm, utimes } from 'node:fs/promises'
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
import type { VmConfig } from '../isolation'
import {
  RUNNER_USER,
  hostRunnerPlatform,
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
} from './toolsets'

/** Bump when the build recipe below changes in a way that needs new images. */
const RECIPE_VERSION = 2

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
  o: { platform?: RunnerPlatform; fetch?: Fetcher } = {},
): Promise<RunnerRecipe> {
  const platform = o.platform ?? hostRunnerPlatform()
  const install = await def.forge.guest.install(platform)
  return {
    platform,
    forge: {
      name: def.forge.name,
      key: install.key,
      steps: install.steps,
      egress: def.forge.guest.buildEgress,
    },
    tools: await resolveTools(def.image.tools, platform, o.fetch),
    packages: [...new Set(def.image.packages)].sort(),
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

/** The build, as root in the build VM, in order. */
export function buildSteps(r: RunnerRecipe): RunnerStep[] {
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
    return { rootfs: join(dir, 'rootfs.ext4'), meta }
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
