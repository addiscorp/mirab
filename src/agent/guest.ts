// The agent loop as it runs in the VM: `bun loop.js <project>` on the guest
// pty that `mirab dev` hands the person's terminal. The model is the
// station's route on the guest's loopback; the key is a placeholder the
// station replaces on the host, so nothing in the VM ever holds it.
import { createInterface } from 'node:readline'
import type { ModelMessage } from 'ai'
import { EGRESS_GUEST_PORT } from '../isolation/vz'
import { loadAgent, modelFor, runTurn, type ModelEndpoint } from './runtime'

export const GUEST_MODEL: ModelEndpoint = {
  baseURL: `http://127.0.0.1:${EGRESS_GUEST_PORT}/anthropic/v1`,
  key: 'mirab-placeholder',
}

/** A terminal chat with the agent in `project`, until its input ends. */
export async function chat(
  project: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  endpoint: ModelEndpoint = GUEST_MODEL,
) {
  const loaded = await loadAgent(project)
  const model = modelFor(loaded.agent, endpoint)
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

if (import.meta.main)
  await chat(process.argv[2] ?? '/workspace', process.stdin, process.stdout)
