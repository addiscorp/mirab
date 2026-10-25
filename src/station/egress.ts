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
import { connect, createServer, type Server, type Socket } from 'node:net'
import { allowed, isPublic } from './hosts'
import type { Intercept } from './intercept'

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
  /** Hosts a person allowed beyond `allow` (escalations.ts), read on every
   *  connection so a yes takes effect at once. */
  granted?: () => string[]
  /** Told of every host refused for not being on the whitelist: the ask. */
  asked?: (host: string) => void
  /** Hosts the station opens to swap placeholders for keys (intercept.ts);
   *  every other host stays a sealed tunnel. */
  intercept?: Intercept
}

export { allowed, isPublic }

export async function lookupAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map(
    (a) => a.address,
  )
}

/** The server name in a TLS ClientHello, or undefined when there isn't exactly
 *  one plain one. Strict on purpose: the hello must be one whole record, read
 *  only within its own lengths; two server_name extensions, more than one
 *  name, or an encrypted ClientHello all count as none, so the connection is
 *  refused.
 *
 *  An encrypted ClientHello is refused even when the visible name is allowed:
 *  the VM writes its own hello, so it could put a whitelisted name outside
 *  and any site on the same CDN inside, and a CDN that supports it routes on
 *  the inside. Real ones and GREASE can't be told apart, so neither is let
 *  through; the guest's Bun (1.4) sends neither. */
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
    // encrypted_client_hello, its earlier drafts (0xfe0x) and 0xffce
    if ((type & 0xfff0) === 0xfe00 || type === 0xffce) return
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

/** A buffer holding at least one whole TLS record. */
const wholeRecord = (b: Buffer) =>
  b.length >= 5 + b.readUInt16BE(3) ? b : undefined

/** HelloRetryRequest: a ServerHello whose random is this fixed value (RFC 8446 4.1.3). */
const HELLO_RETRY_RANDOM = Buffer.from(
  'cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c',
  'hex',
)
export function isHelloRetry(record: Buffer): boolean {
  return (
    record.length >= 43 &&
    record[0] === 0x16 &&
    record[5] === 0x02 &&
    record.subarray(11, 43).equals(HELLO_RETRY_RANDOM)
  )
}

/** Where the first handshake record starts, after any ChangeCipherSpec
 *  records (a client may send one before its second hello). */
function handshakeOffset(b: Buffer): number {
  let at = 0
  while (at + 5 <= b.length && b[at] === 0x14) at += 5 + b.readUInt16BE(at + 3)
  return at
}

/** A buffer holding the client's next whole handshake record. */
const nextHandshake = (b: Buffer) => {
  const at = handshakeOffset(b)
  return at + 5 <= b.length && b.length >= at + 5 + b.readUInt16BE(at + 3)
    ? b
    : undefined
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
/** Writes the station's audit lines for one zone: JSON, fields clipped, never a key. */
export function auditor(zone: string, auditLog: string) {
  const clip = (value: unknown) =>
    typeof value === 'string' && value.length > AUDIT_FIELD
      ? value.slice(0, AUDIT_FIELD) + '…'
      : value
  const audit = (entry: Record<string, unknown>) => {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      zone,
      ...Object.fromEntries(
        Object.entries(entry).map(([k, v]) => [k, clip(v)]),
      ),
    })
    // Synchronous so lines stay in order; each is small (fields are clipped).
    try {
      appendFileSync(auditLog, line + '\n', { mode: 0o600 })
    } catch {
      /* The audit log is the station's own; a failure must not open anything. */
    }
  }
  return audit
}

export async function startEgress(options: EgressOptions): Promise<Server> {
  const audit = auditor(options.zone, options.auditLog)
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
    // A host the station holds keys for is reachable as if whitelisted.
    const opened = options.intercept?.handles(host) ?? false
    if (
      !opened &&
      !allowed(host, options.allow) &&
      !allowed(host, options.granted?.() ?? [])
    ) {
      try {
        options.asked?.(host)
      } catch {
        /* An ask that can't be written is still a refusal. */
      }
      return refuse(
        socket,
        403,
        'not on the whitelist; asked for it, a person decides (mirab escalations)',
        entry,
      )
    }
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
    // A host the station opens: its own TLS server takes the connection from
    // here, and each request is audited there.
    if (opened) {
      finished = true
      audit({ ...entry, result: 'opened by the station' })
      return options.intercept!.open(socket, hello)
    }
    // While the tunnel is set up, the VM's socket keeps flowing into `held`:
    // a paused socket doesn't report the VM leaving on every platform (not on
    // Linux), and a TLS client never half-closes before its handshake is done.
    const held: Buffer[] = []
    const hold = (chunk: Buffer) => void held.push(chunk)
    const gone = () => done('closed by the VM')
    socket.on('data', hold)
    socket.once('end', gone)
    socket.resume()
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
    // A HelloRetryRequest makes the VM send a second ClientHello on the same
    // connection; it is held to the same check as the first before any bytes
    // pass blindly.
    let reply: Buffer<ArrayBufferLike>
    try {
      reply = await readUntil(
        upstream,
        wholeRecord,
        Buffer.alloc(0),
        MAX_HEAD,
        5,
      )
    } catch {
      return done('no answer from the server')
    }
    if (finished) return
    socket.write(reply)
    down += reply.length
    if (isHelloRetry(reply)) {
      let again: Buffer<ArrayBufferLike>
      socket.off('data', hold)
      try {
        again = await readUntil(
          socket,
          nextHandshake,
          Buffer.concat(held.splice(0)),
          MAX_HEAD,
          5,
        )
      } catch {
        return done('no second TLS hello')
      }
      if (finished) return
      const second = serverName(again.subarray(handshakeOffset(again)))
      if (second !== host)
        return done(
          `second TLS server name ${second ?? 'missing or ambiguous'} isn't the host`,
        )
      upstream.write(again)
      up += again.length
    }
    // The tunnel opens: what the VM sent meanwhile goes first, then the pipe.
    socket.off('data', hold)
    socket.off('end', gone)
    if (held.length) {
      const early = Buffer.concat(held.splice(0))
      upstream.write(early)
      up += early.length
    }
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
    // The allowed paths, on a path boundary, and never with an encoded
    // separator that the upstream might decode into another path.
    if (
      r.paths &&
      (/%(25|2f|5c|2e)/i.test(target.pathname) ||
        !r.paths.some(
          (p) => target.pathname === p || target.pathname.startsWith(p + '/'),
        ))
    )
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
      // A VM that only half-closes is not taken as leaving: the guest's
      // forwarder half-closes after every request; ROUTE_TIMEOUT_MS bounds it.
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
