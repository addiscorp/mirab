// Live sync for `mirab dev`: the person's edits on the host reach the agent's
// VM as they save, and the agent's changes come back when the session ends.
//
// Into the VM, per path, against the baseline (the tree as the VM last got
// it): a change on the host is pushed only while the guest still matches the
// baseline. If the agent changed that path too, the person's version stays on
// the host and the agent's comes back as a conflict at the end (sync.ts),
// never silently overwritten either way. Host Git metadata is never pushed.
import { watch, type FSWatcher } from 'node:fs'
import { AnchoredDirectory } from './isolation/anchored-fs'
import type { Isolation } from './isolation/session'
import {
  hostManifest,
  protectedMetadata,
  sameEntry,
  validPath,
  type Manifest,
} from './isolation/sync'

/** How long the host's edits settle before they are pushed. */
const SETTLE_MS = 250
const GUEST_ROOT = '/workspace'

export interface LiveSync {
  /** Pushes whatever changed now (also what the watcher calls). */
  push(): Promise<{ pushed: string[]; kept: string[] }>
  /** Stops watching and waits for a push under way, so sync-back never
   *  runs beside one. */
  stop(): Promise<void>
}

export function liveSync(o: {
  project: string
  iso: Pick<Isolation, 'put' | 'exec' | 'files'>
  /** The tree as the VM got it; updated as paths are pushed (sync-back reads it). */
  baseline: Manifest
  log?: (line: string) => void
  /** Off: only `push()` pushes (tests drive it by hand). */
  watch?: boolean
}): LiveSync {
  // What the host had when each path was last looked at.
  const host = new Map(o.baseline)
  let running: Promise<{ pushed: string[]; kept: string[] }> | undefined
  let again = false
  let stopped = false
  const run = async (argv: string[]) => {
    const code = await o.iso.exec(argv, {
      cwd: GUEST_ROOT,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      onLine: async () => {},
    })
    if (code !== 0) throw new Error(`${argv[0]} exited ${code}`)
  }
  const once = async () => {
    const pushed: string[] = []
    const kept: string[] = []
    if (stopped) return { pushed, kept }
    const next = await hostManifest(o.project)
    const changed = [...new Set([...host.keys(), ...next.keys()])].filter(
      (p) =>
        !sameEntry(host.get(p), next.get(p)) &&
        validPath(p) &&
        !protectedMetadata(p),
    )
    if (!changed.length) return { pushed, kept }
    const guest: Manifest = new Map(
      (await o.iso.files!.list(GUEST_ROOT)).map((e) => [e.p, e]),
    )
    /** The agent changed `p`, or anything under it. */
    const agentTouched = (p: string) => {
      if (!sameEntry(guest.get(p), o.baseline.get(p))) return true
      const under = `${p}/`
      for (const q of new Set([...guest.keys(), ...o.baseline.keys()]))
        if (q.startsWith(under) && !sameEntry(guest.get(q), o.baseline.get(q)))
          return true
      return false
    }
    // Deletions deepest first, then directories and files parents first.
    const order = [
      ...changed
        .filter((p) => !next.has(p))
        .sort()
        .reverse(),
      ...changed.filter((p) => next.has(p)).sort(),
    ]
    const root = AnchoredDirectory.open(o.project)
    try {
      for (const p of order) {
        const now = next.get(p)
        if (now) host.set(p, now)
        else host.delete(p)
        const was = guest.get(p)
        // Removing a directory, or one of a different kind in the way,
        // would take whatever the agent made inside it.
        const removes = !now || (was && was.k !== now.k)
        if (agentTouched(p) || now?.k === 'l') {
          // The agent changed it too (the person's version waits on the
          // host for sync-back), or it is a link, which stays as the VM has
          // it until then.
          kept.push(p)
          continue
        }
        const at = `${GUEST_ROOT}/${p}`
        try {
          let entry = now
          if (removes && was) await run(['rm', '-rf', '--', at])
          if (now?.k === 'd') {
            await run(['mkdir', '-p', '--', at])
            await run(['chmod', (now.m & 0o777).toString(8), '--', at])
          } else if (now?.k === 'f') {
            // Read through the anchored root (never a link), and record the
            // bytes that went, not the ones listed a moment before.
            const parent = root.parent(p)
            let read
            try {
              read = parent.read(p.split('/').at(-1)!, p)
            } finally {
              if (parent !== root) parent.close()
            }
            if (!read) throw new Error('it changed while it was read')
            entry = read.entry
            await o.iso.put(at, read.data, read.entry.m & 0o777)
            await run(['chmod', (read.entry.m & 0o777).toString(8), '--', at])
            host.set(p, read.entry)
          }
          if (entry) o.baseline.set(p, entry)
          else o.baseline.delete(p)
          pushed.push(p)
        } catch (e) {
          // One path that can't go doesn't hold up the rest; the next edit
          // tries again, and sync-back settles it at the end.
          host.delete(p)
          kept.push(p)
          o.log?.(`live sync: ${p}: ${(e as Error).message}`)
        }
      }
    } finally {
      root.close()
    }
    if (pushed.length) o.log?.(`synced into the VM: ${pushed.join(', ')}`)
    if (kept.length)
      o.log?.(`changed in the VM too, kept on this machine: ${kept.join(', ')}`)
    return { pushed, kept }
  }
  // One push at a time; edits during one start another after it, even when
  // it failed.
  const push = () => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      let result = { pushed: [] as string[], kept: [] as string[] }
      do {
        again = false
        try {
          result = await once()
        } catch (e) {
          if (!again || stopped) throw e
          o.log?.(`live sync: ${(e as Error).message}`)
        }
      } while (again && !stopped)
      return result
    })().finally(() => (running = undefined))
    return running
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher | undefined
  try {
    if (o.watch !== false)
      watcher = watch(o.project, { recursive: true }, (_, name) => {
        if (name && (name === '.git' || String(name).startsWith('.git/')))
          return
        clearTimeout(timer)
        timer = setTimeout(
          () =>
            void push().catch((e) =>
              o.log?.(`live sync: ${(e as Error).message}`),
            ),
          SETTLE_MS,
        )
      })
    watcher?.on('error', (e) => {
      o.log?.(`live sync is off: ${e.message}`)
      watcher?.close()
    })
  } catch (e) {
    o.log?.(`live sync is off: ${(e as Error).message}`)
  }
  return {
    push,
    async stop() {
      stopped = true
      clearTimeout(timer)
      watcher?.close()
      await running?.catch(() => {})
    },
  }
}
