// A channel the station hosts (docs/architecture.md section 4; harar section
// 3b): the chat in `mirab dev` between the person at this terminal and the
// agent in its VM. The station is the app here: it holds the messages, one
// JSON line each, in a file only this machine's user can read, and never lets
// them leave the machine. Membership is fixed when the channel opens; a
// message is untrusted input from whoever wrote it, and being a member grants
// nothing else. A channel id is never reused, so a new chat never shows an
// old one's messages.
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The longest message a channel takes; a longer one is refused, never cut. */
export const MAX_MESSAGE = 64 * 1024
/** The most a station keeps for one channel, so a VM that floods it can't
 *  fill the disk. */
export const MAX_CHANNEL = 64 * 1024 * 1024

export interface Member {
  /** An actor's harar name, e.g. `gg.addis.human.sami`, `gg.addis.agent.ops`. */
  name: string
  can: 'speak' | 'listen'
  /** Named by this machine alone: nothing (no harar token) vouched for it. */
  unverified?: true
}

export interface Message {
  /** Sortable and never reused: a ULID. */
  id: string
  from: string
  at: string
  text: string
  /** Said about the chat (the agent reloaded, a turn failed), not in it. */
  note?: true
  /** The message this finishes: its reply, or why there is none. */
  answers?: string
}

export interface LocalChannel {
  /** `<org>.channel.ch-<ulid>` */
  readonly id: string
  readonly members: readonly Member[]
  /** Where the messages are kept. */
  readonly path: string
  post(
    from: string,
    text: string,
    options?: { note?: boolean; answers?: string },
  ): Message
  messages(): Message[]
  /** Every message posted from now on, in order. */
  onMessage(listener: (message: Message) => void): () => void
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 48 bits of milliseconds and 80 random bits, in Crockford base32. */
export function ulid(now = Date.now()): string {
  let time = ''
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32))
    time = CROCKFORD[t % 32] + time
  let random = ''
  const bytes = randomBytes(10)
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      random += CROCKFORD[(value >> bits) & 31]
    }
    value &= (1 << bits) - 1
  }
  return time + random
}

export function openChannel(o: {
  /** The directory the station keeps channels in (private to this user). */
  dir: string
  /** The org whose channel it is: the hosting agent's. */
  org: string
  members: Member[]
  now?: () => Date
  /** Tests make it small. */
  maxBytes?: number
}): LocalChannel {
  const now = o.now ?? (() => new Date())
  const id = `${o.org}.channel.ch-${ulid(now().getTime()).toLowerCase()}`
  const path = join(o.dir, `${id}.jsonl`)
  const members = o.members.map((m) => ({ ...m }))
  const byName = new Map(members.map((m) => [m.name, m]))
  if (byName.size !== members.length)
    throw new Error('a channel lists each member once')
  mkdirSync(o.dir, { recursive: true, mode: 0o700 })
  // The first line says what the channel is; `flag: 'wx'` because an id is
  // never reused.
  appendFileSync(
    path,
    JSON.stringify({ channel: id, members, opened: now().toISOString() }) +
      '\n',
    { mode: 0o600, flag: 'wx' },
  )
  const listeners = new Set<(message: Message) => void>()
  let kept = 0
  return {
    id,
    members,
    path,
    post(from, text, options) {
      const member = byName.get(from)
      if (!member) throw new Error(`${from} isn't a member of ${id}`)
      if (member.can !== 'speak')
        throw new Error(`${from} only listens in ${id}`)
      if (Buffer.byteLength(text) > MAX_MESSAGE)
        throw new Error(`a message is at most ${MAX_MESSAGE} bytes`)
      const at = now()
      const message: Message = {
        id: ulid(at.getTime()),
        from,
        at: at.toISOString(),
        text,
        ...(options?.note ? { note: true as const } : {}),
        ...(options?.answers ? { answers: options.answers } : {}),
      }
      const line = JSON.stringify(message) + '\n'
      if (kept + Buffer.byteLength(line) > (o.maxBytes ?? MAX_CHANNEL))
        throw new Error(`${id} is full; open a new chat`)
      appendFileSync(path, line)
      kept += Buffer.byteLength(line)
      for (const listener of listeners) listener(message)
      return message
    },
    messages() {
      return readFileSync(path, 'utf8')
        .split('\n')
        .slice(1)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Message)
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
