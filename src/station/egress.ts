// The way out of a VM (docs/architecture.md section 5). The station serves one
// socket per VM, so which VM is calling comes from the socket, never from the
// request. Each connection is either:
//   CONNECT host:443  a domain on the zone's whitelist: bytes are passed both
//                     ways once the TLS server name matches; nothing decrypted
//   /<route>/...      a named route (the model API): the placeholder the VM
//                     sends is replaced with the real key, here and only here
// Anything else is refused. One audit line per connection, never a key.
import { appendFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import {
  BlockList,
  connect,
  createServer,
  isIP,
  type Server,
  type Socket,
} from 'node:net'

/** Ports a whitelisted domain may be reached on. */
const TLS_PORT = 443
/** The most a request head may be before the station gives up on it. */
const MAX_HEAD = 16 * 1024
/** The largest request body a route takes (a long conversation is a few MB). */
const MAX_BODY = 32 * 1024 * 1024
/** Request bodies held at once across all of a station's connections. */
const MAX_BODIES_IN_FLIGHT = 96 * 1024 * 1024
/** Time for the head, a TLS ClientHello, or a name lookup. */
const HEAD_TIMEOUT_MS = 10_000
/** A tunnel with no bytes either way for this long is closed. */
const TUNNEL_IDLE_MS = 5 * 60_000
/** Connections one VM may have open at once. */
const MAX_CONNECTIONS = 64
/** How long a dial, and a whole route call, may take. */
const DIAL_TIMEOUT_MS = 10_000
const ROUTE_TIMEOUT_MS = 30 * 60_000
/** How long a refused or finished connection may linger before it is cut. */
const LINGER_MS = 2_000
/** How long a route's credential is kept, and how soon a failed fetch is retried. */
const CREDENTIAL_TTL_MS = 10 * 60_000
const CREDENTIAL_RETRY_MS = 5_000
/** The most of a VM-chosen string an audit line keeps. */
const AUDIT_FIELD = 200
/** What never goes upstream from a VM: its own credentials, and hop-by-hop headers. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'authorization',
  'x-api-key',
  'proxy-authorization',
  'accept-encoding',
  'expect',
])
const DROPPED_RESPONSE_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'content-encoding',
])

export interface Route {
  /** Where the route's requests go: `https://api.anthropic.com`. */
  upstream: string
  /** The header that carries the credential, e.g. `x-api-key`. */
  header: string
  /** How the credential is written into that header. */
  format?: (credential: string) => string
  /** The real credential, fetched when the route is first used. */
  credential: () => Promise<string>
  /** Path prefixes the key may be used on (e.g. `/v1/messages`); all if unset. */
  paths?: string[]
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
  /** Where a whitelisted domain is dialed (the address already checked);
   *  tests point it at a local server. */
  dial?: (address: string, port: number) => Socket
  /** How a whitelisted name is resolved; tests give fixed addresses. */
  resolve?: (host: string) => Promise<string[]>
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

/** Addresses a whitelisted name must never lead to: the host itself, the LAN,
 *  link-local (cloud metadata), carrier-grade NAT (Tailscale), documentation,
 *  multicast, and IPv6 forms that carry an IPv4 address or a tunnel. */
const NOT_PUBLIC_V4 = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NOT_PUBLIC_V4.addSubnet(net, bits, 'ipv4')
const NOT_PUBLIC_V6 = new BlockList()
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const)
  NOT_PUBLIC_V6.addSubnet(net, bits, 'ipv6')

/** Whether `address` is on the public internet. Each family has its own list,
 *  and IPv6 is judged in its canonical form, however it was written. */
export function isPublic(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !NOT_PUBLIC_V4.check(address, 'ipv4')
  if (family !== 6) return false
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1)
  // An IPv4 address written as IPv6 (::ffff:a.b.c.d) is judged as IPv4.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (mapped) {
    const hi = parseInt(mapped[1], 16)
    const lo = parseInt(mapped[2], 16)
    return isPublic(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  return !NOT_PUBLIC_V6.check(canonical, 'ipv6')
}

