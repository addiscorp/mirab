// How a station channel reaches the agent in its VM: one JSON line each way
// on the guest pty, the same code on both ends. In: a message from another
// member. Out: what the agent says, prefixed so nothing else the guest prints
// can pass for it. The host checks every line it reads; the guest is
// untrusted, and so is every message.
import { StringDecoder } from 'node:string_decoder'
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

/** What the guest says, cut to fit a message (with a marker), never dropped. */
export function fitted(text: string): string {
  if (Buffer.byteLength(text) <= MAX_MESSAGE) return text
  const marker = ' [cut: too long for one message]'
  let cut = Buffer.from(text)
    .subarray(0, MAX_MESSAGE - marker.length - 4)
    .toString()
  cut = cut.replace(/\uFFFD$/, '')
  return cut + marker
}

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

/** A message's text as a terminal may show it: no escape sequences, no
 *  carriage returns, no control characters but newline and tab, so what
 *  someone else wrote can't move the cursor, set the title or the clipboard,
 *  or pass for a line the person typed. */
export function printable(text: string): string {
  return (
    text
      // Controls, DEL and C1; bidi overrides and isolates, zero-width marks,
      // line and paragraph separators: anything that hides or reorders text.
      .replace(
        /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
        '�',
      )
      // A line it starts is indented, so it can't stand as one of the person's.
      .replace(/\n/g, '\n  ')
  )
}

/** Splits a byte stream into lines (`\r\n` or `\n`), holding the tail. A
 *  character split across chunks stays whole. The limit allows for JSON's
 *  escapes (up to 6 characters for one) in a message at its largest. */
export function lineSplitter(
  onLine: (line: string) => void,
  max = 7 * MAX_MESSAGE,
) {
  let pending = ''
  const decoder = new StringDecoder('utf8')
  return (chunk: Buffer | string) => {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let at: number
    while ((at = pending.indexOf('\n')) >= 0) {
      onLine(pending.slice(0, at).replace(/\r$/, ''))
      pending = pending.slice(at + 1)
    }
    // A line longer than any message is noise: dropped, never buffered forever.
    if (pending.length > max) pending = ''
  }
}
