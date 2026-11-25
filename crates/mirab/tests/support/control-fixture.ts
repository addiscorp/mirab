// `mirab control` for the live tests: the real server and a real VM, with the
// outside world replaced. A stand-in model scripts the agent's turns, a
// stand-in harar holds a fake key, and `held.test` is a local HTTPS server
// that records what reaches it. No paid call, no real secret.
//
//   bun control-fixture.ts <config dir> <world log>
import { appendFileSync } from 'node:fs'
import { createServer as httpsServer } from 'node:https'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { stationAuthority } from 'rixse'
import { serveControl } from '../../../../src/control/server'

const [configDir, worldLog] = process.argv.slice(2) as [string, string]
const FAKE_KEY = 'sk-fixture-not-a-real-key'

const harar = join(configDir, 'h.sock')
createServer((conn) => {
  let body = ''
  conn.on('data', (c) => (body += c))
  conn.on('end', () => {
    const { op } = JSON.parse(body)
    conn.end(
      JSON.stringify(
        op === 'hosts'
          ? { ok: true, hosts: [] }
          : { ok: true, value: FAKE_KEY },
      ),
    )
  })
}).listen(harar)
await Bun.write(
  join(configDir, 'station.json'),
  JSON.stringify({
    harar: { socket: harar },
    models: { anthropic: { key: 'personal/anthropic/API_KEY' } },
    human: 'gg.addis.human.tester',
  }),
)

const reply = (model: string, content: unknown[], stop: string) =>
  Response.json({
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    usage: { input_tokens: 1, output_tokens: 1 },
  })

const api = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      model: string
      messages: { role: string; content: string | Record<string, any>[] }[]
    }
    const last = body.messages.at(-1)!
    const parts =
      typeof last.content === 'string'
        ? [{ type: 'text', text: last.content }]
        : last.content
    if (parts.some((p) => p.type === 'tool_result'))
      return reply(
        body.model,
        [{ type: 'text', text: 'the post is waiting for a person' }],
        'end_turn',
      )
    const text = parts.find((p) => p.type === 'text')?.text ?? ''
    if (text === 'post it')
      return reply(
        body.model,
        [{ type: 'tool_use', id: 'toolu_1', name: 'post', input: {} }],
        'tool_use',
      )
    return reply(body.model, [{ type: 'text', text: `pong: ${text}` }], 'end_turn')
  },
})

const authority = await stationAuthority(join(configDir, 'world'))
const leaf = await authority.leaf(['held.test'])
const world = httpsServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    appendFileSync(
      worldLog,
      JSON.stringify({ method: req.method, url: req.url, body }) + '\n',
    )
    res.end('{"paid":true}')
  })
})
await new Promise<void>((r) => world.listen(0, '127.0.0.1', r))
const port = (world.address() as { port: number }).port

const stop = () => process.stdin.destroy()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(signal, stop)

await serveControl({
  input: process.stdin,
  write: (line) => void process.stdout.write(line),
  configDir,
  version: 'fixture',
  self: [
    process.execPath,
    'run',
    resolve(import.meta.dir, '../../../../src/mirab.ts'),
  ],
  log: (line) => console.error(line),
  upstream: api.url.origin,
  opened: async () => ({ address: '127.0.0.1', port, ca: authority.cert }),
})
process.exit(0)
