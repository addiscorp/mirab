// `mirab control`: the versioned machine interface to mirab, one JSON object
// per line on stdin and stdout. This file is its only definition. The JSON
// Schema (protocol/control.v1.json) and the Rust client's types
// (crates/mirab/src/protocol.rs) are generated from it by
// scripts/control-schema.ts, and CI fails if either differs.
//
// A change a client written against this version couldn't read bumps
// CONTROL_PROTOCOL. A new optional field doesn't.
import { z } from 'zod'
import { agentSchema } from '../agent/define'
import { manifestSchema } from '../agent/manifest'

export const CONTROL_PROTOCOL = 1

const Manifest = manifestSchema.meta({ id: 'Manifest' })

const Pending = z
  .object({
    domains: z.array(z.string()),
    packages: z.array(z.string()),
    gateway: agentSchema.shape.gateway,
  })
  .meta({
    id: 'PendingReach',
    description:
      'What the agent asks for beyond what the person approved. Only `mirab manifest approve`, in their terminal, approves it.',
  })

const Session = z
  .object({
    session: z.string(),
    /** The agent's harar name. */
    agent: z.string(),
    /** The person's member name in the session's channel. */
    person: z.string(),
    channel: z.string(),
    zone: z.string(),
    project: z.string(),
  })
  .meta({ id: 'SessionInfo' })

const Message = z
  .object({
    id: z.string(),
    from: z.string(),
    at: z.string(),
    text: z.string(),
    note: z.boolean().optional(),
    answers: z.string().optional(),
  })
  .meta({ id: 'ChannelMessage' })

const SyncEntry = z
  .object({
    path: z.string(),
    reason: z.string(),
    saved: z.string().optional(),
  })
  .meta({ id: 'SyncEntry' })

const Recovery = z
  .object({ directory: z.string(), note: z.string() })
  .meta({ id: 'Recovery' })

const Sync = z
  .object({
    written: z.array(z.string()),
    deleted: z.array(z.string()),
    conflicts: z.array(SyncEntry),
    held: z.array(SyncEntry),
    rejected: z.array(SyncEntry),
    recovery: Recovery.optional(),
  })
  .meta({ id: 'SyncSummary' })

const RequestKey = z
  .object({
    header: z.string(),
    secret: z.string(),
    approved: z.string().optional(),
  })
  .meta({ id: 'HeldRequestKey' })

const heldFields = {
  id: z.string(),
  agent: z.string(),
  at: z.string(),
  host: z.string(),
  method: z.string(),
  target: z.string(),
  /** [name, value, ...]; a key appears only as its placeholder. */
  headers: z.array(z.string()),
  /** The body, base64. */
  body: z.string(),
  /** Each header carrying a placeholder, by secret name; never a value. */
  keys: z.array(RequestKey),
  /** What a yes binds to. */
  hash: z.string(),
  rule: z.string().optional(),
  approval: z.string().optional(),
}

const Held = z.object(heldFields).meta({ id: 'HeldRequest' })

const HeldStatus = z
  .enum(['held', 'approved', 'declined', 'sent', 'expired'])
  .meta({ id: 'HeldStatus' })

const HeldEntry = z
  .object({ ...heldFields, status: HeldStatus })
  .meta({ id: 'HeldRequestEntry' })

const Decision = z.enum(['yes', 'no']).meta({ id: 'Decision' })

const Spawned = z
  .object({
    session: z.string(),
    agent: z.string(),
    state: z.string(),
    tool: z.string().optional(),
    last_activity: z.string(),
    cwd: z.string(),
    started: z.string(),
  })
  .meta({ id: 'SpawnedSession' })

const Empty = z.object({})

const GuestEntry = z
  .object({
    /** Path relative to the root, `/`-separated. */
    p: z.string(),
    /** `f` regular file, `d` directory, `l` symlink. */
    k: z.enum(['f', 'd', 'l']),
    /** Permission bits (0 for symlinks). */
    m: z.number().int(),
    s: z.number().int().optional(),
    /** sha256 hex of the content (files). */
    h: z.string().optional(),
    /** Link target (symlinks). */
    t: z.string().optional(),
  })
  .meta({ id: 'GuestEntry' })

