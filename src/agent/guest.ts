// The agent loop as it runs in the VM: `bun loop.js <project>` on the guest
// pty, speaking the channel `mirab dev` opens between the person and the
// agent (src/channel). The model is the station's route on the guest's
// loopback; the key is a placeholder the station replaces on the host, so
// nothing in the VM ever holds it.
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ModelMessage } from 'ai'
import { decodeToAgent, encodeFromAgent, type FromAgent } from '../channel/wire'
import { PLACEHOLDER, guestRouteURL } from '../station/routes'
import { loadManifest } from './manifest'
import { loadAgent, modelFor, runTurn, type ModelEndpoint } from './runtime'

export const GUEST_MODEL: ModelEndpoint = {
  baseURL: `${guestRouteURL('anthropic')}/v1`,
  key: PLACEHOLDER,
}

/** When anything under the agent's folder last changed. */
export function agentStamp(project: string): string {
  const dir = join(project, 'agent')
  const parts: string[] = []
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name)
      // Links are part of the folder as they are; never followed.
      const st = lstatSync(full)
      parts.push(`${full}:${st.mtimeMs}:${st.size}`)
      if (st.isDirectory()) walk(full)
    }
  }
  try {
    walk(dir)
  } catch {
    return ''
  }
  return parts.join('|')
}

/**
 * The agent's side of the channel its station hosts (src/channel): a message
 * in on `input`, one JSON line each; what the agent says out on `output`.
 * Every message gets exactly one answer, its reply or why there is none. A
 * message is untrusted input, and only ever the next thing said to the agent.
 */
export async function serve(
  project: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  endpoint: ModelEndpoint = GUEST_MODEL,
) {
  // On the guest pty: no echo, no line editing, the bytes as the host sent them.
  const tty = input as NodeJS.ReadableStream & {
    isTTY?: boolean
    setRawMode?: (raw: boolean) => void
  }
  if (tty.isTTY) tty.setRawMode?.(true)
  const say = (m: FromAgent) => output.write(encodeFromAgent(m))
  let loaded = await loadAgent(project)
  let model = modelFor(loaded.agent, endpoint)
  let stamp = agentStamp(project)
  say({ text: `${loaded.agent.name} is here.`, note: true })
  let history: ModelMessage[] = []
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const message = decodeToAgent(line)
    if (!message) continue
    // The person's edits reach the VM as they save (live sync): pick up
    // agent.ts, instructions and tools before the next turn, keeping the
    // conversation.
    const now = agentStamp(project)
    if (now !== stamp) {
      // Only a load that worked counts: a half-saved agent is tried again
      // next turn, and the one that loaded answers meanwhile.
      try {
        const next = await loadAgent(project)
        model = modelFor(next.agent, endpoint)
        loaded = next
        stamp = now
        say({ text: 'the agent changed; reloaded', note: true })
      } catch (e) {
        say({
          text: `the agent changed but didn't load: ${(e as Error).message}`,
          note: true,
        })
      }
    }
    try {
      const turn = await runTurn({
        loaded,
        model,
        history,
        message: message.text,
      })
      history = turn.messages
      say({
        text: `${turn.text}${turn.truncated ? ' [stopped: too many steps]' : ''}`,
        answers: message.id,
      })
    } catch (e) {
      say({ text: (e as Error).message, note: true, answers: message.id })
    }
  }
}

/** The line the guest prints the manifest on, for the host to read back. */
export const MANIFEST_LINE = 'mirab-manifest '

if (import.meta.main) {
  const [first, second] = process.argv.slice(2)
  // `--manifest <project>`: the agent's files run here, in the VM, never on
  // the host, which only checks the JSON this prints.
  if (first === '--manifest')
    console.log(
      MANIFEST_LINE +
        JSON.stringify((await loadManifest(second ?? '/workspace')).manifest),
    )
  else await serve(first ?? '/workspace', process.stdin, process.stdout)
}
