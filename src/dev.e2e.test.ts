// mirab dev in a real VM: the agent loop boots in the guest with no
// node_modules, the person's terminal talks to it, and its model calls leave
// only through the station, which adds the key it got from harar. Needs a Mac
// with a vz guest image described in $TEST_VZ_CONFIG_DIR/isolation.json
// (docs/VM.md).
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { startDev } from './dev'

const configDir = process.env.TEST_VZ_CONFIG_DIR

describe.skipIf(!configDir)('mirab dev in a vz VM, live', () => {
  test('a chat turn in the guest reaches the model with the key from harar, which the VM never sees', async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const base = await mkdtemp(join(resolve('.tmp'), 'dev-e2e-'))
    const project = join(base, 'project')
    await mkdir(join(project, 'agent'), { recursive: true })
    await writeFile(
      join(project, 'agent/agent.ts'),
      "import { defineAgent } from 'mirab'\nexport default defineAgent({ name: 'gg.addis.agent.ops', model: 'anthropic/claude-sonnet-5-5' })\n",
    )
    // harar on the host: the only place the real key is.
    const harar = join(base, 'h.sock')
    const asked: string[] = []
    const hararServer = createServer((conn) => {
      let body = ''
      conn.on('data', (c) => (body += c))
      conn.on('end', () => {
        asked.push(JSON.parse(body).key)
        conn.end(JSON.stringify({ ok: true, value: 'sk-real-from-harar' }))
      })
    })
    await new Promise<void>((r) => hararServer.listen(harar, r))
    // The model API: it says whether the real key arrived.
    const keys: (string | null)[] = []
    const api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        keys.push(request.headers.get('x-api-key'))
        const body = await request.json()
        return Response.json({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [
            {
              type: 'text',
              text: `real key: ${request.headers.get('x-api-key') === 'sk-real-from-harar'}`,
            },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      },
    })
    const auditLog = join(base, 'egress.log')
    const dev = await startDev({
      project,
      configDir: configDir!,
      station: {
        harar: { socket: harar },
        models: { anthropic: { key: 'personal/anthropic/API_KEY' } },
      },
      cols: 100,
      rows: 30,
      auditLog,
      upstream: api.url.origin,
    })
    let screen = ''
    dev.pty.onData((d) => (screen += d.toString()))
    const exited = new Promise<number>((r) => dev.pty.onExit(r))
    const until = async (text: string) => {
      for (let i = 0; i < 300 && !screen.includes(text); i++)
        await Bun.sleep(50)
      expect(screen).toContain(text)
    }
    try {
      await until('you> ')
      dev.pty.write('hello\r')
      await until('ops> real key: true')
      expect(asked).toEqual(['personal/anthropic/API_KEY'])
      expect(keys).toEqual(['sk-real-from-harar'])
      // Ctrl-D ends the chat, and the loop with it.
      dev.pty.write('\x04')
      expect(await exited).toBe(0)
      expect(await readFile(auditLog, 'utf8')).not.toContain('sk-real')
      expect(screen).not.toContain('sk-real')
    } finally {
      await dev.close()
      api.stop(true)
      hararServer.close()
      await rm(base, { recursive: true, force: true })
    }
  }, 120_000)
})
