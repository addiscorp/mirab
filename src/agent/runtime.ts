// The loop that runs inside the agent's VM (docs/architecture.md section 3):
// it loads the agent folder and runs turns, calling tools as the model asks.
// Where the model is and what key to send are given by whoever starts it (in
// the VM: the station's loopback route and a placeholder); the runtime never
// reads an environment variable or a .env for them.
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAnthropic } from '@ai-sdk/anthropic'
import {
  generateText,
  stepCountIs,
  dynamicTool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import type { z } from 'zod'
import { agentSchema, type Agent, type Tool } from './define'

/** A tool's name is its file's name; the model sees exactly that. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** Turns stop after this many model calls, so a tool loop can't run forever. */
export const MAX_STEPS = 20
/** How long one tool call, and one whole turn, may take. */
export const TOOL_TIMEOUT_MS = 5 * 60_000
export const TURN_TIMEOUT_MS = 30 * 60_000

export interface LoadedAgent {
  agent: Agent
  instructions: string
  tools: ToolSet
}

/** Loads `<project>/agent`: agent.ts, instructions.md and tools/*.ts. */
export async function loadAgent(project: string): Promise<LoadedAgent> {
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
  const tools: ToolSet = Object.create(null)
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
      if (!TOOL_NAME.test(name))
        throw new Error(
          `tools/${file}: a tool's name is its file name, [a-zA-Z0-9_-] up to 64 characters`,
        )
      const defined = (await import(pathToFileURL(join(toolsDir, file)).href))
        .default as Tool<z.ZodType> | undefined
      if (!defined?.description || !defined.inputSchema || !defined.execute)
        throw new Error(
          `tools/${file} must export default defineTool({ description, inputSchema, execute })`,
        )
      // The model's input is checked against the tool's own schema first.
      tools[name] = dynamicTool({
        description: defined.description,
        inputSchema: defined.inputSchema,
        execute: async (input) => defined.execute(input),
      })
    }
  return { agent, instructions, tools }
}

export interface ModelEndpoint {
  /** Base URL of the model API, e.g. the station's `http://127.0.0.1:8790/anthropic`. */
  baseURL: string
  /** What to send as the key: in a VM, a placeholder the station replaces. */
  key: string
}

/** The model an agent names (`provider/model`), at the given endpoint. */
export function modelFor(agent: Agent, endpoint: ModelEndpoint): LanguageModel {
  // Always strings: the provider would fall back to ANTHROPIC_* variables otherwise.
  if (!endpoint.key || !endpoint.baseURL)
    throw new Error('the model endpoint needs a base URL and a key')
  const [provider, id] = agent.model.split('/')
  if (provider !== 'anthropic')
    throw new Error(
      `mirab talks to anthropic models for now; ${agent.model} isn't one`,
    )
  return createAnthropic({ baseURL: endpoint.baseURL, apiKey: endpoint.key })(
    id,
  )
}

export interface TurnResult {
  text: string
  /** The turn hit MAX_STEPS model calls before the model answered. */
  truncated: boolean
  /** The conversation after this turn, for the next one. */
  messages: ModelMessage[]
}

/** One turn: the person's message in, the agent's answer out, with any tool calls between. */
export async function runTurn(options: {
  loaded: LoadedAgent
  model: LanguageModel
  history: ModelMessage[]
  message: string
  signal?: AbortSignal
}): Promise<TurnResult> {
  const messages: ModelMessage[] = [
    ...options.history,
    { role: 'user', content: options.message },
  ]
  const result = await generateText({
    model: options.model,
    instructions: options.loaded.instructions,
    messages,
    tools: options.loaded.tools,
    stopWhen: stepCountIs(MAX_STEPS),
    timeout: { totalMs: TURN_TIMEOUT_MS, toolMs: TOOL_TIMEOUT_MS },
    abortSignal: options.signal,
  })
  return {
    text: result.text,
    truncated: result.finishReason === 'tool-calls',
    // Every step's messages (tool calls and results too), not just the last.
    messages: [...messages, ...result.responseMessages],
  }
}
