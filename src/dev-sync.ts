// Live sync for `mirab dev`: the person's edits on the host reach the agent's
// VM as they save, and the agent's changes come back when the session ends.
//
// Into the VM, per path, against the baseline (the tree as the VM last got
// it): a change on the host is pushed only while the guest still matches the
// baseline. If the agent changed that path too, the person's version stays on
// the host and the agent's comes back as a conflict at the end (sync.ts),
// never silently overwritten either way. Host Git metadata is never pushed.
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  stop(): void
}

export function liveSync(o: {
  project: string
  iso: Pick<Isolation, 'put' | 'exec' | 'files'>
  /** The tree as the VM got it; updated as paths are pushed (sync-back reads it). */
  baseline: Manifest
  log?: (line: string) => void
}): LiveSync {
  let host = new Map(o.baseline)
  let running: Promise<{ pushed: string[]; kept: string[] }> | undefined
  let again = false
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
    const next = await hostManifest(o.project)
    const changed = [...new Set([...host.keys(), ...next.keys()])].filter(
      (p) =>
        !sameEntry(host.get(p), next.get(p)) &&
        validPath(p) &&
        !protectedMetadata(p),
    )
    const pushed: string[] = []
    const kept: string[] = []
    if (!changed.length) return { pushed, kept }
    const guest: Manifest = new Map(
      (await o.iso.files!.list(GUEST_ROOT)).map((e) => [e.p, e]),
    )
    // Deletions deepest first, then directories and files parents first.
    const order = [
      ...changed
        .filter((p) => !next.has(p))
        .sort()
        .reverse(),
      ...changed.filter((p) => next.has(p)).sort(),
    ]
    for (const p of order) {
      const now = next.get(p)
      if (!sameEntry(guest.get(p), o.baseline.get(p))) {
        // The agent changed it too: the person's version waits on the host.
        kept.push(p)
        continue
      }
      const at = `${GUEST_ROOT}/${p}`
      if (!now) await run(['rm', '-rf', '--', at])
      else if (now.k === 'd') await run(['mkdir', '-p', '--', at])
      else if (now.k === 'f')
        await o.iso.put(at, await readFile(join(o.project, p)), now.m ?? 0o644)
      else {
        // Links stay as the VM has them until sync-back.
        kept.push(p)
        continue
      }
      if (now) o.baseline.set(p, now)
      else o.baseline.delete(p)
      pushed.push(p)
    }
    host = next
    if (pushed.length) o.log?.(`synced into the VM: ${pushed.join(', ')}`)
    if (kept.length)
      o.log?.(`changed in the VM too, kept on this machine: ${kept.join(', ')}`)
    return { pushed, kept }
  }
  // One push at a time; edits during one start another after it.
  const push = async () => {
    if (running) {
      again = true
      return running
    }
    try {
      do {
        again = false
        running = once()
        await running
      } while (again)
      return await running
    } finally {
      running = undefined
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(o.project, { recursive: true }, (_, name) => {
      if (name && (name === '.git' || String(name).startsWith('.git/'))) return
      clearTimeout(timer)
      timer = setTimeout(
        () =>
          void push().catch((e) =>
            o.log?.(`live sync: ${(e as Error).message}`),
          ),
        SETTLE_MS,
      )
    })
  } catch (e) {
    o.log?.(`live sync is off: ${(e as Error).message}`)
  }
  return {
    push,
    stop() {
      clearTimeout(timer)
      watcher?.close()
    },
  }
}
