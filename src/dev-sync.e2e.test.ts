// Live sync in a real VM: the person edits the agent on the host during a
// `mirab dev` session and the next turn has it; what the VM writes comes back
// at the end, and a path both changed keeps the person's version, the agent's
// saved aside. Needs a Mac with a vz guest image described in
// $TEST_VZ_CONFIG_DIR/isolation.json (docs/VM.md).
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { startDev } from './dev'

const configDir = process.env.TEST_VZ_CONFIG_DIR

describe.skipIf(!configDir)('mirab dev live sync in a vz VM, live', () => {
  test('edits on the host reach the next turn, and the VM’s work comes back', async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const base = await mkdtemp(join(resolve('.tmp'), 'live-e2e-'))
    const project = join(base, 'project')
    await mkdir(join(project, 'agent'), { recursive: true })
    await writeFile(
      join(project, 'agent/agent.ts'),
      "import { defineAgent } from 'mirab'\nexport default defineAgent({ name: 'gg.addis.agent.ops', model: 'anthropic/claude-sonnet-5-5' })\n",
    )
    await writeFile(join(project, 'agent/instructions.md'), 'Be brief.\n')
    await writeFile(join(project, 'notes.md'), 'v1\n')
    const harar = join(base, 'h.sock')
    const hararServer = createServer((conn) => {
      conn.on('data', () => {})
      conn.on('end', () =>
        conn.end(JSON.stringify({ ok: true, value: 'sk-real' })),
      )
    })
    await new Promise<void>((r) => hararServer.listen(harar, r))
    const systems: string[] = []
    const api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = await request.json()
        systems.push(JSON.stringify(body.system ?? ''))
        return Response.json({
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: `turn ${systems.length}` }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      },
    })
    const logs: string[] = []
    const dev = await startDev({
      project,
      configDir: configDir!,
      station: {
        harar: { socket: harar },
        models: { anthropic: { key: 'personal/anthropic/API_KEY' } },
      },
      cols: 100,
      rows: 30,
      auditLog: join(base, 'egress.log'),
      upstream: api.url.origin,
      log: (line) => void logs.push(line),
    })
    // What the agent said in the chat.
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
      await until('turn 1')
      // The person edits the agent, and a note the agent will also change.
      await dev.iso.exec(
        [
          'sh',
          '-c',
          'echo agent > /workspace/notes.md; echo made > /workspace/made-in-vm.txt',
        ],
        {
          cwd: '/workspace',
          env: { PATH: '/usr/bin:/bin' },
          timeoutMs: 10_000,
          signal: new AbortController().signal,
          onLine: async () => {},
        },
      )
      await writeFile(
        join(project, 'agent/instructions.md'),
        'Answer in French, always.\n',
      )
      await writeFile(join(project, 'notes.md'), 'person\n')
      const { pushed, kept } = await dev.live.push()
      expect(pushed).toContain('agent/instructions.md')
      expect(kept).toEqual(['notes.md'])
      dev.say('again')
      await until('turn 2')
      expect(systems[0]).toContain('Be brief.')
      expect(systems[1]).toContain('Answer in French, always.')
      expect(said).toContain('(the agent changed; reloaded)')
    } finally {
      await dev.close()
      api.stop(true)
      hararServer.close()
    }
    try {
      // What the VM made came back; the person's note stayed; the agent's was saved aside.
      expect(await readFile(join(project, 'made-in-vm.txt'), 'utf8')).toBe(
        'made\n',
      )
      expect(await readFile(join(project, 'notes.md'), 'utf8')).toBe('person\n')
      expect(logs.some((l) => l.startsWith('back from the VM:'))).toBe(true)
      expect(logs.join('\n')).toContain('notes.md')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  }, 180_000)
})