async function lookupAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map(
    (a) => a.address,
  )
}

/** The server name in a TLS ClientHello, or undefined when there isn't exactly
 *  one. Strict on purpose: the hello must be one whole record, read only
 *  within its own lengths; two server_name extensions or more than one name
 *  count as none, so the connection is refused.
 *
 *  An encrypted_client_hello extension is allowed: BoringSSL (Bun) sends one
 *  as GREASE in every hello. A real one carries the provider's public name
 *  (cloudflare-ech.com) outside, which won't match a whitelisted host, so it
 *  is refused anyway; never whitelist such a public name (section 5). */
export function serverName(hello: Buffer): string | undefined {
  if (hello.length < 9 || hello[0] !== 0x16) return
  const recordEnd = 5 + hello.readUInt16BE(3)
  if (hello.length < recordEnd) return
  const record = hello.subarray(5, recordEnd)
  if (record[0] !== 0x01) return
  const handshakeEnd = 4 + ((record[1] << 16) | (record[2] << 8) | record[3])
  // A ClientHello split across records is never reassembled here: refused.
  if (handshakeEnd > record.length) return
  const body = record.subarray(4, handshakeEnd)
  let at = 34 // version (2) + random (32)
  const take = (n: number) => {
    if (at + n > body.length) return
    const part = body.subarray(at, at + n)
    at += n
    return part
  }
  const u8 = () => take(1)?.[0]
  const u16 = () => take(2)?.readUInt16BE(0)
  const session = u8()
  if (session === undefined || !take(session)) return
  const suites = u16()
  if (suites === undefined || !take(suites)) return
  const compression = u8()
  if (compression === undefined || !take(compression)) return
  const extensionsLength = u16()
  if (extensionsLength === undefined || at + extensionsLength !== body.length)
    return
  let name: string | undefined
  let names = 0
  while (at < body.length) {
    const type = u16()
    const length = u16()
    if (type === undefined || length === undefined) return
    const ext = take(length)
    if (!ext) return
    if (type !== 0) continue
    if (++names > 1) return
    // server_name: list length (2), then exactly one host_name entry.
    if (
      ext.length < 5 ||
      ext.readUInt16BE(0) !== ext.length - 2 ||
      ext[2] !== 0
    )
      return
    const n = ext.readUInt16BE(3)
    if (5 + n !== ext.length) return
    name = ext.subarray(5).toString('latin1').toLowerCase()
    if (!/^[a-z0-9.-]{1,253}$/.test(name)) return
  }
  return name
}

interface Head {
  method: string
  target: string
  headers: Map<string, string>
  /** Bytes that arrived after the head (a body, or the start of TLS). */
  rest: Buffer
}

const METHOD = /^[A-Z]{1,16}$/
const VERSION = /^HTTP\/1\.[01]$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

/** The request head; undefined while incomplete, null when it is malformed. */
function parseHead(buffer: Buffer): Head | null | undefined {
  const end = buffer.indexOf('\r\n\r\n')
  if (end < 0) return
  const lines = buffer.subarray(0, end).toString('latin1').split('\r\n')
  const parts = lines[0].split(' ')
  if (
    parts.length !== 3 ||
    !METHOD.test(parts[0]) ||
    !parts[1] ||
    /[\x00-\x20\x7f]/.test(parts[1]) ||
    !VERSION.test(parts[2])
  )
    return null
  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) return null
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) return null
    // A repeated content-length could mean two different bodies: refused.
    if (name === 'content-length' && headers.has(name)) return null
    headers.set(name, value)
  }
  return {
    method: parts[0],
    target: parts[1],
    headers,
    rest: buffer.subarray(end + 4),
  }
}

/** Reads from `socket` until `done` says there's enough, within the limits.
 *  Chunks are collected and joined only once `need` bytes have arrived. */
