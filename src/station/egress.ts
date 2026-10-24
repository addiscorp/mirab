// The way out of a VM (docs/architecture.md section 5). The station serves one
// socket per VM, so which VM is calling comes from the socket, never from the
// request. Each connection is either:
//   CONNECT host:443  a domain on the zone's whitelist: bytes are passed both
//                     ways once the TLS server name matches; nothing decrypted
//   /<route>/...      a named route (the model API): the placeholder the VM
//                     sends is replaced with the real key, here and only here
// Anything else is refused. One audit line per connection, never a key.
import { appendFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'

/** Ports a whitelisted domain may be reached on. */
const TLS_PORT = 443
/** The most a request head may be before the station gives up on it. */
const MAX_HEAD = 16 * 1024
/** Time for the head, or a TLS ClientHello, to arrive. */
const HEAD_TIMEOUT_MS = 10_000
/** A tunnel with no bytes either way for this long is closed. */
const TUNNEL_IDLE_MS = 5 * 60_000

export interface Route {
  /** Where the route's requests go: `https://api.anthropic.com`. */
  upstream: string
  /** The header that carries the credential, e.g. `x-api-key`. */
  header: string
  /** How the credential is written into that header. */
  format?: (credential: string) => string
  /** The real credential, fetched when the route is first used. */
  credential: () => Promise<string>
}

export interface EgressOptions {
  /** The VM's guest-to-host socket for the egress port (`<vsock>_9101`). */
  socketPath: string
  /** Which zone this VM is, for decisions and the audit log. */
  zone: string
  /** Domains this zone may reach: `registry.npmjs.org`, or `*.github.com`. */
  allow: string[]
  routes: Record<string, Route>
  /** Where the audit lines go (JSON lines). */
  auditLog: string
  /** Where a whitelisted domain is dialed; tests point it at a local server. */
  dial?: (host: string, port: number) => Socket
}

/** Whether `host` is on the whitelist: an exact match, or under a `*.` entry. */
export function allowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return allow.some((entry) => {
    const e = entry.toLowerCase()
    return e.startsWith('*.')
      ? h.endsWith(e.slice(1)) && h.length > e.length - 1
      : h === e
  })
}

/** The server name in a TLS ClientHello, or undefined if there isn't one. */
export function serverName(hello: Buffer): string | undefined {
  // Record header (5) → handshake header (4) → version (2) + random (32).
  if (hello.length < 43 || hello[0] !== 0x16 || hello[5] !== 0x01) return
  let at = 43
  const take = (n: number) => {
    const start = at
    at += n
    return at <= hello.length ? hello.subarray(start, at) : undefined
  }
  const u8 = () => take(1)?.readUInt8(0)
  const u16 = () => take(2)?.readUInt16BE(0)
  const session = u8()
  if (session === undefined || !take(session)) return
  const suites = u16()
  if (suites === undefined || !take(suites)) return
  const compression = u8()
  if (compression === undefined || !take(compression)) return
  const extensions = u16()
  if (extensions === undefined) return
  const end = at + extensions
  while (at + 4 <= Math.min(end, hello.length)) {
    const type = u16()!
    const length = u16()!
    const body = take(length)
    if (!body) return
    if (type !== 0) continue
    // server_name: list length (2), then entries of type (1), length (2), name.
    if (body.length < 5 || body[2] !== 0) return
    const n = body.readUInt16BE(3)
    return body
      .subarray(5, 5 + n)
      .toString('ascii')
      .toLowerCase()
  }
}

interface Head {
  method: string
  target: string
  headers: Map<string, string>
  /** Bytes that arrived after the head (a body, or the start of TLS). */
  rest: Buffer
}

function parseHead(buffer: Buffer): Head | undefined {
  const end = buffer.indexOf('\r\n\r\n')
  if (end < 0) return
  const lines = buffer.subarray(0, end).toString('latin1').split('\r\n')
  const [method, target] = lines[0].split(' ')
  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon > 0)
      headers.set(
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim(),
      )
  }
  return { method, target, headers, rest: buffer.subarray(end + 4) }
}

/** Reads from `socket` until `done` says there's enough, within the limits. */
function readUntil<T>(
  socket: Socket,
  done: (buffer: Buffer) => T | undefined,
  start: Buffer = Buffer.alloc(0),
): Promise<T> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer = start
    const timer = setTimeout(
      () => finish(new Error('timed out')),
      HEAD_TIMEOUT_MS,
    )
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      if (error) reject(error)
      else resolve(value as T)
    }
    const onClose = () => finish(new Error('closed'))
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const value = done(buffer)
      if (value !== undefined) {
        socket.pause()
        finish(undefined, value)
      } else if (buffer.length > MAX_HEAD) finish(new Error('too large'))
    }
    const value = done(buffer)
    if (value !== undefined) return finish(undefined, value)
    socket.on('data', onData)
    socket.on('close', onClose)
    socket.resume()
  })
}