/** Every operation: what it takes and what it answers. */
export const operations = {
  hello: {
    params: z.object({ protocol: z.number().int() }),
    result: z.object({ protocol: z.number().int(), version: z.string() }),
  },
  availability: {
    params: Empty,
    result: z.object({
      available: z.boolean(),
      /** `vz` on macOS, `firecracker` on Linux. */
      backend: z.string(),
      reason: z
        .enum(['not_configured', 'image_missing', 'backend_unavailable'])
        .optional(),
      detail: z.string().optional(),
    }),
  },
  file_put: {
    params: z.object({
      session: z.string(),
      /** An absolute path in the guest. Under /workspace, it comes back to
       *  the project when the session stops, like anything the agent wrote. */
      path: z.string(),
      /** The bytes, base64; at most 32 MiB once decoded. */
      content: z.string(),
      mode: z.number().int().min(0).max(0o777).optional(),
    }),
    result: Empty,
  },
  file_get: {
    params: z.object({ session: z.string(), path: z.string() }),
    result: z.object({ content: z.string() }),
  },
  file_list: {
    params: z.object({ session: z.string(), root: z.string() }),
    result: z.object({ entries: z.array(GuestEntry) }),
  },
  manifest: {
    params: z.object({ project: z.string() }),
    result: z.object({ manifest: Manifest, pending: Pending.optional() }),
  },
  start: {
    params: z.object({ project: z.string() }),
    result: Session,
  },
  stop: {
    params: z.object({ session: z.string() }),
    result: z.object({ sync: Sync.optional() }),
  },
  sessions: {
    params: Empty,
    result: z.object({ sessions: z.array(Session) }),
  },
  send: {
    params: z.object({ session: z.string(), text: z.string() }),
    result: z.object({ message: z.string() }),
  },
  requests: {
    params: z.object({ session: z.string() }),
    result: z.object({ requests: z.array(HeldEntry) }),
  },
  decide: {
    params: z.object({
      session: z.string(),
      request: z.string(),
      decision: Decision,
      /** Required for a yes: the `hash` of the request the person was shown. */
      hash: z.string().optional(),
    }),
    result: Empty,
  },
  spawn: {
    params: z.object({
      /** The agent program, as `mirab spawn` takes it. Always runs in a VM. */
      agent: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      name: z.string().optional(),
    }),
    result: z.object({ session: z.string() }),
  },
  spawned: {
    params: Empty,
    result: z.object({ sessions: z.array(Spawned) }),
  },
  spawn_send: {
    params: z.object({ session: z.string(), text: z.string() }),
    result: Empty,
  },
  spawn_stop: {
    params: z.object({
      session: z.string(),
      grace_ms: z.number().int().min(0).max(60_000).optional(),
    }),
    result: z.object({
      code: z.number().int().optional(),
      recovery: Recovery.optional(),
    }),
  },
} as const

export type Operation = keyof typeof operations

const event = <T extends string, S extends z.ZodRawShape>(name: T, shape: S) =>
  z.object({ event: z.literal(name), ...shape })

/** What mirab says without being asked. What came from a VM is untrusted. */
export const eventSchema = z
  .discriminatedUnion('event', [
    event('message', { session: z.string(), message: Message }),
    /** A call waiting for a person. Answer it with `decide`. */
    event('held', { session: z.string(), request: Held }),
    /** The approver was asked: the yes happens on the person's device. */
    event('asked', {
      session: z.string(),
      request: z.string(),
      approval: z.string(),
    }),
    event('decided', {
      session: z.string(),
      request: z.string(),
      decision: Decision,
      by: z.string(),
    }),
    event('sent', {
      session: z.string(),
      request: z.string(),
      /** The host's status, or why it couldn't be sent. */
      status: z.union([z.number().int(), z.string()]),
      /** The answer's start, every key put back to its placeholder. */
      body: z.string().optional(),
    }),
    event('denied', {
      session: z.string(),
      host: z.string(),
      method: z.string(),
      target: z.string(),
      rule: z.string(),
    }),
    /** What the session's VM or station said, for a log. */
    event('log', { session: z.string(), line: z.string() }),
    /** The agent's process ended; the session is stopping. */
    event('exited', { session: z.string(), code: z.number().int() }),
    event('spawn_state', {
      session: z.string(),
      agent: z.string(),
      state: z.enum([
        'busy',
        'idle',
        'tool_start',
        'tool_end',
        'waiting',
        'message',
      ]),
      tool: z.string().optional(),
      text: z.string().optional(),
      ts: z.string(),
    }),
    event('spawn_exited', {
      session: z.string(),
      code: z.number().int().optional(),
      recovery: Recovery.optional(),
    }),
  ])
  .meta({ id: 'Event' })

export type ControlEvent = z.infer<typeof eventSchema>

export const ERROR_CODES = [
  /** The line wasn't a request this version knows. */
  'bad_request',
  /** The client speaks another protocol version. */
  'unsupported_protocol',
  /** `hello` hasn't been answered yet. */
  'not_ready',
  'no_session',
  'no_request',
  /** The request isn't waiting for an answer any more. */
  'not_waiting',
  /** The hash isn't the one of the request as it is held. */
  'hash_mismatch',
  /** mirab tried and couldn't; the message says why. */
  'failed',
] as const

export const errorSchema = z
  .object({ code: z.enum(ERROR_CODES), message: z.string() })
  .meta({ id: 'ControlError' })

export type ControlErrorCode = (typeof ERROR_CODES)[number]

export class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** The whole protocol as one JSON Schema document. */
export function protocolSchema() {
  const shapes = Object.fromEntries(
    Object.entries(operations).map(([name, op]) => [
      name,
      z.object({ params: op.params, result: op.result }),
    ]),
  )
  const schema = z.toJSONSchema(
    z.object({
      operations: z.object(shapes),
      event: eventSchema,
      error: errorSchema,
    }),
    { io: 'output', unrepresentable: 'any', reused: 'inline' },
  )
  return {
    title: 'mirab control protocol',
    protocol: CONTROL_PROTOCOL,
    ...schema,
  }
}
