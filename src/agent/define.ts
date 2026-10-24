// What an agent folder declares: `agent/agent.ts` exports defineAgent(...),
// and each file in `agent/tools/` exports defineTool(...). The shape follows
// Vercel's eve, so its users know it; everything runs inside the agent's VM.
import { z } from 'zod'

/** One harar label: [a-z0-9-], 1–63 characters, not starting or ending with `-`. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** The kinds harar reserves; none of them is ever an org label. */
const KINDS = new Set([
  'human',
  'user',
  'agent',
  'service',
  'broker',
  'zone',
  'role',
  'profile',
  'app',
  'channel',
])

/** Why `name` isn't an agent name (`<org>.agent.<local>`, harar's rules), or null. */
export function agentNameProblem(name: string): string | null {
  if (name.length > 253) return 'is longer than 253 characters'
  const labels = name.split('.')
  const kind = labels.findIndex((label) => KINDS.has(label))
  if (kind < 0 || labels[kind] !== 'agent')
    return 'needs the form <org>.agent.<name>, like gg.addis.agent.ops'
  if (kind < 2) return 'needs an org of two or more labels, like gg.addis'
  if (kind !== labels.length - 2)
    return 'has one label after .agent., like gg.addis.agent.ops'
  const bad = labels.find((label) => !LABEL.test(label))
  if (bad !== undefined)
    return `has a label that isn't [a-z0-9-] (1–63, no leading or trailing -): ${JSON.stringify(bad)}`
  return null
}

const agentName = z.string().superRefine((name, ctx) => {
  const problem = agentNameProblem(name)
  if (problem)
    ctx.addIssue({ code: 'custom', message: `agent name ${problem}` })
})

/** `provider/model`, e.g. `anthropic/claude-sonnet-5-5`. */
const model = z
  .string()
  .regex(
    /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/,
    'model is provider/model, like anthropic/claude-sonnet-5-5',
  )

export const agentSchema = z.strictObject({
  /** The agent's harar name: its identity everywhere it goes. */
  name: agentName,
  model,
})
export type Agent = z.infer<typeof agentSchema>

export function defineAgent(agent: Agent): Agent {
  return agentSchema.parse(agent)
}

export interface Tool<Input extends z.ZodType> {
  description: string
  inputSchema: Input
  execute(input: z.infer<Input>): unknown | Promise<unknown>
}

export function defineTool<Input extends z.ZodType>(
  tool: Tool<Input>,
): Tool<Input> {
  if (!tool.description.trim()) throw new Error('a tool needs a description')
  return tool
}
