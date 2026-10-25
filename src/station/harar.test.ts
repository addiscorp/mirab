import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { loadStationConfig } from './config'
import { hararGet, hararHosts, hararSend } from './harar'

/** A stand-in harar primary: records each request, answers with `reply`. */
async function fakeHarar(reply: (request: any) => string) {
  await mkdir(resolve('.tmp'), { recursive: true })
  const dir = await mkdtemp(join(resolve('.tmp'), 'h-'))
  const socket = join(dir, 'h.sock')
  const requests: any[] = []
  const server = createServer((conn) => {
    let body = ''
    conn.on('data', (c) => (body += c))
    // harar reads until the client closes its write side, then answers.
    conn.on('end', () => {
      const request = JSON.parse(body)
      requests.push(request)
      conn.end(reply(request))
    })
  })
  await new Promise<void>((r) => server.listen(socket, r))
  return {
    socket,
    requests,
    stop: async () => {
      server.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('the station gets one secret from harar, asking exactly for it', async () => {
  const harar = await fakeHarar(() =>
    JSON.stringify({ ok: true, value: 'sk-real' }),
  )
  try {
    expect(await hararGet(harar.socket, 'personal/anthropic/API_KEY')).toBe(
      'sk-real',
    )
    expect(harar.requests).toEqual([
      { op: 'get', key: 'personal/anthropic/API_KEY' },
    ])
  } finally {
    await harar.stop()
  }
})

test("harar's refusal, a garbled answer or no harar at all is an error naming why", async () => {
  const refused = await fakeHarar(() =>
    JSON.stringify({ ok: false, error: 'no_binding' }),
  )
  const garbled = await fakeHarar(() => 'not json')
  const empty = await fakeHarar(() => JSON.stringify({ ok: true }))
  try {
    await expect(hararGet(refused.socket, 'a/b')).rejects.toThrow(
      'harar refused a/b: no_binding',
    )
    await expect(hararGet(garbled.socket, 'a/b')).rejects.toThrow(
      'did not answer with JSON',
    )
    await expect(hararGet(empty.socket, 'a/b')).rejects.toThrow('no value')
    await expect(
      hararGet(join(resolve('.tmp'), 'no-such.sock'), 'a/b'),
    ).rejects.toThrow('harar at')
  } finally {
    await refused.stop()
    await garbled.stop()
    await empty.stop()
  }
})

test('station.json is explicit: missing, or with a field mirab has no rule for, is refused', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const dir = await mkdtemp(join(resolve('.tmp'), 'station-'))
  try {
    await expect(loadStationConfig(dir)).rejects.toThrow('is missing')
    await writeFile(
      join(dir, 'station.json'),
      JSON.stringify({
        harar: { socket: '/s' },
        models: { anthropic: { key: 'k', value: 'sk-in-a-file' } },
      }),
    )
    await expect(loadStationConfig(dir)).rejects.toThrow('models.anthropic')
    await writeFile(
      join(dir, 'station.json'),
      JSON.stringify({
        harar: { socket: '/s' },
        models: { anthropic: { key: 'personal/anthropic/API_KEY' } },
      }),
    )
    expect((await loadStationConfig(dir)).models.anthropic?.key).toBe(
      'personal/anthropic/API_KEY',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('harar says where a secret may go and sends it for one host; an old station.json listing hosts still loads', async () => {
  const harar = await fakeHarar((r) =>
    r.op === 'hosts'
      ? JSON.stringify({ ok: true, hosts: ['api.stripe.com'] })
      : r.op === 'send' && r.host === 'api.stripe.com'
        ? JSON.stringify({ ok: true, value: 'sk-real' })
        : JSON.stringify({ ok: false, error: 'no_binding' }),
  )
  const dir = await mkdtemp(join(resolve('.tmp'), 'cfg-'))
  try {
    expect(await hararHosts(harar.socket, 'prod/shop/KEY')).toEqual([
      'api.stripe.com',
    ])
    expect(
      await hararSend(harar.socket, 'prod/shop/KEY', 'api.stripe.com'),
    ).toBe('sk-real')
    await expect(
      hararSend(harar.socket, 'prod/shop/KEY', 'evil.example.com'),
    ).rejects.toThrow('no_binding')
    expect(harar.requests).toEqual([
      { op: 'hosts', key: 'prod/shop/KEY' },
      { op: 'send', key: 'prod/shop/KEY', host: 'api.stripe.com' },
      { op: 'send', key: 'prod/shop/KEY', host: 'evil.example.com' },
    ])
    await writeFile(
      join(dir, 'station.json'),
      JSON.stringify({
        harar: { socket: '/x.sock' },
        models: {},
        secrets: { 'prod/shop/KEY': { hosts: ['api.stripe.com'] } },
      }),
    )
    // An old station.json still loads: its secrets are ignored (the station
    // says so, src/station/vm.test.ts), so model keys keep working.
    expect((await loadStationConfig(dir)).harar.socket).toBe('/x.sock')
  } finally {
    await harar.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
