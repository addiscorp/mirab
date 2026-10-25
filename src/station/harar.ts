// The station asks harar for long-lived keys on its local socket, the
// protocol harar-client speaks: one JSON request, the write side closed, one
// JSON response.
import { connect } from 'node:net'

/** harar answers are small; anything longer is refused. */
const MAX_RESPONSE = 1024 * 1024

/** One request to harar (the per-user agent or a primary: the same shape),
 *  and its answer if it says ok; otherwise why not. */
function ask(
  socket: string,
  request: Record<string, string>,
  what: string,
): Promise<{ value?: unknown; hosts?: unknown }> {
  return new Promise((done, fail) => {
    const conn = connect(socket)
    const chunks: Buffer[] = []
    let size = 0
    conn.setTimeout(10_000, () =>
      conn.destroy(new Error('harar did not answer in 10 s')),
    )
    conn.on('connect', () => conn.end(JSON.stringify(request)))
    conn.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_RESPONSE)
        conn.destroy(new Error('harar sent too long an answer'))
      else chunks.push(chunk)
    })
    conn.on('error', (e) => fail(new Error(`harar at ${socket}: ${e.message}`)))
    conn.on('end', () => {
      let answer: {
        ok?: boolean
        value?: unknown
        hosts?: unknown
        error?: unknown
      }
      try {
        answer = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return fail(new Error(`harar at ${socket} did not answer with JSON`))
      }
      if (
        typeof answer !== 'object' ||
        answer === null ||
        Array.isArray(answer)
      )
        return fail(
          new Error(`harar at ${socket} did not answer with an object`),
        )
      if (answer.ok === true) return done(answer)
      fail(
        new Error(
          `harar refused ${what}: ${typeof answer.error === 'string' ? answer.error : 'no answer'}`,
        ),
      )
    })
  })
}

/** One secret, as the station's OS user may read it. */
export async function hararGet(socket: string, key: string): Promise<string> {
  const { value } = await ask(socket, { op: 'get', key }, key)
  if (typeof value !== 'string')
    throw new Error(`harar refused ${key}: no value`)
  return value
}

/** The hosts harar lets `key` go to (`*.` for any name under one). */
export async function hararHosts(
  socket: string,
  key: string,
): Promise<string[]> {
  const { hosts } = await ask(socket, { op: 'hosts', key }, key)
  if (!Array.isArray(hosts) || !hosts.every((h) => typeof h === 'string'))
    throw new Error(`harar sent no hosts for ${key}`)
  return hosts
}

/** `key`'s value for one request to `host`: harar decides, and records the host. */
export async function hararSend(
  socket: string,
  key: string,
  host: string,
): Promise<string> {
  const { value } = await ask(
    socket,
    { op: 'send', key, host },
    `${key} to ${host}`,
  )
  if (typeof value !== 'string')
    throw new Error(`harar refused ${key} to ${host}: no value`)
  return value
}
