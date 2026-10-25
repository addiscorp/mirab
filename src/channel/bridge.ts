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
  o.pty.onData(
    lineSplitter((line) => {
      const said = decodeFromAgent(line)
      if (!said) {
        // The pty echoing a message before the guest turned echo off is
        // neither the agent speaking nor worth showing.
        if (line.trim() && !decodeToAgent(line)) o.log?.(`(vm) ${line}`)
        return
      }
      const answers =
        said.answers && given.delete(said.answers) ? said.answers : undefined
      try {
        o.channel.post(o.agent, said.text, { note: said.note, answers })
      } catch (e) {
        o.log?.(`the agent's message wasn't taken: ${(e as Error).message}`)
      }
    }),
  )
  return o.channel.onMessage((m) => {
    if (m.from === o.agent || m.note) return
    given.add(m.id)
    o.pty.write(encodeToAgent({ id: m.id, from: m.from, text: m.text }))
  })
}