function readUntil<T>(
  socket: Socket,
  done: (buffer: Buffer) => T | undefined,
  start: Buffer = Buffer.alloc(0),
  limit = MAX_HEAD,
  need = 0,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [start]
    let size = start.length
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
    const check = () => {
      if (size < need) return undefined
      const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
      chunks.splice(0, chunks.length, buffer)
      return done(buffer)
    }
    const onClose = () => finish(new Error('closed'))
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      const value = check()
      if (value !== undefined) {
        socket.pause()
        finish(undefined, value)
      } else if (size > limit) finish(new Error('too large'))
    }
    const value = check()
    if (value !== undefined) return finish(undefined, value)
    socket.on('data', onData)
    socket.on('close', onClose)
    socket.resume()
  })
}

/** Resolves within `ms`, or fails. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Ends a connection the VM may be keeping half-open, then cuts it if it lingers. */
function finishSocket(socket: Socket, data?: string) {
  if (data === undefined) socket.end()
  else socket.end(data)
  setTimeout(() => socket.destroy(), LINGER_MS).unref()
}

/** Starts serving one VM's way out. Close the returned server to stop. */
export async function startEgress(options: EgressOptions): Promise<Server> {
  const clip = (value: unknown) =>
    typeof value === 'string' && value.length > AUDIT_FIELD
      ? value.slice(0, AUDIT_FIELD) + '…'
      : value
  const audit = (entry: Record<string, unknown>) => {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      zone: options.zone,
      ...Object.fromEntries(
        Object.entries(entry).map(([k, v]) => [k, clip(v)]),
      ),
    })
    // Synchronous so lines stay in order; each is small (fields are clipped).
    try {
      appendFileSync(options.auditLog, line + '\n', { mode: 0o600 })
    } catch {
      /* The audit log is the station's own; a failure must not open anything. */
    }
  }
  // Each route's credential, kept for CREDENTIAL_TTL_MS so a rotated key is
  // picked up; a failure is kept briefly so a VM can't hammer the vault.
  const credentials = new Map<
    string,
    { value: Promise<string>; until: number }
  >()
  const credentialFor = (name: string, route: Route) => {
    const now = Date.now()
    const held = credentials.get(name)
    if (held && held.until > now) return held.value
    const value = route.credential()
    credentials.set(name, { value, until: now + CREDENTIAL_TTL_MS })
    value.catch(() =>
      credentials.set(name, {
        value,
        until: Date.now() + CREDENTIAL_RETRY_MS,
      }),
    )
    return value
  }
  const dial =
    options.dial ?? ((address, port) => connect({ host: address, port }))
  const resolve = options.resolve ?? lookupAll
  let bodiesInFlight = 0

  const refuse = (
    socket: Socket,
    status: number,
    reason: string,
    entry: Record<string, unknown>,
  ) => {
    audit({ ...entry, result: reason })
    finishSocket(
      socket,
      `HTTP/1.1 ${status} ${reason}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nmirab station: ${reason}\n`,
    )
  }

  const tunnel = async (socket: Socket, head: Head) => {
    const target = /^([a-z0-9.-]{1,253}):(\d{1,5})$/i.exec(head.target)
    if (!target)
      return refuse(socket, 400, 'CONNECT takes host:port', {
        kind: 'connect',
      })
    const host = target[1].toLowerCase()
    const port = Number(target[2])
    const entry = { kind: 'connect', host }
    if (port !== TLS_PORT) return refuse(socket, 403, 'only port 443', entry)
    if (!allowed(host, options.allow))
      return refuse(socket, 403, 'not on the whitelist; ask for it', entry)
    // From here the tunnel owns the socket: whatever happens, done() runs once.
    let upstream: Socket | undefined
    let up = 0
    let down = 0
    let finished = false
    const done = (result: string, gracefully = false) => {
      if (finished) return
      finished = true
      audit({ ...entry, result, up, down })
      upstream?.destroy()
      // An upstream that ended cleanly: let what's buffered reach the VM first.
      if (gracefully) finishSocket(socket)
      else socket.destroy()
    }
    socket.once('close', () => done('closed by the VM'))
    socket.on('error', () => done('VM side error'))
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
    // The TLS server name must be the host that was allowed.
    let hello: Buffer<ArrayBufferLike>
    try {
      hello = await readUntil(
        socket,
        (b) => (b.length >= 5 + b.readUInt16BE(3) ? b : undefined),
        head.rest,
        MAX_HEAD,
        5,
      )
    } catch {
      return done('no TLS hello')
    }
    if (finished) return
    const name = serverName(hello)
    if (name !== host)
      return done(
        `TLS server name ${name ?? 'missing or ambiguous'} isn't the host`,
      )
    // The station resolves the name itself and dials an address it checked,
    // so a whitelisted name can't lead to the host, the LAN or a metadata service.
    let addresses: string[]
    try {
      addresses = await withTimeout(resolve(host), HEAD_TIMEOUT_MS)
    } catch {
      return done('does not resolve')
    }
    if (finished) return
    if (!addresses.length || !addresses.every(isPublic))
      return done('resolves to an address that is not public')
    // Each checked address in turn, until one answers.
    for (const address of addresses) {
      const attempt = dial(address, port)
      const connected = await new Promise<boolean>((r) => {
        attempt.setTimeout(DIAL_TIMEOUT_MS, () => r(false))
        attempt.once('connect', () => r(true))
        attempt.once('error', () => r(false))
      })
      if (finished) return void attempt.destroy()
      if (connected) {
        upstream = attempt
        break
      }
      attempt.destroy()
    }
    if (!upstream) return done('no address answered')
    upstream.setTimeout(0)
    upstream.on('error', () => done('upstream error'))
    upstream.once('end', () => done('closed', true))
    upstream.once('close', () => done('closed', true))
    upstream.write(hello)
    up += hello.length
    socket.on('data', (c) => void (up += c.length))
    upstream.on('data', (c) => void (down += c.length))
    socket.pipe(upstream)
    upstream.pipe(socket, { end: false })
    socket.setTimeout(TUNNEL_IDLE_MS, () => done('idle'))
    socket.resume()
  }

  const route = async (socket: Socket, head: Head) => {
    const name = head.target.split(/[/?]/)[1] ?? ''
    const r = Object.hasOwn(options.routes, name)
      ? options.routes[name]
      : undefined
    const path = head.target.slice(name.length + 1) || '/'
    // Only ever the route's own host: a path like //evil.example/x would
    // otherwise resolve to another host, and the real key would go with it.
    const base = new URL(r?.upstream ?? 'http://invalid')
    let url: URL | undefined
    try {
      url = new URL(base.origin + (path.startsWith('/') ? path : '/' + path))
    } catch {
      url = undefined
    }
    const entry = {
      kind: 'route',
      route: name,
      method: head.method,
      path: path.split('?')[0],
    }
    if (!r) return refuse(socket, 404, 'no such route', entry)
    if (!url || path.startsWith('//') || url.origin !== base.origin)
      return refuse(socket, 400, 'a path on the route itself only', entry)
    const target = url
    if (r.paths && !r.paths.some((p) => target.pathname.startsWith(p)))
      return refuse(socket, 403, 'not a path this route allows', entry)
    // The body, as long as content-length says (routes take no chunked uploads).
    const lengthHeader = head.headers.get('content-length') ?? '0'
    if (
      head.headers.has('transfer-encoding') ||
      !/^\d{1,10}$/.test(lengthHeader)
    )
      return refuse(socket, 400, 'send a content-length body', entry)
    const length = Number(lengthHeader)
    if (length > MAX_BODY) return refuse(socket, 413, 'body too large', entry)
    if (bodiesInFlight + length > MAX_BODIES_IN_FLIGHT)
      return refuse(socket, 503, 'busy; try again', entry)
    bodiesInFlight += length
    try {
      let body: Buffer<ArrayBufferLike>
      try {
        body = await readUntil(
          socket,
          (b) => (b.length >= length ? b.subarray(0, length) : undefined),
          head.rest,
          MAX_BODY,
          length,
        )
      } catch {
        return refuse(socket, 400, 'incomplete body', entry)
      }
      let credential: string
      try {
        credential = await credentialFor(name, r)
      } catch {
        // Never the error's text: it is the vault's, not the VM's.
        return refuse(socket, 502, 'no credential for this route', entry)
      }
      // Whatever the VM sent for credentials is dropped; only the real one goes.
      const headers = new Headers()
      for (const [k, v] of head.headers)
        if (!DROPPED_REQUEST_HEADERS.has(k)) headers.set(k, v)
      headers.set(r.header, r.format ? r.format(credential) : credential)
      // The VM's socket closing, or the whole call running too long, stops it.
      const abort = new AbortController()
      socket.once('close', () => abort.abort())
      let response: Response
      try {
        response = await fetch(target, {
          method: head.method,
          headers,
          body: ['GET', 'HEAD'].includes(head.method)
            ? undefined
            : // A view, not a copy; socket buffers are always ArrayBuffer-backed.
              new Uint8Array(
                body.buffer as ArrayBuffer,
                body.byteOffset,
                body.length,
              ),
          redirect: 'manual',
          signal: AbortSignal.any([
            abort.signal,
            AbortSignal.timeout(ROUTE_TIMEOUT_MS),
          ]),
        })
      } catch {
        return refuse(socket, 502, 'upstream unreachable', entry)
      }
      const noBody =
        head.method === 'HEAD' ||
        response.status === 204 ||
        response.status === 304
      const out = [
        `HTTP/1.1 ${response.status} ${(response.statusText || 'OK').replace(/[\r\n]/g, ' ')}`,
      ]
      response.headers.forEach((v, k) => {
        if (!DROPPED_RESPONSE_HEADERS.has(k)) out.push(`${k}: ${v}`)
      })
      if (!noBody) out.push('transfer-encoding: chunked')
      out.push('connection: close', '', '')
      let bytes = 0
      // Write and wait for the VM to read: a VM that stops reading doesn't make
      // the station hold the whole response.
      const send = async (data: string | Uint8Array) => {
        const ok =
          typeof data === 'string'
            ? socket.write(data, 'latin1')
            : socket.write(data)
        if (ok || socket.destroyed) return
        await new Promise<void>((r) => {
          const go = () => {
            socket.off('drain', go)
            socket.off('close', go)
            r()
          }
          socket.on('drain', go)
          socket.on('close', go)
        })
      }
      try {
        await send(out.join('\r\n'))
        if (response.body && !noBody)
          for await (const chunk of response.body) {
            if (socket.destroyed) break
            bytes += chunk.length
            await send(`${chunk.length.toString(16)}\r\n`)
            await send(chunk)
            await send('\r\n')
          }
        finishSocket(socket, noBody ? undefined : '0\r\n\r\n')
        audit({ ...entry, result: response.status, down: bytes })
      } catch {
        audit({ ...entry, result: 'stopped', down: bytes })
        socket.destroy()
      }
    } finally {
      bodiesInFlight -= length
    }
  }

  const handle = async (socket: Socket) => {
    socket.on('error', () => socket.destroy())
    let head: Head | null
    try {
      head = await readUntil(socket, parseHead)
    } catch {
      return socket.destroy()
    }
    if (!head)
      return refuse(socket, 400, 'malformed request', { kind: 'malformed' })
    if (head.method === 'CONNECT') return tunnel(socket, head)
    if (head.target.startsWith('/')) return route(socket, head)
    refuse(socket, 403, 'plain HTTP to other hosts is not allowed', {
      kind: 'http',
      target: head.target.split('?')[0],
    })
  }
  // allowHalfOpen: a VM that has finished sending still gets its whole answer.
  const server = createServer(
    { pauseOnConnect: true, allowHalfOpen: true },
    (socket) => {
      // Nothing a VM sends may take the station down: a failure ends that
      // connection only.
      handle(socket).catch(() => socket.destroy())
    },
  )
  server.maxConnections = MAX_CONNECTIONS
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, () => resolve())
  })
  return server
}
