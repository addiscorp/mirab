import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadAgent, modelFor, runTurn } from './runtime'

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
    expect(turn.messages.at(-1)?.role).toBe('assistant')
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
    await expect(loadAgent(root)).rejects.toThrow(
      "a tool's name is its file name",
    )
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
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json()
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
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
