import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { CONTROL_PROTOCOL, eventSchema, operations } from './protocol'
import { serveControl, syncSummary } from './server'

async function talk(lines: unknown[], configDir = '/nonexistent-mirab-config') {
  const input = new PassThrough()
  const out: Record<string, any>[] = []
  const done = serveControl({
    input,
    write: (line) => {
      expect(line.endsWith('\n')).toBe(true)
      out.push(JSON.parse(line))
    },
    configDir,
    version: '1.2.3',
    self: ['false'],
  })
  for (const line of lines)
    input.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\n')
  input.end()
  await done
  return out
}

const hello = { id: 1, op: 'hello', params: { protocol: CONTROL_PROTOCOL } }
const errorOf = (out: Record<string, any>[], id: number) =>
  out.find((f) => f.id === id)?.error?.code

describe('mirab control', () => {
  test('nothing runs before hello', async () => {
    const out = await talk([{ id: 7, op: 'sessions' }])
    expect(errorOf(out, 7)).toBe('not_ready')
  })

  test('hello refuses another protocol, and says its version', async () => {
    const out = await talk([
      { id: 1, op: 'hello', params: { protocol: CONTROL_PROTOCOL + 1 } },
      { id: 2, op: 'sessions' },
    ])
    expect(errorOf(out, 1)).toBe('unsupported_protocol')
    expect(out[0]!.error.message).toContain('1.2.3')
    expect(errorOf(out, 2)).toBe('not_ready')
  })

  test('a bad line is answered, and the next one still works', async () => {
    const out = await talk([
      hello,
      'not json',
      { id: 2, op: 'no_such_op' },
      { id: 3, op: 'constructor' },
      { id: 4, op: 'send', params: { session: 5 } },
      { id: 5, op: 'sessions' },
    ])
    expect(out.find((f) => f.id === null)?.error.code).toBe('bad_request')
    for (const id of [2, 3, 4]) expect(errorOf(out, id)).toBe('bad_request')
    expect(out.find((f) => f.id === 5)?.result).toEqual({ sessions: [] })
  })

  test('operations on a session that is not there name it', async () => {
    const out = await talk([
      hello,
      { id: 2, op: 'send', params: { session: 's_x', text: 'hi' } },
      { id: 3, op: 'stop', params: { session: 's_x' } },
      { id: 4, op: 'requests', params: { session: 's_x' } },
      {
        id: 5,
        op: 'decide',
        params: { session: 's_x', request: 'r_1', decision: 'no' },
      },
      { id: 6, op: 'file_get', params: { session: 's_x', path: '/a' } },
    ])
    for (const id of [2, 3, 4, 5, 6])
      expect(errorOf(out, id)).toBe('no_session')
  })

  test("another program's spawned sessions are out of reach", async () => {
    const out = await talk([
      hello,
      { id: 2, op: 'spawn_stop', params: { session: 'someone-elses' } },
      {
        id: 3,
        op: 'spawn_send',
        params: { session: 'someone-elses', text: 'hi' },
      },
    ])
    expect(errorOf(out, 2)).toBe('no_session')
    expect(errorOf(out, 3)).toBe('no_session')
  })

  test('a project is an absolute path', async () => {
    const out = await talk([
      hello,
      { id: 2, op: 'start', params: { project: 'relative/path' } },
    ])
    expect(errorOf(out, 2)).toBe('bad_request')
  })

  test('availability gives a typed reason and downloads nothing', async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const base = await mkdtemp(join(resolve('.tmp'), 'control-'))
    try {
      const none = await talk([hello, { id: 2, op: 'availability' }], base)
      expect(none.find((f) => f.id === 2)?.result.reason).toBe('not_configured')
      await writeFile(
        join(base, 'isolation.json'),
        JSON.stringify({
          vm: {
            kernel: join(base, 'no-kernel'),
            rootfs: join(base, 'no-root'),
          },
        }),
      )
      const missing = await talk([hello, { id: 2, op: 'availability' }], base)
      const result = missing.find((f) => f.id === 2)?.result
      expect(result.available).toBe(false)
      expect(result.reason).toBe('image_missing')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test('the sync summary carries everything the protocol names', () => {
    const summary = syncSummary({
      written: ['a'],
      deleted: ['b'],
      conflicts: [{ path: 'c', reason: 'both' }],
      held: [{ path: 'agent/x', reason: 'self' }],
      rejected: [{ path: 'd', reason: 'link' }],
      recovery: { directory: '/r', note: '/r/n' },
    })
    expect(operations.stop.result.parse({ sync: summary }).sync).toEqual(
      summary,
    )
  })

  test('an event from a VM that does not fit is not passed on', () => {
    expect(
      eventSchema.safeParse({ event: 'held', session: 's', request: {} })
        .success,
    ).toBe(false)
  })
})
