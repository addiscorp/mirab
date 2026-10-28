// Runner toolsets, live and opt-in (TEST_RUNNER_TOOLS=1; a few minutes and
// ~2 GB of downloads): Rust, Node and Go resolved on the host, fetched through
// the station by curl and rustup (not only apt), checksum-checked, installed
// in the tool-cache layout, and usable by the runner user in a job VM.
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadHostConfig } from './isolation'
import type { Isolation } from './isolation/session'
import {
  defineRunner,
  jobEnv,
  runnerImage,
  runnerRecipe,
  startRunnerVm,
  stepArgv,
  type Forge,
} from './runner'

const testConfig = process.env.TEST_RUNNER_TOOLS
  ? process.env.TEST_VM_CONFIG_DIR
  : undefined

const noForge: Forge = {
  name: 'none',
  ticket: async (r) => ({ name: r.name, secret: {} }),
  guest: {
    install: async () => ({ key: 'none', steps: [] }),
    buildEgress: [],
    job: () => ({ files: [], steps: [], env: {} }),
    started: () => false,
  },
  reconcile: async () => {},
}

describe.skipIf(!testConfig)('runner toolsets, live', () => {
  test('rust, node and go in the image, on PATH for the runner user', async () => {
    const host = await loadHostConfig(testConfig!)
    await mkdir(resolve('.tmp'), { recursive: true })
    const configDir = await mkdtemp(join(resolve('.tmp'), 'tools-'))
    const def = defineRunner({
      name: 'tools',
      forge: noForge,
      image: { tools: { rust: '1.91.0', node: '24', go: '1.25' } },
      vm: { vcpus: 2, memoryMiB: 2048, diskGiB: 16 },
    })
    const lines: string[] = []
    try {
      const recipe = await runnerRecipe(def)
      const image = await runnerImage({
        configDir,
        vm: host.vm!,
        recipe,
        log: (l) => void lines.push(l),
      })
      const node = recipe.tools.find((t) => t.tool === 'node')!
      const go = recipe.tools.find((t) => t.tool === 'go')!
      const iso: Isolation = await startRunnerVm(
        { ...host.vm!, rootfs: image.rootfs, egress: 'block' },
        join(configDir, 'vm'),
        () => {},
      )
      try {
        const out: string[] = []
        const code = await iso.exec(
          stepArgv({
            argv: [
              'sh',
              '-c',
              'id -un; rustc --version; cargo --version; cargo clippy --version; node --version; go version; ls /opt/hostedtoolcache/node /opt/hostedtoolcache/go; ls /opt/hostedtoolcache/node/*/',
            ],
          }),
          {
            cwd: '/home/runner',
            env: jobEnv(def, image.meta, {}),
            timeoutMs: 120_000,
            signal: new AbortController().signal,
            onLine: async (l) => void out.push(l),
          },
        )
        const text = out.join('\n')
        expect(code).toBe(0)
        expect(text).toContain('runner')
        expect(text).toMatch(/rustc 1\.91\.0/)
        expect(text).toMatch(/cargo 1\.91\.0/)
        expect(text).toMatch(/clippy/)
        expect(text).toContain(`v${node.version}`)
        expect(text).toContain(`go${go.version}`)
        expect(text).toMatch(/\.complete/)
      } finally {
        await iso.close()
      }
    } catch (e) {
      console.error(lines.slice(-30).join('\n'))
      throw e
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  }, 1_800_000)
})
