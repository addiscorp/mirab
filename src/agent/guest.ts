// The agent loop as it runs in the VM: `bun loop.js <project>` on the guest
// pty that `mirab dev` hands the person's terminal. The model is the
// station's route on the guest's loopback; the key is a placeholder the
// station replaces on the host, so nothing in the VM ever holds it.
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ModelMessage } from 'ai'
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

/** A terminal chat with the agent in `project`, until its input ends. */
export async function chat(
  project: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  endpoint: ModelEndpoint = GUEST_MODEL,
) {
  let loaded = await loadAgent(project)
  let model = modelFor(loaded.agent, endpoint)
  let stamp = agentStamp(project)
  const local = loaded.agent.name.split('.').at(-1)
  const say = (line: string) => output.write(line + '\n')
  say(`${loaded.agent.name} is here. Ctrl-D ends the chat.`)
  const rl = createInterface({ input, output, prompt: 'you> ' })
  let open = true
  rl.on('close', () => (open = false))
  let history: ModelMessage[] = []
  rl.prompt()
  for await (const line of rl) {
    if (line.trim()) {
      try {
        // The person's edits reach the VM as they save (live sync): pick up
        // agent.ts, instructions and tools before the next turn, keeping the
        // conversation.
        const now = agentStamp(project)
        if (now !== stamp) {
          // Only a load that worked counts: a half-saved agent is tried
          // again next turn, and the one that loaded answers meanwhile.
          try {
            const next = await loadAgent(project)
            model = modelFor(next.agent, endpoint)
            loaded = next
            stamp = now
            say('(the agent changed; reloaded)')
          } catch (e) {
            say(`(the agent changed but didn't load: ${(e as Error).message})`)
          }
        }
        const turn = await runTurn({ loaded, model, history, message: line })
        history = turn.messages
        say(
          `${local}> ${turn.text}${turn.truncated ? ' [stopped: too many steps]' : ''}`,
        )
      } catch (e) {
        say(`(${(e as Error).message})`)
      }
    }
    if (open) rl.prompt()
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
  else await chat(first ?? '/workspace', process.stdin, process.stdout)
}
