import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { liveSync } from './dev-sync'
import type { Entry } from './isolation/session'
import { hostManifest } from './isolation/sync'

function project() {
  mkdirSync(resolve('.tmp'), { recursive: true })
  const dir = mkdtempSync(join(resolve('.tmp'), 'live-'))
  mkdirSync(join(dir, 'agent'))
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, 'agent/instructions.md'), 'v1\n')
  writeFileSync(join(dir, 'notes.md'), 'mine\n')
  writeFileSync(join(dir, 'old.txt'), 'old\n')
  writeFileSync(join(dir, '.git/HEAD'), 'ref: refs/heads/main\n')
  return dir
}

/** A VM's /workspace, starting as a copy of the baseline, recording what reaches it. */
function fakeVm(baseline: Map<string, Entry>) {
  const files = new Map<string, Entry>(
    [...baseline].map(([p, e]) => [p, { ...e }]),
  )
  const log: string[] = []
  const rel = (path: string) => path.replace(/^\/workspace\//, '')
  return {
    files,
    log,
    /** The agent changes a file in the VM. */
    agentWrites(p: string, text: string) {
      files.set(p, {
        p,
        k: 'f',
        m: 0o644,
        s: text.length,
        h: createHash('sha256').update(text).digest('hex'),
      })
    },
    iso: {
      put: async (
        path: string,
        content: string | Uint8Array,
        mode?: number,
      ) => {
        const data = Buffer.from(content)
        files.set(rel(path), {
          p: rel(path),
          k: 'f',
          m: mode ?? 0o644,
          s: data.length,
          h: createHash('sha256').update(data).digest('hex'),
        })
        log.push(`put ${rel(path)} ${data.toString()}`)
      },
      exec: async (argv: string[]) => {
        const p = rel(argv.at(-1)!)
        if (argv[0] === 'rm')
          for (const key of [...files.keys()])
            if (key === p || key.startsWith(p + '/')) files.delete(key)
        if (argv[0] === 'mkdir' && !files.has(p))
          files.set(p, { p, k: 'd', m: 0o755 })
        if (argv[0] === 'chmod')
          files.set(p, { ...files.get(p)!, m: parseInt(argv[1], 8) })
        log.push(`${argv[0]} ${p}`)
        return 0
      },
      files: {
        list: async () => [...files.values()],
        read: async () => Buffer.alloc(0),
      },
    },
  }
}

test("the person's edits reach the VM; what the agent changed too, and Git, stay put", async () => {
  const dir = project()
  try {
    const baseline = await hostManifest(dir)
    const vm = fakeVm(baseline)
    const live = liveSync({
      project: dir,
      iso: vm.iso as never,
      baseline,
      watch: false,
    })
    writeFileSync(join(dir, 'agent/instructions.md'), 'v2\n')
    writeFileSync(join(dir, 'notes.md'), 'mine, edited\n')
    rmSync(join(dir, 'old.txt'))
    writeFileSync(join(dir, '.git/HEAD'), 'ref: refs/heads/other\n')
    // The agent changed notes.md in the VM meanwhile.
    vm.agentWrites('notes.md', 'the agent wrote this\n')
    const { pushed, kept } = await live.push()
    expect(pushed.sort()).toEqual(['agent/instructions.md', 'old.txt'])
    expect(kept).toEqual(['notes.md'])
    expect(vm.log).toContain('put agent/instructions.md v2\n')
    expect(vm.log).toContain('rm old.txt')
    expect(vm.log.some((l) => l.includes('.git'))).toBe(false)
    // The baseline moved with what was pushed, so sync-back won't call it a conflict.
    expect(baseline.get('agent/instructions.md')?.h).toBe(
      vm.files.get('agent/instructions.md')?.h,
    )
    expect(baseline.has('old.txt')).toBe(false)
    // Nothing new: nothing pushed.
    expect((await live.push()).pushed).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a directory the person removes stays in the VM while the agent has work in it', async () => {
  const dir = project()
  try {
    mkdirSync(join(dir, 'src/old'), { recursive: true })
    writeFileSync(join(dir, 'src/old/a.ts'), 'a\n')
    const baseline = await hostManifest(dir)
    const vm = fakeVm(baseline)
    const live = liveSync({
      project: dir,
      iso: vm.iso as never,
      baseline,
      watch: false,
    })
    vm.agentWrites('src/old/new.ts', 'the agent made this\n')
    rmSync(join(dir, 'src/old'), { recursive: true })
    const { pushed, kept } = await live.push()
    // a.ts was the person's alone: it goes. The directory holds the agent's file: it stays.
    expect(pushed).toEqual(['src/old/a.ts'])
    expect(kept).toEqual(['src/old'])
    expect(vm.files.has('src/old/new.ts')).toBe(true)
    expect(vm.files.has('src/old/a.ts')).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a new directory gets the person's mode, a file can become a directory, and one bad path holds up nothing", async () => {
  const dir = project()
  try {
    const baseline = await hostManifest(dir)
    const vm = fakeVm(baseline)
    const failing = {
      ...vm.iso,
      put: async (
        path: string,
        content: string | Uint8Array,
        mode?: number,
      ) => {
        if (path.endsWith('/b-broken.txt')) throw new Error('the VM refused it')
        return vm.iso.put(path, content, mode)
      },
    }
    const live = liveSync({
      project: dir,
      iso: failing as never,
      baseline,
      watch: false,
    })
    mkdirSync(join(dir, 'scripts'), { mode: 0o700 })
    rmSync(join(dir, 'old.txt'))
    mkdirSync(join(dir, 'old.txt'))
    writeFileSync(join(dir, 'b-broken.txt'), 'b\n')
    writeFileSync(join(dir, 'c.txt'), 'c\n')
    const first = await live.push()
    expect(first.pushed.sort()).toEqual(['c.txt', 'old.txt', 'scripts'])
    expect(first.kept).toEqual(['b-broken.txt'])
    expect(vm.files.get('scripts')?.m).toBe(0o700)
    expect(vm.files.get('old.txt')?.k).toBe('d')
    // The directory matches its baseline, so a file in it is the person's to push.
    writeFileSync(join(dir, 'scripts/run.sh'), 'echo\n')
    expect((await live.push()).pushed).toContain('scripts/run.sh')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stop waits for a push under way, and nothing pushes after it', async () => {
  const dir = project()
  try {
    const baseline = await hostManifest(dir)
    const vm = fakeVm(baseline)
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const slow = {
      ...vm.iso,
      put: async (
        path: string,
        content: string | Uint8Array,
        mode?: number,
      ) => {
        await gate
        return vm.iso.put(path, content, mode)
      },
    }
    const live = liveSync({
      project: dir,
      iso: slow as never,
      baseline,
      watch: false,
    })
    writeFileSync(join(dir, 'notes.md'), 'v2\n')
    const pushing = live.push()
    await Bun.sleep(20)
    let stopped = false
    const stopping = live.stop().then(() => (stopped = true))
    await Bun.sleep(20)
    expect(stopped).toBe(false)
    release()
    await stopping
    expect((await pushing).pushed).toEqual(['notes.md'])
    writeFileSync(join(dir, 'notes.md'), 'v3\n')
    expect((await live.push()).pushed).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a deletion that fails is tried again on the next pass', async () => {
  const dir = project()
  try {
    const baseline = await hostManifest(dir)
    const vm = fakeVm(baseline)
    let refuse = true
    const flaky = {
      ...vm.iso,
      exec: async (argv: string[]) =>
        argv[0] === 'rm' && refuse ? 1 : vm.iso.exec(argv),
    }
    const live = liveSync({
      project: dir,
      iso: flaky as never,
      baseline,
      watch: false,
    })
    rmSync(join(dir, 'old.txt'))
    expect((await live.push()).kept).toEqual(['old.txt'])
    refuse = false
    expect((await live.push()).pushed).toEqual(['old.txt'])
    expect(vm.files.has('old.txt')).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
