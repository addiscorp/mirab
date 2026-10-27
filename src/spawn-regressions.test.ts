import { expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnWorkerSource } from './spawn-bundle'

for (const scenario of [
  'native-env',
  'native-interrupt',
  'no-node',
  'no-addon',
  'pty-failure',
  'windows',
]) {
  test(`spawn regression: ${scenario}`, async () => {
    await mkdir('.tmp', { recursive: true })
    const worker = resolve('.tmp/regression-worker.mjs')
    // The worker exactly as mirab ships it.
    await writeFile(worker, await spawnWorkerSource())
    const proc = Bun.spawn(
      ['python3', 'scripts/fixtures/spawn-regressions.py', scenario],
      {
        env: {
          ...process.env,
          TEST_MIRAB_COMMAND:
            process.env.TEST_MIRAB_COMMAND ??
            JSON.stringify([process.execPath, 'run', resolve('src/mirab.ts')]),
          TEST_NODE: Bun.which('node')!,
          TEST_WORKER: worker,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect({ code, err }).toEqual({ code: 0, err: '' })
    expect(JSON.parse(out)).toEqual({ case: scenario, passed: true })
  }, 15000)
}
