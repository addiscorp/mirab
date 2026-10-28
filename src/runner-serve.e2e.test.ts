// Runners, live: a runner image built in a real VM (the runner user, sudo,
// the disk grown), then serveRunners with a fake forge running two jobs. Each
// job must start on a fresh disk (the first job's file is gone in the second),
// run as the runner user with the one-job secret it was given, and see nothing
// of the host's. Needs $TEST_VM_CONFIG_DIR/isolation.json and the internet
// (Ubuntu's mirrors, for the image build).
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadHostConfig } from './isolation'
import {
  RUNNER_SETPRIV,
  defineRunner,
  runnerImage,
  runnerRecipe,
  serveRunners,
  startRunnerVm,
  type Forge,
} from './runner'

const testConfig = process.env.TEST_VM_CONFIG_DIR
const SECRET = 'e2e-one-job-secret-7f3a9c2b5d1e'
const SECRET_SHA = createHash('sha256').update(SECRET).digest('hex')

const JOB = [
  'echo "Running job: e2e"',
  'echo "uid=$(id -u)"',
  'test -e "$HOME/marker" && echo "disk=reused" || echo "disk=fresh"',
  'touch "$HOME/marker"',
  // Compared by hash, so the secret itself is in no argv.
  `test "$(printf %s "$JOB_SECRET" | sha256sum | cut -c1-64)" = "${SECRET_SHA}" && echo "secret=given"`,
  'test -e /run/mirab/jit && echo "secretfile=left" || echo "secretfile=gone"',
  'grep -q " /workspace " /proc/mounts && echo "workspace=mounted" || echo "workspace=none"',
  'sudo -n true && echo "sudo=ok"',
  'df -B1G --output=size / | tail -1 | tr -d " " | sed "s/^/diskG=/"',
].join('; ')

function e2eForge(): Forge {
  return {
    name: 'e2e',
    ticket: async (req) => ({ name: req.name, secret: { S: SECRET } }),
    guest: {
      install: async () => ({ key: 'e2e-1', steps: [] }),
      buildEgress: [],
      job: (t) => ({
        files: [
          {
            path: '/run/mirab/jit',
            mode: 0o600,
            content: t.secret.S!,
            secret: true,
          },
        ],
        steps: [
          {
            asRoot: true,
            argv: [
              'sh',
              '-c',
              `JOB_SECRET=$(cat /run/mirab/jit); rm -f /run/mirab/jit; export JOB_SECRET; exec ${RUNNER_SETPRIV.join(' ')} sh -c '${JOB}'`,
            ],
          },
        ],
        env: {},
      }),
      started: (line) => line.startsWith('Running job:'),
    },
    reconcile: async () => {},
  }
}

describe.skipIf(!testConfig)('runners, live', () => {
  test('two jobs, each in a fresh VM as the runner user, with its secret and nothing of the host', async () => {
    const host = await loadHostConfig(testConfig!)
    await mkdir(resolve('.tmp'), { recursive: true })
    const configDir = await mkdtemp(join(resolve('.tmp'), 'runners-'))
    const def = defineRunner({
      name: 'e2e',
      forge: e2eForge(),
      vm: { vcpus: 2, memoryMiB: 1024, diskGiB: 8 },
    })
    try {
      const recipe = await runnerRecipe(def)
      const vm = host.vm!
      // Built once, then a cache hit.
      const image = await runnerImage({ configDir, vm, recipe })
      expect((await runnerImage({ configDir, vm, recipe })).meta.key).toBe(
        image.meta.key,
      )

      const lines: string[] = []
      const ctl = new AbortController()
      await serveRunners([def], {
        configDir,
        vm,
        host: 'e2e',
        signal: ctl.signal,
        log: (l) => {
          lines.push(l)
          if (lines.filter((x) => x.includes(': finished')).length >= 2)
            ctl.abort()
        },
        // Serve's own runner VM, without the network (a fake forge needs
        // none); the host's network and budget checks are serve's unit tests.
        deps: {
          startVm: (v, vmDir, l) =>
            startRunnerVm({ ...v, egress: 'block' }, vmDir, l),
        },
      })
      const out = lines.join('\n')
      expect(out.match(/uid=1001/g)).toHaveLength(2)
      expect(out.match(/disk=fresh/g)).toHaveLength(2)
      expect(out).not.toContain('disk=reused')
      expect(out.match(/secret=given/g)).toHaveLength(2)
      expect(out.match(/secretfile=gone/g)).toHaveLength(2)
      expect(out.match(/workspace=none/g)).toHaveLength(2)
      expect(out.match(/sudo=ok/g)).toHaveLength(2)
      expect(out).toMatch(/diskG=8/)
      // The secret was printed by nobody, and is in no file mirab wrote.
      expect(out).not.toContain(SECRET)
      const log = await readFile(
        join(configDir, 'runners/e2e/serve.log'),
        'utf8',
      )
      expect(log).not.toContain(SECRET)
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  }, 900_000)
})