/** Starts serving one VM's way out. Close the returned server to stop. */
export async function startEgress(options: EgressOptions): Promise<Server> {
  const audit = (entry: Record<string, unknown>) => {
    try {
      appendFileSync(
        options.auditLog,
        JSON.stringify({
          at: new Date().toISOString(),
          zone: options.zone,
          ...entry,
        }) + '\n',
        { mode: 0o600 },
      )
    } catch {
      /* The audit log is the station's own; a failure must not open anything. */
    }
  }
  const credentials = new Map<string, Promise<string>>()
  const dial = options.dial ?? ((host, port) => connect({ host, port }))

  const refuse = (
    socket: Socket,
    status: number,
    reason: string,
    entry: Record<string, unknown>,
  ) => {
    audit({ ...entry, result: reason })
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nmirab station: ${reason}\n`,
    )
  }

  const tunnel = async (socket: Socket, head: Head) => {
    const [host, portText] = head.target.split(':')
    const port = Number(portText)
    const entry = { kind: 'connect', host }
    if (port !== TLS_PORT) return refuse(socket, 403, 'only port 443', entry)
    if (!allowed(host, options.allow))
      return refuse(socket, 403, 'not on the whitelist; ask for it', entry)
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
    // The TLS server name must be the host that was allowed.
    let hello: Buffer<ArrayBufferLike>
    try {
      hello = await readUntil(
        socket,
        (b) =>
          b.length >= 5 && b.length >= 5 + b.readUInt16BE(3) ? b : undefined,
        head.rest,
      )
    } catch {
      audit({ ...entry, result: 'no TLS hello' })
      return socket.destroy()
    }
    const name = serverName(hello)
    if (name !== host.toLowerCase()) {
      audit({
        ...entry,
        result: `TLS server name ${name ?? 'missing'} isn't the host`,
      })
      return socket.destroy()
    }
    const upstream = dial(host, port)
    let up = 0
    let down = 0
    upstream.on('connect', () => {
      upstream.write(hello)
      up += hello.length
      socket.on('data', (c) => void (up += c.length))
      upstream.on('data', (c) => void (down += c.length))
      socket.pipe(upstream)
      upstream.pipe(socket)
      socket.resume()
    })
    let finished = false
    const done = (result: string) => {
      if (finished) return
      finished = true
      audit({ ...entry, result, up, down })
      socket.destroy()
      upstream.destroy()
    }
    // Either side ending ends the tunnel, and so does a quiet one: a tunnel
    // must never outlive what it carries.
    upstream.once('close', () => done('closed'))
    upstream.once('error', () => done('upstream error'))
    socket.once('close', () => done('closed by the VM'))
    socket.once('error', () => done('VM side error'))
    socket.setTimeout(TUNNEL_IDLE_MS, () => done('idle'))
  }

  const route = async (socket: Socket, head: Head) => {
    const name = head.target.split('/')[1] ?? ''
    const r = Object.hasOwn(options.routes, name)
      ? options.routes[name]
      : undefined
    const path = head.target.slice(name.length + 1) || '/'
    const entry = {
      kind: 'route',
      route: name,
      method: head.method,
      path: path.split('?')[0],
    }
    if (!r) return refuse(socket, 404, 'no such route', entry)
    // The body, as long as content-length says (routes take no chunked uploads).
    const length = Number(head.headers.get('content-length') ?? 0)
    if (
      head.headers.has('transfer-encoding') ||
      !Number.isFinite(length) ||
      length < 0
    )
      return refuse(socket, 400, 'send a content-length body', entry)
    let body: Buffer<ArrayBufferLike>
    try {
      body = await readUntil(
        socket,
        (b) => (b.length >= length ? b.subarray(0, length) : undefined),
        head.rest,
      )
    } catch {
      return refuse(socket, 400, 'incomplete body', entry)
    }
    if (!credentials.has(name)) credentials.set(name, r.credential())
    let credential: string
    try {
      credential = await credentials.get(name)!
    } catch (error) {
      credentials.delete(name)
      return refuse(
        socket,
        502,
        `no credential for ${name}: ${(error as Error).message}`,
        entry,
      )
    }
    // Whatever the VM sent for credentials is dropped; only the real one goes.
    const headers = new Headers()
    for (const [k, v] of head.headers)
      if (
        ![
          'host',
          'connection',
          'content-length',
          'authorization',
          'x-api-key',
          'proxy-authorization',
          'accept-encoding',
        ].includes(k)
      )
        headers.set(k, v)
    headers.set(r.header, r.format ? r.format(credential) : credential)
    let response: Response
    try {
      response = await fetch(new URL(path, r.upstream), {
        method: head.method,
        headers,
        body: ['GET', 'HEAD'].includes(head.method)
          ? undefined
          : new Uint8Array(body),
        redirect: 'manual',
      })
    } catch {
      return refuse(socket, 502, 'upstream unreachable', entry)
    }
    const out = [`HTTP/1.1 ${response.status} ${response.statusText || 'OK'}`]
    response.headers.forEach((v, k) => {
      if (
        ![
          'content-length',
          'transfer-encoding',
          'connection',
          'content-encoding',
        ].includes(k)
      )
        out.push(`${k}: ${v}`)
    })
    out.push('transfer-encoding: chunked', 'connection: close', '', '')
    socket.write(out.join('\r\n'))
    let bytes = 0
    if (response.body)
      for await (const chunk of response.body) {
        bytes += chunk.length
        socket.write(`${chunk.length.toString(16)}\r\n`)
        socket.write(chunk)
        socket.write('\r\n')
      }
    socket.end('0\r\n\r\n')
    audit({ ...entry, result: response.status, down: bytes })
  }

  const server = createServer({ pauseOnConnect: true }, async (socket) => {
    socket.on('error', () => socket.destroy())
    let head: Head
    try {
      head = await readUntil(socket, parseHead)
    } catch {
      return socket.destroy()
    }
    if (head.method === 'CONNECT') return tunnel(socket, head)
    if (head.target.startsWith('/')) return route(socket, head)
    refuse(socket, 403, 'plain HTTP to other hosts is not allowed', {
      kind: 'http',
      target: head.target.split('?')[0],
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, () => resolve())
  })
  return server
}
