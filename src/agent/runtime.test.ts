import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chmod } from 'node:fs/promises'
import {
  COMMAND_OUTPUT_MAX,
  MAX_STEPS,
  loadAgent,
  modelFor,
  closedSchema,
  runCommand,
  runTurn,
} from './runtime'

/** An agent folder with one tool, `add`, as mirab init plus a tool would leave it. */
async function project() {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(join(resolve('.tmp'), 'runtime-'))
  await mkdir(join(root, 'agent/tools'), { recursive: true })
  await writeFile(
    join(root, 'agent/agent.ts'),
    "import { defineAgent } from 'mirab'\nexport default defineAgent({ name: 'gg.addis.agent.ops', model: 'anthropic/claude-sonnet-5-5' })\n",
  )
  await writeFile(join(root, 'agent/instructions.md'), 'You add numbers.\n')
  await writeFile(
    join(root, 'agent/tools/add.ts'),
    "import { defineTool } from 'mirab/tools'\nimport { z } from 'zod'\nexport default defineTool({ description: 'Add two numbers.', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => ({ sum: a + b }) })\n",
  )
  return root
}

/** A stand-in for the model API: asks for `add`, then answers with its result. */
function fakeModel() {
  const requests: { key: string | null; body: any }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json()
      requests.push({ key: request.headers.get('x-api-key'), body })
      const result = body.messages
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .find((part: any) => part.type === 'tool_result')
      const content = result
        ? [
            {
              type: 'text',
              text: `The sum is ${JSON.parse(result.content[0]?.text ?? result.content).sum}.`,
            },
          ]
        : [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'add',
              input: { a: 2, b: 3 },
            },
          ]
      return Response.json({
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content,
        stop_reason: result ? 'end_turn' : 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    },
  })
  return { server, requests, baseURL: `${server.url.origin}/v1` }
}

