// The agent manifest (docs/architecture.md section 5a): plain data about an
// agent, and the one thing mirab reads about it. agent/agent.ts is one way to
// write it (a Nix flake will be the other); both end up checked by
// manifestSchema, so there is one definition of what an agent is.
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  agentSchema,
  commandToolSchema,
  toolInput,
  toolRecord,
  toolNameProblem,
  type Tool,
} from './define'

/** A TypeScript tool, `agent/<file>`, run by the agent loop. */
export const typescriptToolSchema = z.strictObject({
  description: z.string().trim().min(1, 'a tool needs a description'),
  /** Relative to agent/, e.g. `tools/add.ts`. */
  file: z.string().regex(/^tools\/[a-zA-Z0-9_-]{1,64}\.ts$/),
  input: toolInput,
})

export const manifestSchema = z.strictObject({
  name: agentSchema.shape.name,
  model: agentSchema.shape.model,
  /** The system prompt. */
  instructions: z.string(),
  tools: toolRecord(z.union([typescriptToolSchema, commandToolSchema])),
  packages: z.array(agentSchema.shape.packages.unwrap().element),
  domains: z.array(agentSchema.shape.domains.unwrap().element),
  channels: z.array(agentSchema.shape.channels.unwrap().element),
})
export type Manifest = z.infer<typeof manifestSchema>

/** Checks manifest data from anywhere (agent.ts, `nix eval --json`). */
export function parseManifest(data: unknown, from: string): Manifest {
  const parsed = manifestSchema.safeParse(data)
  if (!parsed.success)
    throw new Error(
      `${from}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; ')}`,
    )
  return parsed.data
}

export interface LoadedManifest {
  manifest: Manifest
  /** The TypeScript tools as their files export them, by name. */
  typescript: Record<string, Tool<z.ZodType>>
}

/** Reads `<project>/agent` (agent.ts, instructions.md, tools/*.ts) into a manifest. */
export async function loadManifest(project: string): Promise<LoadedManifest> {
  const dir = join(resolve(project), 'agent')
  const definition = join(dir, 'agent.ts')
  if (!existsSync(definition))
    throw new Error(`${definition} is missing; mirab init makes one`)
  const parsed = agentSchema.safeParse(
    (await import(pathToFileURL(definition).href)).default,
  )
  if (!parsed.success)
    throw new Error(
      `${definition}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    )
  const agent = parsed.data
  const instructionsPath = join(dir, 'instructions.md')
  const instructions = existsSync(instructionsPath)
    ? await readFile(instructionsPath, 'utf8')
    : ''
  // No prototype, so a tool named __proto__ is a tool like any other.
  const tools: Manifest['tools'] = Object.create(null)
  const typescript: LoadedManifest['typescript'] = Object.create(null)
  for (const [name, tool] of Object.entries(agent.tools ?? {}))
    tools[name] = tool
  const toolsDir = join(dir, 'tools')
  if (existsSync(toolsDir))
    for (const file of readdirSync(toolsDir).sort()) {
      if (
        file.startsWith('.') ||
        file.endsWith('.test.ts') ||
        file.endsWith('.d.ts')
      )
        continue
      if (!file.endsWith('.ts'))
        throw new Error(
          `tools/${file}: a tool is a TypeScript file (.ts); move anything else out of tools/`,
        )
      const name = basename(file, '.ts')
      const problem = toolNameProblem(name)
      if (problem) throw new Error(`tools/${file}: ${problem} (its file name)`)
      if (Object.hasOwn(tools, name))
        throw new Error(
          `tools/${file}: agent.ts has a command tool named ${name} too; one name, one tool`,
        )
      const defined = (await import(pathToFileURL(join(toolsDir, file)).href))
        .default as Tool<z.ZodType> | undefined
      if (!defined?.description || !defined.inputSchema || !defined.execute)
        throw new Error(
          `tools/${file} must export default defineTool({ description, inputSchema, execute })`,
        )
      typescript[name] = defined
      tools[name] = {
        description: defined.description,
        file: `tools/${file}`,
        input: z.toJSONSchema(defined.inputSchema, { unrepresentable: 'any' }),
      }
    }
  const manifest = parseManifest(
    {
      name: agent.name,
      model: agent.model,
      instructions,
      tools,
      packages: agent.packages ?? [],
      domains: agent.domains ?? [],
      channels: agent.channels ?? [],
    },
    definition,
  )
  return { manifest, typescript }
}
