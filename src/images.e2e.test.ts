// Agent images in a real VM: the manifest's packages installed with apt on
// the base image, through the station (Ubuntu's mirrors only, over HTTPS),
// cached, booted, and updated by booting it again. Needs a Mac with a vz guest
// image described in $TEST_VZ_CONFIG_DIR/isolation.json (docs/VM.md), and the
// internet for Ubuntu's mirrors.
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadHostConfig, startVm } from './isolation'
import type { Isolation } from './isolation/session'
import {
  agentImage,
  cachedImage,
  imageKey,
  baseId,
  updateImage,
} from './images'

const testConfig = process.env.TEST_VZ_CONFIG_DIR

async function sh(iso: Isolation, cmd: string) {
  const lines: string[] = []
  const code = await iso.exec(['sh', '-c', cmd], {
    cwd: '/',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    onLine: async (l) => void lines.push(l),
  })
  return { code, out: lines.join('\n') }
}

describe.skipIf(!testConfig)('agent images in a vz VM, live', () => {
  test(
    'packages are installed once, cached, booted, and updated by booting the image',
    async () => {
      const host = await loadHostConfig(testConfig!)
      const vm = host.vm!
      await mkdir(resolve('.tmp'), { recursive: true })
      const base = await mkdtemp(join(resolve('.tmp'), 'images-'))
      const configDir = join(base, 'config')
      const work = join(base, 'work')
      await mkdir(work, { recursive: true })
      const boot = (rootfs: string, n: string) =>
        startVm({ ...vm, rootfs, egress: 'block' }, work, join(base, n))
      try {
        const t0 = Date.now()
        const rootfs = await agentImage({ configDir, vm, packages: ['jq'] })
        const built = Date.now() - t0
        // The image has jq; the base doesn't.
        const agent = await boot(rootfs, 'a')
        expect((await sh(agent, 'jq --version')).out).toMatch(/^jq-1\./)
        await agent.close()
        const plain = await boot(vm.rootfs, 'b')
        expect((await sh(plain, 'command -v jq || echo none')).out).toBe('none')
        await plain.close()
        // The second time it's the cache: no VM, no apt.
        const t1 = Date.now()
        expect(
          await agentImage({ configDir, vm, packages: ['jq', 'jq'] }),
        ).toBe(rootfs)
        expect(Date.now() - t1).toBeLessThan(Math.min(2000, built))
        const key = imageKey(await baseId(vm.rootfs), ['jq'])
        expect((await cachedImage(configDir, key))!.meta.packages).toEqual([
          'jq',
        ])
        // apt reached Ubuntu's mirrors through the station, and nothing else.
        const audit = await readFile(join(configDir, 'egress.log'), 'utf8')
        const hosts = [...audit.matchAll(/"host":"([^"]+)"/g)].map((m) => m[1])
        expect(hosts.length).toBeGreaterThan(0)
        expect(hosts.every((h) => h.endsWith('ubuntu.com'))).toBe(true)
        // An update boots the image and upgrades it when apt has anything newer;
        // the image before stays as the previous one.
        const { rootfs: after, upgraded } = await updateImage({
          configDir,
          vm,
          packages: ['jq'],
        })
        expect(after).toBe(rootfs)
        if (upgraded.length)
          expect(
            existsSync(join(configDir, 'images', key, 'previous.rootfs.ext4')),
          ).toBe(true)
        const again = await boot(after, 'c')
        expect((await sh(again, 'jq --version')).out).toMatch(/^jq-1\./)
        // Nothing left to upgrade right after an update.
        expect((await sh(again, 'true')).code).toBe(0)
        await again.close()
        const second = await updateImage({ configDir, vm, packages: ['jq'] })
        expect(second.upgraded).toEqual([])
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    },
    30 * 60_000,
  )
})
