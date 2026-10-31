import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Isolation } from '../isolation/session'
import { defineRunner, type Forge, type RunnerInput } from './define'
import {
  buildSteps,
  runnerRecipe,
  type RunnerImage,
  type RunnerRecipe,
} from './image'
import {
  admission,
  hostLabel,
  jobEnv,
  redact,
  serveRunners,
  stepArgv,
  type ServeDeps,
} from './serve'

const SECRET = 'S3CRET-one-job-credential-0123456789'

/** A forge that records what it was asked, and a runner step that says when its job starts. */
function fakeForge(o: { ticketFails?: number; queued?: number[] } = {}) {
  const events: string[] = []
  const tickets: Parameters<Forge['ticket']>[0][] = []
  let ticketFails = o.ticketFails ?? 0
  const forge: Forge = {
    name: 'fake',
    async ticket(req) {
      events.push(`ticket ${req.name}`)
      tickets.push(req)
      if (ticketFails-- > 0) throw new Error('forge is down')
      return { name: req.name, secret: { TOKEN: SECRET } }
    },
    guest: {
      install: async () => ({ key: 'fake-runner-1', steps: [] }),
      buildEgress: [],
      job: (t) => ({
        files: [
          {
            path: '/run/mirab/jit',
            mode: 0o600,
            content: t.secret.TOKEN!,
            secret: true,
          },
        ],
        steps: [{ argv: ['/opt/fake/run'], asRoot: true }],
        env: { FAKE_RUNNER: '1' },
      }),
      started: (line) => line.startsWith('Running job:'),
    },
    async reconcile(prefix, live) {
      events.push(`reconcile ${prefix} [${live.join(',')}]`)
    },
  }
  // Answers from a script; the last answer repeats.
  const queued = o.queued
  if (queued)
    forge.queued = async () => {
      events.push('queued')
      return queued.length > 1 ? queued.shift()! : queued[0]!
    }
  return { forge, events, tickets }
}

type Behaviour = 'job' | 'idle' | 'hang' | 'quit'

/** A VM that pretends: exec prints like a runner and behaves as told. */
function fakeVm(events: string[], behaviours: Behaviour[]) {
  let n = 0
  const puts: { path: string; content: string }[] = []
  const execs: {
    argv: string[]
    env: Record<string, string>
    cutLines?: number
  }[] = []
  const start: ServeDeps['startVm'] = async (vm, vmDir) => {
    const id = ++n
    events.push(`boot ${id} ${vm.egress}`)
    const behaviour = behaviours[id - 1] ?? 'idle'
    const iso = {
      put: async (path: string, content: string | Uint8Array) => {
        events.push(`put ${path}`)
        puts.push({ path, content: String(content) })
      },
      exec: async (argv: string[], o: Parameters<Isolation['exec']>[1]) => {
        execs.push({ argv, env: o.env, cutLines: o.cutLines })
        await o.onLine(`token in output: ${SECRET}`)
        if (behaviour === 'job') {
          await o.onLine('Running job: build')
          return 0
        }
        if (behaviour === 'quit') return 0 // gave up before any job, exit 0
        if (behaviour === 'hang') await o.onLine('Running job: build')
        await new Promise<void>((r) =>
          o.signal.addEventListener('abort', () => r()),
        )
        return 130
      },
      close: async () => void events.push(`close ${id}`),
    } as unknown as Isolation
    return iso
  }
  return { start, puts, execs }
}

const image: RunnerImage = {
  rootfs: '/images/k/rootfs.ext4',
  meta: {
    key: 'k',
    platform: 'linux-arm64',
    forge: { name: 'fake', key: 'fake-runner-1' },
    tools: [],
    packages: [],
    diskGiB: 30,
    env: { RUNNER_TOOL_CACHE: '/opt/hostedtoolcache' },
    path: ['/opt/rust/cargo/bin'],
    builtAt: 't',
  },
}
const recipe = { platform: 'linux-arm64' } as RunnerRecipe

