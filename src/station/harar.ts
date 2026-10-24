// The station asks harar for long-lived keys on its local socket, the
// protocol harar-client speaks: one JSON request, the write side closed, one
// JSON response.
import { connect } from 'node:net'

/** harar answers are small; anything longer is refused. */
const MAX_RESPONSE = 1024 * 1024

/** One secret, as the station's OS user may read it. */
export function hararGet(socket: string, key: string): Promise<string> {
  return new Promise((done, fail) => {
    const conn = connect(socket)
    const chunks: Buffer[] = []
    let size = 0
    conn.setTimeout(10_000, () =>
      conn.destroy(new Error('harar did not answer in 10 s')),
    )
    conn.on('connect', () => conn.end(JSON.stringify({ op: 'get', key })))
    conn.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_RESPONSE)
        conn.destroy(new Error('harar sent too long an answer'))
      else chunks.push(chunk)
    })
    conn.on('error', (e) => fail(new Error(`harar at ${socket}: ${e.message}`)))
    conn.on('end', () => {
      let answer: { ok?: boolean; value?: unknown; error?: unknown }
      try {
        answer = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return fail(new Error(`harar at ${socket} did not answer with JSON`))
      }
      if (answer.ok === true && typeof answer.value === 'string')
        return done(answer.value)
      fail(
        new Error(
          `harar refused ${key}: ${typeof answer.error === 'string' ? answer.error : 'no value'}`,
        ),
      )
    })
  })
}
