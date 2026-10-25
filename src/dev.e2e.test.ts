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
      // It leaves a mark wherever it runs: only ever in the VM's clone.
      "import { writeFileSync } from 'node:fs'\nimport { defineAgent } from 'mirab'\nwriteFileSync(new URL('./ran-here', import.meta.url), process.platform)\nexport default defineAgent({ name: 'gg.addis.agent.ops', model: 'anthropic/claude-sonnet-5-5' })\n",
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
    // What the VM printed, raw, and what the agent said in the chat.
    let screen = ''
    dev.pty.onData((d) => (screen += d.toString()))
    const said: string[] = []
    dev.channel.onMessage((m) => {
      if (m.from === dev.agent) said.push(m.note ? `(${m.text})` : m.text)
    })
    const until = async (text: string) => {
      for (let i = 0; i < 300 && !said.some((s) => s.includes(text)); i++)
        await Bun.sleep(50)
      expect(said.join('\n')).toContain(text)
    }
    try {
      await until('is here')
      dev.say('hello')
      await until('real key: true')
      expect(asked).toEqual(['personal/anthropic/API_KEY'])
      expect(keys).toEqual(['sk-real-from-harar'])
      // The chat is the station's channel: both members, and it keeps what was said.
      expect(dev.channel.members.map((m) => m.name)).toEqual([
        dev.person,
        'gg.addis.agent.ops',
      ])
      const transcript = await readFile(dev.channel.path, 'utf8')
      expect(transcript).toContain('"text":"hello"')
      expect(transcript).toContain('real key: true')
      expect(transcript).not.toContain('sk-real')
      expect(await readFile(auditLog, 'utf8')).not.toContain('sk-real')
      expect(screen).not.toContain('sk-real')
      // The host never ran the project's code.
      expect(await Bun.file(join(project, 'agent/ran-here')).exists()).toBe(
        false,
      )
    } finally {
      await dev.close()
      api.stop(true)
      hararServer.close()
      await rm(base, { recursive: true, force: true })
    }
  }, 120_000)
})
