// The station's end of an agent's channel: what other members say goes into
// the agent's VM over its pty, and what the agent says there comes back as
// the agent's messages (wire.ts). The VM is untrusted: only well-formed say
// lines count, they are posted as the agent and nobody else, and an answer
// may only point at a message the agent was given.
import type { PtyHandle } from '../isolation/session'
import type { LocalChannel } from './local'
import {
  decodeFromAgent,
  decodeToAgent,
  encodeToAgent,
  lineSplitter,
  printable,
} from './wire'

export function bridgeAgent(o: {
  channel: LocalChannel
  /** The agent's member name. */
  agent: string
  pty: Pick<PtyHandle, 'write' | 'onData'>
  /** Whatever else the VM printed (its errors), for the person's log. */
  log?: (line: string) => void
}): () => void {
  const given = new Set<string>()
  let off = false
  // Nothing goes in until the guest says it is here: by then its pty is raw,
  // so a message is neither echoed nor cut at the line-editing limit.
  let ready = false
  const queued: string[] = []
  let refused = 0
  const post = (
    text: string,
    options: { note?: boolean; answers?: string },
  ) => {
    try {
      o.channel.post(o.agent, text, options)
      if (options.answers) given.delete(options.answers)
      return true
    } catch (e) {
      // Said once, not once per message a flooding VM sends.
      if (refused++ === 0)
        o.log?.(`the agent's messages aren't taken: ${(e as Error).message}`)
      return false
    }
  }
  o.pty.onData(
    lineSplitter((line) => {
      if (off) return
      const said = decodeFromAgent(line)
      if (!said) {
        // The pty echoing a message is neither the agent speaking nor worth
        // showing; anything else is, made safe for a terminal.
        if (line.trim() && !decodeToAgent(line))
          o.log?.(`(vm) ${printable(line)}`)
        return
      }
      const answers =
        said.answers && given.has(said.answers) ? said.answers : undefined
      if (!post(said.text, { note: said.note, answers }) && answers)
        // An answer that couldn't be kept still finishes its message, so the
        // chat can end; the station says why, not the VM.
        try {
          o.channel.post(o.agent, "the agent's answer couldn't be kept", {
            note: true,
            answers,
          })
          given.delete(answers)
        } catch {}
      if (!ready && said.note) {
        ready = true
        for (const line of queued.splice(0)) o.pty.write(line)
      }
    }),
  )
  const stop = o.channel.onMessage((m) => {
    if (m.from === o.agent || m.note) return
    given.add(m.id)
    const line = encodeToAgent({ id: m.id, from: m.from, text: m.text })
    if (ready) o.pty.write(line)
    else queued.push(line)
  })
  return () => {
    off = true
    stop()
  }
}
