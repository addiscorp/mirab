// What an agent folder declares: `agent/agent.ts` exports defineAgent(...),
// and each file in `agent/tools/` exports defineTool(...). The shape follows
// Vercel's eve, so its users know it; everything runs inside the agent's VM.
import { z } from 'zod'

/** One harar label: [a-z0-9-], 1–63 characters, not starting or ending with `-`. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** The kinds harar reserves; none of them is ever an org label. These follow
 *  harar's design (docs/architecture.md section 2, with app and channel from
 *  section 3b), which harar's code (harar-client model.rs) is catching up to. */
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

/** Why `name` isn't a harar name of `kind` (`<org>.<kind>.<local>`), or null. */
export function nameProblem(
  name: string,
  kind: 'agent' | 'channel' | 'human',
  example: string,
): string | null {
  if (name.length > 253) return 'is longer than 253 characters'
  const labels = name.split('.')
  const at = labels.findIndex((label) => KINDS.has(label))
  if (at < 0 || labels[at] !== kind)
    return `needs the form <org>.${kind}.<name>, like ${example}`
  if (at < 2) return `needs an org of two or more labels, like ${example}`
  if (at !== labels.length - 2)
    return `has one label after .${kind}., like ${example}`
  const bad = labels.find((label) => !LABEL.test(label))
  if (bad !== undefined)
    return `has a label that isn't [a-z0-9-] (1–63, no leading or trailing -): ${JSON.stringify(bad)}`
  return null
}

/** Why `name` isn't an agent name (`<org>.agent.<local>`, harar's rules), or null. */
export function agentNameProblem(name: string): string | null {
  return nameProblem(name, 'agent', 'gg.addis.agent.ops')
}

/** Why `name` isn't a human's harar name (`<org>.human.<local>`), or null. */
export function humanNameProblem(name: string): string | null {
  return nameProblem(name, 'human', 'gg.addis.human.sami')
}

const agentName = z.string().superRefine((name, ctx) => {
  const problem = agentNameProblem(name)
  if (problem)
    ctx.addIssue({ code: 'custom', message: `agent name ${problem}` })
})

/** `provider/model`, e.g. `anthropic/claude-sonnet-5-5`. */
export const MODEL = /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/
const model = z
  .string()
  .regex(MODEL, 'model is provider/model, like anthropic/claude-sonnet-5-5')

/** A tool's name is its file's name, or its key in `tools`; the model sees exactly that. */
export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** Why `name` can't be a tool's name, or null. `__proto__` is refused: as a
 *  key in plain data it is dropped or changes the object, never a tool. */
export function toolNameProblem(name: string): string | null {
  if (!TOOL_NAME.test(name))
    return "a tool's name is [a-zA-Z0-9_-] up to 64 characters"
  if (name === '__proto__') return "__proto__ can't be a tool's name"
  return null
}

/** A tool's input: a JSON Schema for an object, which is what models take. */
export const toolInput = z
  .record(z.string(), z.unknown())
  .refine((schema) => schema.type === 'object', {
    message: 'a tool input is a JSON Schema with type "object"',
  })

/** A tool that is an executable in the VM: the model's input as JSON on its
 *  stdin (checked against `input` first), its answer as JSON on stdout. */
export const commandToolSchema = z.strictObject({
  description: z.string().trim().min(1, 'a tool needs a description'),
  /** An executable: on the VM's PATH, absolute, or `./` from the project. */
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  input: toolInput.superRefine((schema, ctx) => {
    try {
      z.fromJSONSchema(schema)
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        message: `the input schema can't be checked: ${(e as Error).message}`,
      })
    }
  }),
  /** How long one call may take; TOOL_TIMEOUT_MS if unset. */
  timeoutMs: z.number().int().positive().optional(),
})
export type CommandTool = z.infer<typeof commandToolSchema>

const toolName = z.string().superRefine((name, ctx) => {
  const problem = toolNameProblem(name)
  if (problem) ctx.addIssue({ code: 'custom', message: problem })
})

/** Tools by name. zod's record drops a `__proto__` key before checking it,
 *  so the raw data is checked for one first. */
export function toolRecord<T extends z.ZodType>(tool: T) {
  return z
    .unknown()
    .superRefine((data, ctx) => {
      if (data && typeof data === 'object' && Object.hasOwn(data, '__proto__'))
        ctx.addIssue({ code: 'custom', message: toolNameProblem('__proto__')! })
    })
    .pipe(z.record(toolName, tool))
}

/** A package in the agent's VM image, by name (a nixpkgs attribute, later). */
const packageName = z.string().regex(
  // Never ending in -, which apt reads as "remove" (g++ is fine).
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._+-]{0,126}[a-zA-Z0-9+])?$/,
  'a package is a name, like ripgrep',
)

/** A whitelist entry as the station matches it: `api.github.com`, or
 *  `*.github.com` for every name under it. Names only, never an address. */
export function domainProblem(domain: string): string | null {
  const labels = (domain.startsWith('*.') ? domain.slice(2) : domain).split('.')
  if (domain.length > 253) return 'is longer than 253 characters'
  if (labels.length < 2) return 'needs two or more labels, like api.github.com'
  if (labels.some((label) => !LABEL.test(label)))
    return 'is lowercase labels of [a-z0-9-], with only a leading *. as a wildcard'
  // A name's last label starts with a letter; 127.0.0x1 and 1.0x7f are addresses.
  if (!/^[a-z]/.test(labels.at(-1)!)) return 'is a name, not an address'
  return null
}
const domain = z.string().superRefine((d, ctx) => {
  const problem = domainProblem(d)
  if (problem) ctx.addIssue({ code: 'custom', message: `domain ${problem}` })
})

const channel = z.string().superRefine((name, ctx) => {
  const problem = nameProblem(name, 'channel', 'gg.addis.channel.ops')
  if (problem) ctx.addIssue({ code: 'custom', message: `channel ${problem}` })
})

/** What agent/agent.ts declares. TypeScript tools are files in agent/tools/;
 *  `tools` here holds command tools. */
export const agentSchema = z.strictObject({
  /** The agent's harar name: its identity everywhere it goes. */
  name: agentName,
  model,
  tools: toolRecord(commandToolSchema).optional(),
  /** What its VM image holds besides the base. */
  packages: z.array(packageName).optional(),
  /** Its zone's whitelist: the only names the station lets it reach. */
  domains: z.array(domain).optional(),
  /** The channels it joins. */
  channels: z.array(channel).optional(),
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
