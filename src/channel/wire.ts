// How a station channel reaches the agent in its VM: one JSON line each way
// on the guest pty, the same code on both ends. In: a message from another
// member. Out: what the agent says, prefixed so nothing else the guest prints
// can pass for it. The host checks every line it reads; the guest is
// untrusted, and so is every message.
import { z } from 'zod'
import { MAX_MESSAGE } from './local'

/** What the guest prints before each thing the agent says. */
export const SAY_LINE = 'mirab-say '

export const toAgent = z.strictObject({
  id: z.string().min(1).max(64),
  from: z.string().min(1).max(512),
  text: z.string(),
})
export type ToAgent = z.infer<typeof toAgent>

export const fromAgent = z.strictObject({
  text: z.string().refine((t) => Buffer.byteLength(t) <= MAX_MESSAGE, {
    message: `a message is at most ${MAX_MESSAGE} bytes`,
  }),
  /** Said about the chat, not in it. */
  note: z.literal(true).optional(),
  /** The message this finishes: its reply, or why there is none. */
  answers: z.string().min(1).max(64).optional(),
})
export type FromAgent = z.infer<typeof fromAgent>

export const encodeToAgent = (m: ToAgent) => JSON.stringify(m) + '\n'
export const encodeFromAgent = (m: FromAgent) =>
  SAY_LINE + JSON.stringify(m) + '\n'

/** A line the guest printed: what the agent said, or undefined for anything else. */
export function decodeFromAgent(line: string): FromAgent | undefined {
  if (!line.startsWith(SAY_LINE)) return undefined
  try {
    const parsed = fromAgent.safeParse(JSON.parse(line.slice(SAY_LINE.length)))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** A line the host wrote: a message for the agent, or undefined. */
export function decodeToAgent(line: string): ToAgent | undefined {
  try {
    const parsed = toAgent.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** Splits a byte stream into lines (`\r\n` or `\n`), holding the tail. */
export function lineSplitter(
  onLine: (line: string) => void,
  max = 2 * MAX_MESSAGE,
) {
  let pending = ''
  return (chunk: Buffer | string) => {
    pending += chunk.toString()
    let at: number
    while ((at = pending.indexOf('\n')) >= 0) {
      onLine(pending.slice(0, at).replace(/\r$/, ''))
      pending = pending.slice(at + 1)
    }
    // A line longer than any message is noise: dropped, never buffered forever.
    if (pending.length > max) pending = ''
  }
}
