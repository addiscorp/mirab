import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { chat } from './guest'

test('the terminal chat runs turns until its input ends, and keeps the conversation', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(join(resolve('.tmp'), 'chat-'))
  await mkdir(join(root, 'agent'), { recursive: true })
  await writeFile(
    join(root, 'agent/agent.ts'),
    "import { defineAgent } from 'mirab'\nexport default defineAgent({ name: 'gg.addis.agent.ops', model: 'anthropic/claude-sonnet-5-5' })\n",
  )
  const bodies: any[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json()
      bodies.push(body)
      return Response.json({
        id: `msg_${bodies.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: `answer ${bodies.length}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
  })
  const input = new PassThrough()
  const output = new PassThrough()
  let printed = ''
  output.on('data', (c) => (printed += c))
  try {
    const done = chat(root, input, output, {
      baseURL: `${server.url.origin}/v1`,
      key: 'k',
    })
    input.write('first\n')
    input.write('second\n')
    input.end()
    await done
    expect(printed).toContain('gg.addis.agent.ops is here')
    expect(printed).toContain('ops> answer 1')
    expect(printed).toContain('ops> answer 2')
    // The second turn carries the first.
    expect(JSON.stringify(bodies[1].messages)).toContain('first')
    expect(JSON.stringify(bodies[1].messages)).toContain('answer 1')
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test('an edit to the agent between turns is picked up, and the conversation goes on', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(join(resolve('.tmp'), 'reload-'))
  await mkdir(join(root, 'agent'), { recursive: true })
  await writeFile(
    join(root, 'agent/agent.ts'),
    "import { defineAgent } from 'mirab'\nexport default defineAgent({ name: 'gg.addis.agent.ops', model: 'anthropic/claude-sonnet-5-5' })\n",
  )
  await writeFile(join(root, 'agent/instructions.md'), 'Be brief.\n')
  const bodies: any[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json()
      bodies.push(body)
      return Response.json({
        id: `msg_${bodies.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: `answer ${bodies.length}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
  })
  const input = new PassThrough()
  const output = new PassThrough()
  let printed = ''
  output.on('data', (c) => (printed += c))
  const system = (body: any) => JSON.stringify(body.system ?? '')
  try {
    const done = chat(root, input, output, {
      baseURL: `${server.url.origin}/v1`,
      key: 'k',
    })
    input.write('first\n')
    for (let i = 0; i < 100 && !printed.includes('answer 1'); i++)
      await Bun.sleep(20)
    await writeFile(
      join(root, 'agent/instructions.md'),
      'Answer in French, always.\n',
    )
    input.write('second\n')
    input.end()
    await done
    expect(system(bodies[0])).toContain('Be brief.')
    expect(system(bodies[1])).toContain('Answer in French, always.')
    expect(printed).toContain('(the agent changed; reloaded)')
    expect(JSON.stringify(bodies[1].messages)).toContain('answer 1')
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