test('a turn loads the agent folder, calls its tool, and answers with the result', async () => {
  const root = await project()
  const model = fakeModel()
  try {
    const loaded = await loadAgent(root)
    expect(loaded.agent.name).toBe('gg.addis.agent.ops')
    expect(Object.keys(loaded.tools)).toEqual(['add'])
    const turn = await runTurn({
      loaded,
      model: modelFor(loaded.agent, {
        baseURL: model.baseURL,
        key: 'mirab-placeholder',
      }),
      history: [],
      message: 'What is 2 + 3?',
    })
    expect(turn.text).toBe('The sum is 5.')
    // Two model calls: the tool request, then the answer with the tool's result.
    expect(model.requests.length).toBe(2)
    expect(
      model.requests[0].body.system?.[0]?.text ?? model.requests[0].body.system,
    ).toContain('You add numbers.')
    expect(model.requests[0].body.tools.map((t: any) => t.name)).toEqual([
      'add',
    ])
    // The key is exactly the one given: in a VM, the placeholder the station replaces.
    expect(model.requests.map((r) => r.key)).toEqual([
      'mirab-placeholder',
      'mirab-placeholder',
    ])
    // The conversation carries over to the next turn.
    expect(turn.messages[0]).toEqual({
      role: 'user',
      content: 'What is 2 + 3?',
    })
    // The whole turn: the tool call and its result too, so the next turn has them.
    expect(turn.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(turn.truncated).toBe(false)
  } finally {
    model.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test('a tool file that is not a defineTool, or has a bad name, stops the load', async () => {
  const root = await project()
  try {
    await writeFile(join(root, 'agent/tools/broken.ts'), 'export default 42\n')
    await expect(loadAgent(root)).rejects.toThrow(
      'must export default defineTool',
    )
    await rm(join(root, 'agent/tools/broken.ts'))
    await writeFile(join(root, 'agent/tools/bad name.ts'), 'export default 1\n')
    await expect(loadAgent(root)).rejects.toThrow('(its file name)')
    await expect(loadAgent(join(root, 'nowhere'))).rejects.toThrow(
      'mirab init makes one',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a tool only runs with input that fits its own schema', async () => {
  const root = await project()
  const marker = join(root, 'ran')
  await writeFile(
    join(root, 'agent/tools/add.ts'),
    `import { writeFileSync } from 'node:fs'\nimport { defineTool } from 'mirab/tools'\nimport { z } from 'zod'\nexport default defineTool({ description: 'Add two numbers.', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: (input) => { writeFileSync(${JSON.stringify(marker)}, JSON.stringify(input)); return { sum: 0 } } })\n`,
  )
  // The model asks for add with a string where a number belongs, then stops.
  let calls = 0
  const seen: unknown[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json()
      seen.push(body.messages)
      calls++
      const content =
        calls === 1
          ? [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'add',
                input: { a: 'rm -rf /', b: 3 },
              },
            ]
          : [{ type: 'text', text: 'done' }]
      return Response.json({
        id: `msg_${calls}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content,
        stop_reason: calls === 1 ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
  })
  try {
    const loaded = await loadAgent(root)
    await runTurn({
      loaded,
      model: modelFor(loaded.agent, {
        baseURL: `${server.url.origin}/v1`,
        key: 'k',
      }),
      history: [],
      message: 'add',
    })
    expect(await Bun.file(marker).exists()).toBe(false)
    // The model was told the input didn't fit, in a second call.
    expect(calls).toBe(2)
    expect(JSON.stringify(seen[1])).toContain('"is_error":true')
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test('loading refuses other file types and names a bad agent.ts', async () => {
  const root = await project()
  try {
    await writeFile(join(root, 'agent/tools/helper.js'), 'export default 1\n')
    await expect(loadAgent(root)).rejects.toThrow('a tool is a TypeScript file')
    await rm(join(root, 'agent/tools/helper.js'))
    // A bad agent.ts names the file (a fresh project: imports are cached by path).
    const other = await project()
    await writeFile(
      join(other, 'agent/agent.ts'),
      "export default { name: 'ops', model: 'anthropic/x' }\n",
    )
    await expect(loadAgent(other)).rejects.toThrow('agent/agent.ts')
    await rm(other, { recursive: true, force: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** A model that answers every call with the content given for that call. */
function scripted(content: (call: number) => { type: string }[]) {
  let calls = 0
  const bodies: any[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json()
      bodies.push(body)
      calls++
      const parts = content(calls)
      return Response.json({
        id: `msg_${calls}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: parts,
        stop_reason: parts.some((p) => p.type === 'tool_use')
          ? 'tool_use'
          : 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
  })
  return {
    server,
    bodies,
    calls: () => calls,
    baseURL: `${server.url.origin}/v1`,
  }
}

const toolUse = (n: number) => ({
  type: 'tool_use',
  id: `toolu_${n}`,
  name: 'add',
  input: { a: 1, b: 2 },
})

test('a turn that never gets an answer stops at MAX_STEPS and says so', async () => {
  const root = await project()
  const model = scripted((n) => [toolUse(n)])
  try {
    const loaded = await loadAgent(root)
    const turn = await runTurn({
      loaded,
      model: modelFor(loaded.agent, { baseURL: model.baseURL, key: 'k' }),
      history: [],
      message: 'loop',
    })
    expect(model.calls()).toBe(MAX_STEPS)
    expect(turn.truncated).toBe(true)
    expect(turn.text).toBe('')
  } finally {
    model.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test("a tool's error reaches the model, and stays readable in the history", async () => {
  const root = await project()
  await writeFile(
    join(root, 'agent/tools/add.ts'),
    "import { defineTool } from 'mirab/tools'\nimport { z } from 'zod'\nexport default defineTool({ description: 'Add.', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: () => { throw new Error('the abacus is broken') } })\n",
  )
  const model = scripted((n) =>
    n === 1 ? [toolUse(n)] : [{ type: 'text', text: 'sorry' }],
  )
  try {
    const loaded = await loadAgent(root)
    const turn = await runTurn({
      loaded,
      model: modelFor(loaded.agent, { baseURL: model.baseURL, key: 'k' }),
      history: [],
      message: 'add',
    })
    expect(turn.truncated).toBe(false)
    expect(JSON.stringify(model.bodies[1].messages)).toContain(
      'the abacus is broken',
    )
    expect(JSON.stringify(turn.messages)).toContain('the abacus is broken')
  } finally {
    model.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test('the key and address come only from the arguments, never ANTHROPIC_* variables', async () => {
  const root = await project()
  const model = scripted(() => [{ type: 'text', text: 'hi' }])
  const trap = scripted(() => [{ type: 'text', text: 'trapped' }])
  const saved = {
    key: process.env.ANTHROPIC_API_KEY,
    url: process.env.ANTHROPIC_BASE_URL,
  }
  process.env.ANTHROPIC_API_KEY = 'sk-from-the-environment'
  process.env.ANTHROPIC_BASE_URL = trap.baseURL
  try {
    const loaded = await loadAgent(root)
    const turn = await runTurn({
      loaded,
      model: modelFor(loaded.agent, {
        baseURL: model.baseURL,
        key: 'placeholder',
      }),
      history: [],
      message: 'hi',
    })
    expect(turn.text).toBe('hi')
    expect(trap.calls()).toBe(0)
    expect(() =>
      modelFor(loaded.agent, { baseURL: model.baseURL, key: '' }),
    ).toThrow('a base URL and a key')
  } finally {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved.key
    if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = saved.url
    model.server.stop(true)
    trap.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

/** A project whose agent.ts declares one command tool, `upper`, run as `./bin/upper`. */
async function commandProject(script: string) {
  const root = await project()
  await writeFile(
    join(root, 'agent/agent.ts'),
    `import { defineAgent } from 'mirab'
export default defineAgent({
  name: 'gg.addis.agent.ops',
  model: 'anthropic/claude-sonnet-5-5',
  tools: {
    upper: {
      description: 'Upper-case a word.',
      command: './bin/upper',
      input: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false },
    },
  },
})
`,
  )
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin/upper'), `#!/bin/sh\n${script}\n`)
  await chmod(join(root, 'bin/upper'), 0o755)
  return root
}

const UPPER = `read -r line; w=$(printf '%s' "$line" | sed 's/.*"word":"\\([^"]*\\)".*/\\1/' | tr a-z A-Z); printf '{"upper":"%s"}' "$w"`

test("a command tool gets the model's input as JSON on stdin, and its JSON answer reaches the model", async () => {
  const root = await commandProject(UPPER)
  const model = scripted((n) =>
    n === 1
      ? [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'upper',
            input: { word: 'nix' },
          },
        ]
      : [{ type: 'text', text: 'done' }],
  )
  try {
    const loaded = await loadAgent(root)
    expect(Object.keys(loaded.tools).sort()).toEqual(['add', 'upper'])
    const turn = await runTurn({
      loaded,
      model: modelFor(loaded.agent, { baseURL: model.baseURL, key: 'k' }),
      history: [],
      message: 'shout nix',
    })
    expect(turn.text).toBe('done')
    expect(JSON.stringify(model.bodies[1].messages)).toContain('NIX')
    // The model saw the tool with its JSON Schema.
    const upper = model.bodies[0].tools.find((t: any) => t.name === 'upper')
    expect(upper.input_schema.required).toEqual(['word'])
  } finally {
    model.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test('a command tool never runs with input that does not fit its schema', async () => {
  const root = await commandProject(`touch ran; ${UPPER}`)
  const model = scripted((n) =>
    n === 1
      ? [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'upper',
            input: { word: 1, extra: '; rm -rf /' },
          },
        ]
      : [{ type: 'text', text: 'done' }],
  )
  try {
    const loaded = await loadAgent(root)
    await runTurn({
      loaded,
      model: modelFor(loaded.agent, { baseURL: model.baseURL, key: 'k' }),
      history: [],
      message: 'x',
    })
    expect(await Bun.file(join(root, 'ran')).exists()).toBe(false)
    expect(JSON.stringify(model.bodies[1].messages)).toContain(
      '"is_error":true',
    )
  } finally {
    model.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

const tool = (command: string, args: string[] = [], timeoutMs?: number) => ({
  description: 'x',
  command,
  args,
  input: { type: 'object' },
  timeoutMs,
})

test("a command tool sees only PATH and HOME of the loop's environment", async () => {
  process.env.MIRAB_TEST_SECRET = 'sk-should-stay-in-the-loop'
  try {
    const env = (await runCommand(
      tool('sh', [
        '-c',
        "cat >/dev/null; printf '\"%s\"' \"$(env | tr '\\n' ' ')\"",
      ]),
      '.',
      {},
    )) as string
    expect(env).not.toContain('sk-should-stay')
    expect(env).toContain('PATH=')
  } finally {
    delete process.env.MIRAB_TEST_SECRET
  }
})

test('a command tool that fails, answers with no JSON, runs too long or prints too much is an error', async () => {
  await expect(
    runCommand(tool('sh', ['-c', 'echo broken >&2; exit 3']), '.', {}),
  ).rejects.toThrow('exited 3: broken')
  await expect(
    runCommand(tool('sh', ['-c', 'echo not json']), '.', {}),
  ).rejects.toThrow("didn't answer with JSON")
  const t0 = Date.now()
  await expect(runCommand(tool('sleep', ['10'], 200), '.', {})).rejects.toThrow(
    'was stopped',
  )
  expect(Date.now() - t0).toBeLessThan(5000)
  await expect(
    runCommand(
      tool('sh', ['-c', `head -c ${COMMAND_OUTPUT_MAX + 10} /dev/zero`]),
      '.',
      {},
    ),
  ).rejects.toThrow('printed more than')
  await expect(runCommand(tool('./no-such-tool'), '.', {})).rejects.toThrow(
    "didn't run",
  )
  // The arguments are the command's own: no shell reads them.
  expect(
    await runCommand(tool('printf', ['"%s"', '$(touch pwned)']), '.', {}),
  ).toBe('$(touch pwned)')
})

test('stopping a command tool stops what it started, and so does its own exit', async () => {
  // A child left in the background would hold the pipes and outlive the call.
  const t0 = Date.now()
  await expect(
    runCommand(tool('sh', ['-c', 'sleep 30 & wait'], 300), '.', {}),
  ).rejects.toThrow('ran longer than 300 ms')
  expect(Date.now() - t0).toBeLessThan(3000)
  // A clean exit that leaves something behind: the answer arrives, the leftover is gone.
  await mkdir(resolve('.tmp'), { recursive: true })
  const pidFile = join(await mkdtemp(join(resolve('.tmp'), 'pid-')), 'pid')
  const t1 = Date.now()
  expect(
    await runCommand(
      tool('sh', ['-c', `sleep 30 & echo $! > ${pidFile}; echo '{"ok":true}'`]),
      '.',
      {},
    ),
  ).toEqual({ ok: true })
  expect(Date.now() - t1).toBeLessThan(3000)
  const pid = Number(await Bun.file(pidFile).text())
  await Bun.sleep(50)
  expect(() => process.kill(pid, 0)).toThrow()
  // The turn ending stops it too.
  const ac = new AbortController()
  const call = runCommand(
    tool('sh', ['-c', 'sleep 30 & wait']),
    '.',
    {},
    ac.signal,
  )
  setTimeout(() => ac.abort(), 100)
  await expect(call).rejects.toThrow('the turn ended')
})

test('a command tool gets only the keys its schema lists, though the model sends more', async () => {
  const root = await commandProject(`cat > got.json; echo '{}'`)
  // An open schema, as a tool author might write it.
  await writeFile(
    join(root, 'agent/agent.ts'),
    (await Bun.file(join(root, 'agent/agent.ts')).text()).replace(
      ', additionalProperties: false',
      '',
    ),
  )
  const model = scripted((n) =>
    n === 1
      ? [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'upper',
            input: { word: 'a', extra: 'x' },
          },
        ]
      : [{ type: 'text', text: 'done' }],
  )
  try {
    const loaded = await loadAgent(root)
    await runTurn({
      loaded,
      model: modelFor(loaded.agent, { baseURL: model.baseURL, key: 'k' }),
      history: [],
      message: 'x',
    })
    // Refused as it stands (the schema is closed), so nothing ran with "extra".
    expect(await Bun.file(join(root, 'got.json')).exists()).toBe(false)
    expect(
      closedSchema<object>({
        type: 'object',
        properties: { a: { type: 'object' } },
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'object', additionalProperties: false } },
      additionalProperties: false,
    })
    expect(
      closedSchema<object>({ type: 'object', additionalProperties: true }),
    ).toEqual({
      type: 'object',
      additionalProperties: true,
    })
  } finally {
    model.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
