// Claude Code in a VM on the person's own subscription: `mirab spawn --vm`
// runs it with a placeholder token, and the station adds the real one, from
// harar, on the way out. Needs a VM guest image (it has Claude Code,
// guest-agent/rootfs.Dockerfile) described in
// $TEST_VM_CONFIG_DIR/isolation.json (docs/VM.md). The model API is a
// stand-in, so no real token or subscription is used.
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { startVmChild } from './spawn-vm'

const configDir = process.env.TEST_VM_CONFIG_DIR

const sse = (events: [string, unknown][]) =>
  events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')

describe.skipIf(!configDir)('Claude Code in a VM, live', () => {
  test('claude -p in the VM reaches the API with the token from harar, which the VM never holds', async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const base = await mkdtemp(join(resolve('.tmp'), 'claude-vm-'))
    const work = join(base, 'work')
    await mkdir(work)
    await writeFile(join(work, 'README.md'), 'a project\n')
    const harar = join(base, 'h.sock')
    const asked: string[] = []
    const hararServer = createServer((conn) => {
      let body = ''
      conn.on('data', (c) => (body += c))
      conn.on('end', () => {
        asked.push(JSON.parse(body).key)
        conn.end(JSON.stringify({ ok: true, value: 'sk-ant-oat01-real' }))
      })
    })
    await new Promise<void>((r) => hararServer.listen(harar, r))
    const seen: { path: string; auth: string | null; beta: string | null }[] =
      []
    const api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        seen.push({
          path: url.pathname,
          auth: request.headers.get('authorization'),
          beta: request.headers.get('anthropic-beta'),
        })
        const body = await request.json()
        const real =
          request.headers.get('authorization') === 'Bearer sk-ant-oat01-real'
        const message = {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }
        return new Response(
          sse([
            ['message_start', { type: 'message_start', message }],
            [
              'content_block_start',
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              },
            ],
            [
              'content_block_delta',
              {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'text_delta',
                  text: `subscription token: ${real}`,
                },
              },
            ],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            [
              'message_delta',
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 3 },
              },
            ],
            ['message_stop', { type: 'message_stop' }],
          ]),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const auditLog = join(base, 'egress.log')
    const child = await startVmChild({
      configDir: configDir!,
      sessionId: 'claude-e2e',
      cwd: work,
      binary: 'claude',
      args: ['-p', 'say hello'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' },
      cols: 100,
      rows: 30,
      station: {
        config: {
          harar: { socket: harar },
          models: { claude: { token: 'personal/claude/OAUTH_TOKEN' } },
        },
        auditLog,
        upstream: api.url.origin,
      },
    })
    let screen = ''
    child.onData((d) => (screen += d.toString()))
    try {
      const code = await new Promise<number>((r) =>
        child.onExit(({ exitCode }) => r(exitCode)),
      )
      expect(screen).toContain('subscription token: true')
      expect(code).toBe(0)
      expect(asked).toEqual(['personal/claude/OAUTH_TOKEN'])
      // Only the messages API, with the swapped token and the OAuth beta.
      expect(seen.length).toBeGreaterThan(0)
      for (const r of seen) {
        expect(r.path).toBe('/v1/messages')
        expect(r.auth).toBe('Bearer sk-ant-oat01-real')
        expect(r.beta).toContain('oauth-')
      }
      const audit = await readFile(auditLog, 'utf8')
      expect(audit).not.toContain('sk-ant')
      // Nothing went around the station.
      expect(audit).not.toContain('"kind":"connect"')
      expect(screen).not.toContain('sk-ant')
    } finally {
      await child.dispose().catch(() => {})
      api.stop(true)
      hararServer.close()
      await rm(base, { recursive: true, force: true })
    }
  }, 180_000)
})
