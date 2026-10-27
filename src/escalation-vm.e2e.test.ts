// Escalation in a real VM: a host the whitelist refuses is asked for, a person
// allows it outside the VM while the session runs, and the VM's next try goes
// through. Needs a VM guest image described in
// $TEST_VM_CONFIG_DIR/isolation.json (docs/VM.md), and the internet.
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadHostConfig } from './isolation'
import { startVmChild } from './spawn-vm'
import { allow, asks } from 'rixse'

const configDir = process.env.TEST_VM_CONFIG_DIR

describe.skipIf(!configDir)('escalation in a VM, live', () => {
  test('refused, asked for, allowed outside the VM, then reached', async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const base = await mkdtemp(join(resolve('.tmp'), 'escalation-vm-'))
    const work = join(base, 'work')
    await mkdir(work)
    // The station's own state (asks, allow files) in a config directory of its
    // own; the VM settings come from the test's.
    const config = join(base, 'config')
    await mkdir(config)
    // As the test's config resolves them: its default paths are relative to
    // its own directory (`vm: {}` from `bun run vm:image`).
    const { vm } = await loadHostConfig(configDir!)
    await Bun.write(join(config, 'isolation.json'), JSON.stringify({ vm }))
    const script = [
      'try() { curl -s -o /dev/null -w "%{http_code}" --max-time 15 -x http://127.0.0.1:8790 https://registry.npmjs.org/ || echo "-$?"; }',
      'echo first=$(try)',
      // Waits for the go-ahead after the person's answer, outside the VM.
      'read go',
      'echo second=$(try)',
    ].join('; ')
    const child = await startVmChild({
      configDir: config,
      sessionId: 'escalation-e2e',
      cwd: work,
      binary: 'sh',
      args: ['-c', script],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' },
      cols: 120,
      rows: 30,
      station: {
        config: { harar: { socket: '/nonexistent' }, models: {} },
        auditLog: join(base, 'egress.log'),
      },
    })
    let screen = ''
    child.onData((d) => (screen += d.toString()))
    const exited = new Promise<number>((r) =>
      child.onExit(({ exitCode }) => r(exitCode)),
    )
    try {
      for (let i = 0; i < 300 && !screen.includes('first='); i++)
        await Bun.sleep(100)
      expect(screen).toContain('first=')
      expect(screen).not.toContain('first=200')
      const asked = asks(config)
      expect(asked.map((a) => a.host)).toEqual(['registry.npmjs.org'])
      // The person's yes, on the host; then the VM tries again.
      allow(config, asked[0].agent, 'registry.npmjs.org')
      child.write('\r')
      for (let i = 0; i < 300 && !screen.includes('second='); i++)
        await Bun.sleep(100)
      expect(screen).toContain('second=200')
      expect(await exited).toBe(0)
    } finally {
      await child.dispose().catch(() => {})
      await rm(base, { recursive: true, force: true })
    }
  }, 180_000)
})
