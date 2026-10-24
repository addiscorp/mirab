// The loop that runs inside the agent's VM (docs/architecture.md section 3):
// it loads the agent folder and runs turns, calling tools as the model asks.
// Where the model is and what key to send are given by whoever starts it (in
// the VM: the station's loopback route and a placeholder); the runtime never
// reads an environment variable or a .env for them.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createAnthropic } from '@ai-sdk/anthropic'
import {
  generateText,
  stepCountIs,
  dynamicTool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import { z } from 'zod'
import type { CommandTool } from './define'
import { loadManifest, type Manifest } from './manifest'

/** Turns stop after this many model calls, so a tool loop can't run forever. */
export const MAX_STEPS = 20
/** How long one tool call, and one whole turn, may take. */
export const TOOL_TIMEOUT_MS = 5 * 60_000
export const TURN_TIMEOUT_MS = 30 * 60_000
/** The most a command tool may print, on stdout or stderr. */
export const COMMAND_OUTPUT_MAX = 1024 * 1024

export interface LoadedAgent {
  agent: Manifest
  tools: ToolSet
}

/** Loads `<project>/agent` and makes its manifest's tools callable. */
export async function loadAgent(project: string): Promise<LoadedAgent> {
  const root = resolve(project)
  const { manifest, typescript } = await loadManifest(root)
  // No prototype, so a tool named __proto__ is a tool like any other.
  const tools: ToolSet = Object.create(null)
  for (const [name, tool] of Object.entries(manifest.tools)) {
    // The model's input is checked against the tool's own schema first.
    tools[name] =
      'file' in tool
        ? dynamicTool({
            description: tool.description,
            inputSchema: typescript[name].inputSchema,
            execute: async (input) => typescript[name].execute(input),
          })
        : dynamicTool({
            description: tool.description,
            inputSchema: z.fromJSONSchema(tool.input),
            execute: (input, { abortSignal }) =>
              runCommand(tool, root, input, abortSignal),
          })
  }
  return { agent: manifest, tools }
}

/** Runs a command tool: input as JSON on stdin, its JSON answer from stdout.
 *  No shell, the project as its working directory, and only PATH and HOME
 *  from the loop's environment, so a tool never sees what the loop was given. */
export function runCommand(
  tool: CommandTool,
  cwd: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((done, fail) => {
    const child = spawn(tool.command, tool.args ?? [], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? cwd,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      timeout: tool.timeoutMs ?? TOOL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let tooMuch = false
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length
      if (size > COMMAND_OUTPUT_MAX) {
        tooMuch = true
        child.kill('SIGKILL')
      } else into.push(chunk)
    }
    child.stdout!.on('data', collect(out))
    child.stderr!.on('data', collect(err))
    // A command that exits without reading its input is not an error here.
    child.stdin!.on('error', () => {})
    child.stdin!.end(JSON.stringify(input))
    child.on('error', (e) =>
      fail(new Error(`${tool.command} didn't run: ${e.message}`)),
    )
    child.on('close', (code, killed) => {
      const stderr = Buffer.concat(err).toString('utf8').trim().slice(-2000)
      if (tooMuch)
        return fail(
          new Error(
            `${tool.command} printed more than ${COMMAND_OUTPUT_MAX} bytes`,
          ),
        )
      if (killed)
        return fail(new Error(`${tool.command} was stopped (${killed})`))
      if (code !== 0)
        return fail(
          new Error(
            `${tool.command} exited ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      const stdout = Buffer.concat(out).toString('utf8')
      try {
        done(JSON.parse(stdout))
      } catch {
        fail(new Error(`${tool.command} didn't answer with JSON on stdout`))
      }
    })
  })
}

export interface ModelEndpoint {
  /** Base URL of the model API, e.g. the station's `http://127.0.0.1:8790/anthropic`. */
  baseURL: string
  /** What to send as the key: in a VM, a placeholder the station replaces. */
  key: string
}

/** The model an agent names (`provider/model`), at the given endpoint. */
export function modelFor(
  agent: Pick<Manifest, 'model'>,
  endpoint: ModelEndpoint,
): LanguageModel {
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
    instructions: options.loaded.agent.instructions,
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
