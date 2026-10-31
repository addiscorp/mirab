import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FIRECRACKER_PIN, installFirecracker } from './firecracker-install'

const dir = () => mkdtempSync(join(resolve('.tmp'), 'fc-'))

describe('installFirecracker', () => {
  test('the pin names the release binary with a sha256, and the package ships the pin', () => {
    const name = `firecracker-v${FIRECRACKER_PIN.version}-x86_64`
    expect(FIRECRACKER_PIN.files[name]).toMatch(/^[0-9a-f]{64}$/)
    expect(FIRECRACKER_PIN.sha256).toMatch(/^[0-9a-f]{64}$/)
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    expect(pkg.files).toContain('scripts/firecracker.json')
  })

  test('refuses a tarball whose sha256 is not the pinned one, and installs nothing', async () => {
    if (process.arch !== 'x64') return
    const d = dir()
    const fetcher = (async () =>
      new Response('not firecracker')) as unknown as typeof fetch
    await expect(installFirecracker(d, { fetcher })).rejects.toThrow(
      /not the pinned/,
    )
    expect(() => readFileSync(join(d, 'firecracker'))).toThrow()
  })

  test('a binary already there with the pinned sha256 is kept, with no download', async () => {
    const d = dir()
    const name = `firecracker-v${FIRECRACKER_PIN.version}-x86_64`
    // A stand-in whose hash we make the pin's by patching the pin for this test.
    const bytes = Buffer.from('a firecracker stand-in')
    writeFileSync(join(d, 'firecracker'), bytes)
    chmodSync(join(d, 'firecracker'), 0o755)
    const real = FIRECRACKER_PIN.files[name]
    FIRECRACKER_PIN.files[name] = createHash('sha256')
      .update(bytes)
      .digest('hex')
    try {
      let fetched = false
      const fetcher = (async () => (
        (fetched = true),
        new Response('')
      )) as unknown as typeof fetch
      expect(await installFirecracker(d, { fetcher })).toBe(
        join(d, 'firecracker'),
      )
      expect(fetched).toBe(false)
    } finally {
      FIRECRACKER_PIN.files[name] = real!
    }
  })
})
