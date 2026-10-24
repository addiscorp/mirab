// A test helper, run as its own process: sends one raw HTTP request through
// the station's proxy port into a TLS tunnel, as a hostile VM could, and
// prints the response. Usage: bun raw-tls-client.ts <port> <host> <ca file>
// with the request on stdin.
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { connect as tls } from 'node:tls'

const [port, host, caFile] = process.argv.slice(2)
const request = readFileSync(0, 'utf8').replace(/\n/g, '\r\n')
const raw = connect(Number(port), '127.0.0.1', () =>
  raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`),
)
raw.once('data', () => {
  const s = tls({ socket: raw, servername: host, ca: readFileSync(caFile) })
  let out = ''
  s.on('secureConnect', () => s.write(request))
  s.on('data', (d: Buffer) => (out += d))
  s.on('end', () => (process.stdout.write(out), process.exit(0)))
  s.on(
    'error',
    (e: Error) => (process.stdout.write(`error ${e.message}`), process.exit(1)),
  )
  setTimeout(() => (process.stdout.write(out), process.exit(0)), 5000)
})