async function serve(
  input: Partial<RunnerInput>,
  behaviours: Behaviour[],
  stopWhen: (events: string[]) => boolean,
  forgeOpts: { ticketFails?: number; queued?: number[] } = {},
) {
  await mkdir(resolve('.tmp'), { recursive: true, mode: 0o700 })
  const configDir = await mkdtemp(join(resolve('.tmp'), 'serve-'))
  const { forge, events, tickets } = fakeForge(forgeOpts)
  const vm = fakeVm(events, behaviours)
  const def = defineRunner({ name: 'zeg', forge, ...input })
  const ctl = new AbortController()
  const sleeps: number[] = []
  const logs: string[] = []
  const deps: Partial<ServeDeps> = {
    startVm: vm.start,
    recipe: async () => recipe,
    image: async () => image,
    // Records the wait, then yields to the event loop as a real sleep does:
    // a loop of instant sleeps would starve the timer that stops the test.
    sleep: async (ms) => {
      sleeps.push(ms)
      await new Promise((r) => setTimeout(r, 0))
    },
    minuteMs: 5, // a "minute" is 5 ms here
  }
  const watcher = setInterval(() => {
    if (stopWhen(events)) ctl.abort()
  }, 2)
  try {
    await serveRunners([def], {
      configDir,
      vm: { rootfs: '/base' } as never,
      host: 'simien.local',
      // Fixed, not the machine's: a small CI VM would otherwise lend less
      // than one runner VM and every test would wait for a lease forever.
      budgetMiB: 65536,
      budgetVcpus: 64,
      signal: ctl.signal,
      log: (l) => void logs.push(l),
      deps,
    })
  } finally {
    clearInterval(watcher)
  }
  const state = await readFile(
    join(configDir, 'runners/zeg/state.json'),
    'utf8',
  )
  const logFile = await readFile(
    join(configDir, 'runners/zeg/serve.log'),
    'utf8',
  )
  await rm(configDir, { recursive: true, force: true })
  return { events, tickets, sleeps, logs, state, logFile, vm }
}

describe('serveRunners with a fake forge', () => {
  test("every registration carries mirab-<os>-<arch> first, then the definition's labels, once each", async () => {
    const r = await serve(
      { labels: ['gpu', 'mirab-linux-arm64'] },
      ['job'],
      (e) => e.some((x) => x.startsWith('close')),
    )
    expect(r.tickets[0]!.labels).toEqual(['mirab-linux-arm64', 'gpu'])
    expect(r.tickets[0]!.platform).toBe('linux-arm64')
  })

  test('boots, then mints the ticket, then puts the secret file, then runs; a fresh VM per job', async () => {
    const r = await serve(
      {},
      ['job', 'job'],
      (e) => e.filter((x) => x.startsWith('close')).length >= 2,
    )
    const order = r.events.filter((e) => !e.startsWith('reconcile'))
    expect(order.slice(0, 4)).toEqual([
      'boot 1 allow',
      `ticket ${order[1]!.slice(7)}`,
      'put /run/mirab/jit',
      'close 1',
    ])
    expect(order[0]).toBe('boot 1 allow')
    expect(order[1]).toMatch(/^ticket simien-zeg-[0-9a-f]{6}$/)
    expect(order).toContain('boot 2 allow')
    // Two jobs, two names: a registration is never reused.
    const names = order
      .filter((e) => e.startsWith('ticket'))
      .map((e) => e.split(' ')[1])
    expect(new Set(names).size).toBe(names.length)
    // Stale registrations are swept at start and after every ticketed slot.
    expect(r.events[0]).toBe('reconcile simien-zeg- []')
  })

  test('the one-job secret never reaches the state file or the log', async () => {
    const r = await serve({}, ['job'], (e) => e.includes('close 1'))
    expect(r.vm.puts[0]!.content).toBe(SECRET)
    expect(r.state).not.toContain(SECRET)
    expect(r.logFile).not.toContain(SECRET)
    expect(r.logs.join('\n')).not.toContain(SECRET)
    expect(r.logFile).toContain('token in output: [redacted]')
  })

  test('steps run with the composed env, as plain argv, with long lines cut on the host', async () => {
    const r = await serve({}, ['job'], (e) => e.includes('close 1'))
    const { argv, env, cutLines } = r.vm.execs[0]!
    // No pipeline in the guest to hold output back; asRoot: no setpriv.
    expect(argv).toEqual(['/opt/fake/run'])
    expect(cutLines).toBe(4000)
    expect(env.FAKE_RUNNER).toBe('1')
    expect(env.RUNNER_TOOL_CACHE).toBe('/opt/hostedtoolcache')
    expect(env.PATH!.startsWith('/opt/rust/cargo/bin:')).toBe(true)
    expect(env.TMPDIR).toBe('/home/runner/tmp')
  })

  test('a slot nobody gives a job ends after idleHours and is deregistered', async () => {
    // idleHours 0.01 = 0.6 "minutes" = 3 ms here.
    const r = await serve(
      { pool: { warm: 1, max: 1, idleHours: 0.01 } },
      ['idle', 'job'],
      (e) => e.includes('close 2'),
    )
    expect(r.logs.some((l) => l.includes('no job in 0.01 h, ended'))).toBe(true)
    const afterFirstClose = r.events.slice(r.events.indexOf('close 1'))
    expect(afterFirstClose[1]).toBe('reconcile simien-zeg- []')
  })

  test('a job that hangs is killed at timeoutMinutes, counted from its start', async () => {
    const r = await serve({ timeoutMinutes: 2 }, ['hang', 'job'], (e) =>
      e.includes('close 2'),
    )
    expect(
      r.logs.some((l) => l.includes('job killed at its 2 min limit')),
    ).toBe(true)
    expect(r.events).toContain('close 1')
  })

  test('a runner that exits before taking any job backs off instead of booting VMs in a loop', async () => {
    const r = await serve({}, ['quit', 'quit', 'job'], (e) =>
      e.includes('close 3'),
    )
    expect(r.sleeps.slice(0, 2)).toEqual([10_000, 30_000])
    expect(r.state).toContain('the runner exited before taking a job')
  })

  test('a forge outage backs off, and every booted VM is closed', async () => {
    const r = await serve(
      {},
      ['job', 'job', 'job'],
      (e) => e.includes('close 3'),
      { ticketFails: 2 },
    )
    expect(r.sleeps.slice(0, 2)).toEqual([10_000, 30_000])
    const boots = r.events.filter((e) => e.startsWith('boot')).length
    const closes = r.events.filter((e) => e.startsWith('close')).length
    expect(closes).toBe(boots)
    expect(r.state).toContain('forge is down')
  })
})

