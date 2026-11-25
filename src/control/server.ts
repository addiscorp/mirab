// `mirab control`: one client (the program that started it) on stdin and
// stdout, one JSON object per line (protocol.ts). It runs agents the way
// `mirab dev` and `mirab spawn --vm` do, with the same station and the same
// approvals; it adds no way around either. No key passes through here: the
// station gets them from harar, and a held request names them only by their
// placeholders.
//
// When the client goes (its stdin closes, for any reason), every VM it started
// is stopped, and what the agents changed comes back as usual.
import { spawn as spawnProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { requests as heldRequests, type Upstream } from 'rixse'
import { pendingReach } from '../agent/approved'
import type { Message } from '../channel/local'
import { agentManifest, startDev, type Dev } from '../dev'
import { loadHostConfig, vmAvailable, vmBackend } from '../isolation'
import type { SyncResult } from '../isolation/sync'
import { stopSession } from '../spawn-attach'
import {
  liveSessions,
  localRequest,
  privateSessionsDirectory,
  socketPath,
} from '../spawn-sessions'
import { loadStationConfig } from '../station/config'
import { randomBytes } from 'node:crypto'
import {
  CONTROL_PROTOCOL,
  ControlError,
  errorSchema,
  eventSchema,
  operations,
  type ControlEvent,
  type Operation,
} from './protocol'

export interface ControlOptions {
  input: NodeJS.ReadableStream
  /** Where each frame goes, one whole line at a time. */
  write(line: string): void
  configDir: string
  version: string
  /** How to run this mirab again, for `mirab spawn`. */
  self: string[]
  /** Where diagnostics go; never the protocol's stream. */
  log?: (line: string) => void
  /** Tests point the model route and opened hosts at stand-ins. */
  upstream?: string
  opened?: (host: string) => Promise<Upstream>
}

interface Running {
  dev: Dev
  project: string
  ended: boolean
  closing?: Promise<SyncResult | undefined>
}

const SPAWN_STATES = new Set([
  'busy',
  'idle',
  'tool_start',
  'tool_end',
  'waiting',
  'message',
])

const absolute = (path: string, what: string) => {
  if (!isAbsolute(path))
    throw new ControlError('bad_request', `${what} is an absolute path`)
  return resolve(path)
}

const MAX_FILE = 32 * 1024 * 1024

const guestPath = (path: string) => {
  if (!path.startsWith('/') || path.split('/').includes('..'))
    throw new ControlError(
      'bad_request',
      'a guest path is absolute, with no `..`',
    )
  return path
}

/** A sync result as the protocol says it. */
export const syncSummary = (r: SyncResult) => ({
  written: r.written,
  deleted: r.deleted,
  conflicts: r.conflicts,
  held: r.held,
  rejected: r.rejected,
  ...(r.recovery ? { recovery: r.recovery } : {}),
})

export async function serveControl(o: ControlOptions): Promise<void> {
  const running = new Map<string, Running>()
  const spawned = new Map<string, Socket>()
  let ready = false

  const send = (frame: unknown) => o.write(JSON.stringify(frame) + '\n')
  const emit = (event: ControlEvent) => {
    const parsed = eventSchema.safeParse(event)
    if (parsed.success) send(parsed.data)
    else o.log?.(`an event doesn't fit the protocol: ${parsed.error.message}`)
  }
  const message = (session: string, m: Message) =>
    emit({ event: 'message', session, message: m })

  const session = (id: string) => {
    const found = running.get(id)
    if (!found || found.ended)
      throw new ControlError('no_session', `no session ${id}`)
    return found
  }
  const finish = (r: Running) => (r.closing ??= r.dev.close())
  const mine = (id: string) => {
    if (!spawned.has(id))
      throw new ControlError('no_session', `no spawned session ${id}`)
  }

  /** A spawned session's events, without their raw payloads: those stay on
   *  the local socket (docs/spawn-events.md). */
  const follow = async (id: string) => {
    const directory = await privateSessionsDirectory()
    const socket = createConnection(socketPath(id, directory))
    spawned.set(id, socket)
    socket.on('error', () => {})
    socket.on('connect', () => socket.write('{"type":"subscribe"}\n'))
    socket.on('close', () => {
      if (spawned.get(id) === socket) spawned.delete(id)
    })
    const lines = createInterface({ input: socket, crlfDelay: Infinity })
    lines.on('line', (line) => {
      let e: Record<string, unknown>
      try {
        e = JSON.parse(line)
      } catch {
        return
      }
      if (e.type === 'exited')
        emit({
          event: 'spawn_exited',
          session: id,
          ...(typeof e.code === 'number' ? { code: e.code } : {}),
          ...(e.recovery
            ? { recovery: e.recovery as { directory: string; note: string } }
            : {}),
        })
      else if (SPAWN_STATES.has(String(e.type)))
        emit({
          event: 'spawn_state',
          session: id,
          agent: String(e.agent),
          state: e.type as 'busy',
          ...(typeof e.tool === 'string' ? { tool: e.tool } : {}),
          ...(typeof e.text === 'string' ? { text: e.text } : {}),
          ts: String(e.ts),
        })
    })
  }

  const runSpawn = (args: string[], cwd: string) =>
    new Promise<string>((done, fail) => {
      const [command, ...rest] = o.self
      const child = spawnProcess(command!, [...rest, ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout!.on('data', (d) => (out += d))
      child.stderr!.on('data', (d) => (err += d))
      child.on('error', fail)
      child.on('close', (code) =>
        code === 0
          ? done(out.trim())
          : fail(new ControlError('failed', err.trim() || `exit ${code}`)),
      )
    })

  const handlers: {
    [K in Operation]: (params: any) => unknown | Promise<unknown>
  } = {
    hello: ({ protocol }) => {
      if (protocol !== CONTROL_PROTOCOL)
        throw new ControlError(
          'unsupported_protocol',
          `this mirab (${o.version}) speaks control protocol ${CONTROL_PROTOCOL}, not ${protocol}`,
        )
      ready = true
      return { protocol: CONTROL_PROTOCOL, version: o.version }
    },
    availability: async () => {
      const backend = vmBackend()
      const no = (
        reason: 'not_configured' | 'image_missing' | 'backend_unavailable',
        detail: string,
      ) => ({ available: false, backend, reason, detail })
      const { vm } = await loadHostConfig(o.configDir)
      if (!vm)
        return no(
          'not_configured',
          `no vm block in ${o.configDir}/isolation.json`,
        )
      for (const path of [vm.kernel, vm.rootfs])
        if (!existsSync(path)) return no('image_missing', `${path} is missing`)
      if (!vmAvailable(vm))
        return no('backend_unavailable', `${backend} can't run here`)
      return { available: true, backend }
    },
    file_put: async ({ session: id, path, content, mode }) => {
      const bytes = Buffer.from(content, 'base64')
      if (bytes.length > MAX_FILE)
        throw new ControlError('bad_request', 'a file is at most 32 MiB')
      await session(id).dev.iso.put(guestPath(path), bytes, mode ?? 0o644)
      return {}
    },
    file_get: async ({ session: id, path }) => ({
      content: (
        await session(id).dev.iso.files!.read(guestPath(path))
      ).toString('base64'),
    }),
    file_list: async ({ session: id, root }) => ({
      entries: await session(id).dev.iso.files!.list(guestPath(root)),
    }),
    manifest: async ({ project }) => {
      const root = absolute(project, 'project')
      const { manifest } = await agentManifest({
        project: root,
        configDir: o.configDir,
        log: o.log,
      })
      const pending = pendingReach(o.configDir, root)
      return { manifest, ...(pending ? { pending } : {}) }
    },
    start: async ({ project }) => {
      const root = absolute(project, 'project')
      const id = `s_${randomBytes(6).toString('hex')}`
      const dev = await startDev({
        project: root,
        configDir: o.configDir,
        station: await loadStationConfig(o.configDir),
        cols: 120,
        rows: 40,
        auditLog: join(o.configDir, 'egress.log'),
        log: (line) => emit({ event: 'log', session: id, line }),
        upstream: o.upstream,
        opened: o.opened,
      })
      const entry: Running = { dev, project: root, ended: false }
      running.set(id, entry)
      // What was said while it booted, then everything after, with no gap:
      // both happen before anything else can run.
      for (const m of dev.channel.messages()) message(id, m)
      dev.channel.onMessage((m) => message(id, m))
      void (async () => {
        for await (const e of dev.gateway.events)
          emit({ ...e, session: id } as ControlEvent)
      })().catch((e) => o.log?.(`gateway events: ${(e as Error).message}`))
      dev.pty.onExit((code) => {
        entry.ended = true
        emit({ event: 'exited', session: id, code })
        void finish(entry).catch((e) =>
          o.log?.(`stopping ${id}: ${(e as Error).message}`),
        )
      })
      return info(id, entry)
    },
    stop: async ({ session: id }) => {
      const found = running.get(id)
      if (!found) throw new ControlError('no_session', `no session ${id}`)
      found.ended = true
      const synced = await finish(found)
      running.delete(id)
      return synced ? { sync: syncSummary(synced) } : {}
    },
    sessions: () => ({
      sessions: [...running]
        .filter(([, r]) => !r.ended)
        .map(([id, r]) => info(id, r)),
    }),
    send: ({ session: id, text }) => ({
      message: session(id).dev.say(text).id,
    }),
    requests: ({ session: id }) => {
      const { dev } = session(id)
      return {
        requests: heldRequests(o.configDir).filter(
          (r) => r.agent === dev.gatewayAgent,
        ),
      }
    },
    decide: async ({ session: id, request, decision, hash }) => {
      const { dev } = session(id)
      const held = heldRequests(o.configDir).find(
        (r) => r.id === request && r.agent === dev.gatewayAgent,
      )
      if (!held)
        throw new ControlError('no_request', `no held request ${request}`)
      if (held.status !== 'held')
        throw new ControlError(
          'not_waiting',
          `${request} is ${held.status}, not waiting for an answer`,
        )
      if (decision === 'yes' && hash !== held.hash)
        throw new ControlError(
          'hash_mismatch',
          `a yes names the hash of ${request} as it was shown`,
        )
      await dev.gateway.decide(request, decision, dev.person, hash)
      return {}
    },
    spawn: async ({ agent, args, cwd, name }) => {
      const root = absolute(cwd, 'cwd')
      const id = await runSpawn(
        [
          'spawn',
          '--detach',
          '--vm',
          '--config-dir',
          o.configDir,
          ...(name ? ['--name', name] : []),
          agent,
          ...args,
        ],
        root,
      )
      await follow(id)
      return { session: id }
    },
    // Only this client's: other programs' sessions on the machine aren't
    // its to see, type into or stop.
    spawned: async () => ({
      sessions: (await liveSessions())
        .filter((s) => spawned.has(s.id))
        .map((s) => ({
          session: s.id,
          agent: s.agent,
          state: s.state,
          ...(s.tool ? { tool: s.tool } : {}),
          last_activity: s.lastActivity,
          cwd: s.cwd,
          started: s.started,
        })),
    }),
    spawn_send: async ({ session: id, text }) => {
      mine(id)
      await localRequest(socketPath(id, await privateSessionsDirectory()), {
        type: 'send',
        message: text,
      }).catch((e: NodeJS.ErrnoException) => {
        throw e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
          ? new ControlError('no_session', `no spawned session ${id}`)
          : e
      })
      return {}
    },
    spawn_stop: async ({ session: id, grace_ms }) => {
      mine(id)
      let line: string
      try {
        line = await stopSession(id, grace_ms ?? 5_000)
      } catch (e) {
        throw /No live session/.test((e as Error).message)
          ? new ControlError('no_session', `no spawned session ${id}`)
          : e
      }
      const e = JSON.parse(line) as {
        code?: number
        recovery?: { directory: string; note: string }
      }
      return {
        ...(typeof e.code === 'number' ? { code: e.code } : {}),
        ...(e.recovery ? { recovery: e.recovery } : {}),
      }
    },
  }

  const info = (id: string, r: Running) => ({
    session: id,
    agent: r.dev.agent,
    person: r.dev.person,
    channel: r.dev.channel.id,
    zone: r.dev.zone,
    project: r.project,
  })

  const answer = async (line: string) => {
    let id: number | null = null
    try {
      let frame: { id?: unknown; op?: unknown; params?: unknown }
      try {
        frame = JSON.parse(line)
      } catch {
        throw new ControlError('bad_request', "that line isn't JSON")
      }
      if (!Number.isSafeInteger(frame?.id))
        throw new ControlError('bad_request', 'a request has an integer id')
      id = frame.id as number
      const op = frame.op as Operation
      if (typeof op !== 'string' || !Object.hasOwn(operations, op))
        throw new ControlError('bad_request', `no operation ${String(op)}`)
      if (!ready && op !== 'hello')
        throw new ControlError('not_ready', 'say hello first')
      const params = operations[op].params.safeParse(frame.params ?? {})
      if (!params.success)
        throw new ControlError(
          'bad_request',
          `${op}: ${params.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`,
        )
      const result = operations[op].result.parse(
        await handlers[op](params.data),
      )
      send({ id, ok: true, result })
    } catch (e) {
      const error =
        e instanceof ControlError
          ? { code: e.code, message: e.message }
          : { code: 'failed' as const, message: (e as Error).message }
      send({ id, ok: false, error: errorSchema.parse(error) })
    }
  }

  const inFlight = new Set<Promise<void>>()
  for await (const line of createInterface({
    input: o.input,
    crlfDelay: Infinity,
  })) {
    if (!line.trim()) continue
    const job: Promise<void> = answer(line).finally(() => inFlight.delete(job))
    inFlight.add(job)
  }
  // The client is gone. A start still booting finishes first, so its VM is
  // in the list below and gets stopped.
  await Promise.allSettled(inFlight)
  await Promise.allSettled([
    ...[...running.values()].map((r) => finish(r)),
    ...[...spawned.keys()].map((id) => stopSession(id, 2_000)),
  ])
  for (const socket of spawned.values()) socket.destroy()
}