describe('runner pieces', () => {
  test("the Linux image restores Ubuntu's standard system groups before adding the runner (package scripts chown to root:staff)", async () => {
    const r = await runnerRecipe(
      defineRunner({ name: 'lx', forge: fakeForge().forge }),
      { platform: 'linux-arm64' },
    )
    const steps = buildSteps(r)
      .map((s) => s.argv.join(' '))
      .join('\n')
    const groups = steps.indexOf('/usr/share/base-passwd/group.master')
    expect(groups).toBeGreaterThan(-1)
    // Before apt installs anything: package scripts need the groups too.
    expect(groups).toBeLessThan(steps.indexOf('apt-get install'))
    expect(groups).toBeLessThan(steps.indexOf('useradd'))
  })

  test('steps drop to the runner user unless asRoot', () => {
    const argv = stepArgv({ argv: ['make', 'test'] })
    expect(argv).toEqual([
      'setpriv',
      '--reuid=1001',
      '--regid=1001',
      '--init-groups',
      'make',
      'test',
    ])
    expect(stepArgv({ argv: ['id'], asRoot: true })).toEqual(['id'])
  })

  test('env: base < image < job < step; PATH puts the toolsets first', () => {
    const def = defineRunner({
      name: 'x',
      forge: fakeForge().forge,
      vm: { vcpus: 4, memoryMiB: 3072, diskGiB: 30 },
    })
    const env = jobEnv(
      def,
      { env: { A: 'image', B: 'image' }, path: ['/t/bin'] },
      { B: 'job', C: 'job' },
      { C: 'step' },
    )
    expect([env.A, env.B, env.C]).toEqual(['image', 'job', 'step'])
    expect(env.CARGO_BUILD_JOBS).toBe('4')
    expect(env.PATH).toBe(
      '/t/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    )
  })

  test('redaction replaces every occurrence of a secret, and ignores short values', () => {
    expect(redact(`a ${SECRET} b ${SECRET}`, [SECRET])).toBe(
      'a [redacted] b [redacted]',
    )
    expect(redact('a 1 b', ['1'])).toBe('a 1 b')
  })

  test('host labels are DNS-safe', () => {
    expect(hostLabel('Simien.local')).toBe('simien')
    expect(hostLabel("Sami's Mac mini")).toBe('sami-s-mac-mini')
  })

  test('admission refuses what the host cannot run safely', async () => {
    const forge = fakeForge().forge
    const d = (name: string, memoryMiB = 3072, diskGiB = 30) =>
      defineRunner({ name, forge, vm: { vcpus: 2, memoryMiB, diskGiB } })
    const ok = {
      configDir: '.',
      budgetMiB: 5120,
      budgetVcpus: 4,
      backend: 'vz' as const,
      filtered: true,
      freeBytes: 400 * 1024 ** 3,
    }
    await admission([d('a')], ok)
    await expect(admission([d('a'), d('a')], ok)).rejects.toThrow(/two runners/)
    await expect(admission([d('a', 6144)], ok)).rejects.toThrow(
      /bigger than this host lends runner VMs \(5120 MiB, 4 vCPUs\)/,
    )
    // Two warm pools hold 6 GiB for good: more than the host lends.
    await expect(admission([d('a'), d('b')], ok)).rejects.toThrow(
      /warm runners hold 6144 MiB/,
    )
    // On demand they share it, one VM at a time: fine.
    const demand = fakeForge({ queued: [0] }).forge
    const lazy = (name: string) =>
      defineRunner({ name, forge: demand, pool: { warm: 0 } })
    await admission([lazy('a'), lazy('b')], ok)
    // On demand needs a forge that can say what's queued.
    await expect(
      admission([defineRunner({ name: 'a', forge, pool: { warm: 0 } })], ok),
    ).rejects.toThrow(/reports queued jobs/)
    await expect(admission([d('a', 3072, 400)], ok)).rejects.toThrow(/disk/)
    await expect(
      admission([d('a')], { ...ok, filtered: false }),
    ).rejects.toThrow(/vm network setup/)
  })

  test('defineRunner: one VM at a time per host until VM-to-VM isolation is proven', () => {
    const forge = fakeForge().forge
    expect(() =>
      defineRunner({
        name: 'a',
        forge,
        pool: { warm: 1, max: 2, idleHours: 1 },
      }),
    ).toThrow(/pool.max/)
    expect(() => defineRunner({ name: 'Bad_Name', forge })).toThrow(/name/)
    expect(() => defineRunner({ name: 'a', forge: {} as Forge })).toThrow(
      /forge/,
    )
    const d = defineRunner({ name: 'a', forge })
    expect([d.vm.diskGiB, d.pool.max, d.timeoutMinutes]).toEqual([30, 1, 90])
    expect(Object.isFrozen(d)).toBe(true)
  })
})

describe('on demand (warm 0) and the host budget', () => {
  test('no VM until the forge reports a job; asked every pollSeconds; one VM for it', async () => {
    const r = await serve(
      { pool: { warm: 0, pollSeconds: 7 } },
      ['job'],
      (e) => e.some((x) => x.startsWith('close')),
      { queued: [0, 0, 1, 0] },
    )
    const order = r.events.filter((e) => !e.startsWith('reconcile'))
    expect(order.slice(0, 4)).toEqual([
      'queued',
      'queued',
      'queued',
      'boot 1 allow',
    ])
    expect(r.sleeps.slice(0, 2)).toEqual([7000, 7000])
    expect(r.state).toContain('"jobs": 1')
  })

  test('a VM booted for a job that went elsewhere ends after waitMinutes, not idleHours', async () => {
    const r = await serve(
      { pool: { warm: 0, waitMinutes: 2, idleHours: 12 } },
      ['idle'],
      (e) => e.some((x) => x.startsWith('close')),
      { queued: [1, 0] },
    )
    expect(r.logs.join('\n')).toMatch(
      /no job in 2 min \(it went elsewhere\), ended/,
    )
  })

  async function twoPools(budgetMiB: number) {
    const configDir = await mkdtemp(join(resolve('.tmp'), 'budget-'))
    const events: string[] = []
    let running = 0
    let most = 0
    let closed = 0
    const ctl = new AbortController()
    const startVm: ServeDeps['startVm'] = async () => {
      most = Math.max(most, ++running)
      return {
        put: async () => {},
        exec: async (_argv: string[], o: Parameters<Isolation['exec']>[1]) => {
          await o.onLine('Running job: build')
          await new Promise((r) => setTimeout(r, 30))
          return 0
        },
        close: async () => {
          running--
          if (++closed >= 4) ctl.abort()
        },
      } as unknown as Isolation
    }
    const pool = (name: string) =>
      defineRunner({
        name,
        forge: fakeForge({ queued: [1] }).forge,
        vm: { vcpus: 2, memoryMiB: 3072, diskGiB: 8 },
        pool: { warm: 0 },
      })
    try {
      await serveRunners([pool('org-a'), pool('org-b')], {
        configDir,
        vm: { rootfs: '/base' } as never,
        host: 'simien',
        budgetMiB,
        budgetVcpus: 8,
        signal: ctl.signal,
        log: (l) => void events.push(l),
        deps: {
          startVm,
          recipe: async () => recipe,
          image: async () => image,
          sleep: () => new Promise((r) => setTimeout(r, 0)),
          minuteMs: 5,
        },
      })
      const host = JSON.parse(
        await readFile(join(configDir, 'runners/host.json'), 'utf8'),
      )
      return { most, host }
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  }

  test('two orgs share the budget: 5 GiB runs their 3 GiB VMs one at a time, 6 GiB two at once', async () => {
    const tight = await twoPools(5120)
    expect(tight.most).toBe(1)
    expect([tight.host.memoryMiB, tight.host.vcpus]).toEqual([5120, 8])
    const roomy = await twoPools(6144)
    expect(roomy.most).toBe(2)
  })
})
