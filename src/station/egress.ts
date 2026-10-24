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
/** Time for the head, or a TLS ClientHello, to arrive. */
const HEAD_TIMEOUT_MS = 10_000
/** The largest request body a route takes (a long conversation is a few MB). */
const MAX_BODY = 32 * 1024 * 1024
/** A tunnel with no bytes either way for this long is closed. */
const TUNNEL_IDLE_MS = 5 * 60_000
/** Connections one VM may have open at once. */
const MAX_CONNECTIONS = 64
/** How long a dial, and a whole route call, may take. */
const DIAL_TIMEOUT_MS = 10_000
const ROUTE_TIMEOUT_MS = 30 * 60_000
/** How long a route's credential is kept, and how soon a failed fetch is retried. */
const CREDENTIAL_TTL_MS = 10 * 60_000
const CREDENTIAL_RETRY_MS = 5_000
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
}

/** Addresses a whitelisted name must never lead to: the host itself, the LAN,
 *  link-local (cloud metadata), carrier-grade NAT (Tailscale), multicast. */
const NOT_PUBLIC = (() => {
  const list = new BlockList()
  for (const [net, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    list.addSubnet(net, bits, 'ipv4')
  for (const [net, bits] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const)
    list.addSubnet(net, bits, 'ipv6')
  return list
})()

/** Whether `address` is on the public internet. */
export function isPublic(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  const lower = address.toLowerCase()
  // An IPv4 address written as IPv6 is judged as the IPv4 address it is
  // (a ::ffff:0:0/96 rule in a BlockList would match every IPv4 address).
  if (lower.startsWith('::ffff:')) return isPublic(lower.slice(7))
  // NAT64 can lead anywhere in IPv4, including the LAN: never.
  if (lower.startsWith('64:ff9b:')) return false
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

async function lookupAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map(
    (a) => a.address,
  )
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

/** The server name in a TLS ClientHello, or undefined when there isn't exactly
 *  one plain one. Strict on purpose: the hello must be one whole record, read
 *  only within its own lengths; two server_name extensions, more than one
 *  name, or an encrypted ClientHello (which hides the real name behind an
 *  allowed one) all count as none, so the connection is refused. */
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
    if (type === 0xfe0d) return // encrypted_client_hello
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
    /[\x00-\x20\x7f]/.test(parts[1])
  )
    return null
  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) return null
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) return null
    headers.set(name, value)
  }
  return {
    method: parts[0],
    target: parts[1],
    headers,
    rest: buffer.subarray(end + 4),
  }
}

/** Reads from `socket` until `done` says there's enough, within the limits. */
function readUntil<T>(
  socket: Socket,
  done: (buffer: Buffer) => T | undefined,
  start: Buffer = Buffer.alloc(0),
  limit = MAX_HEAD,
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
      } else if (buffer.length > limit) finish(new Error('too large'))
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
      credentials.set(name, { value, until: Date.now() + CREDENTIAL_RETRY_MS }),
    )
    return value
  }
  const dial =
    options.dial ?? ((address, port) => connect({ host: address, port }))
  const resolve = options.resolve ?? lookupAll

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
    const target = /^([a-z0-9.-]{1,253}):(\d{1,5})$/i.exec(head.target)
    if (!target)
      return refuse(socket, 400, 'CONNECT takes host:port', { kind: 'connect' })
    const host = target[1].toLowerCase()
    const port = Number(target[2])
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
    if (name !== host) {
      audit({
        ...entry,
        result: `TLS server name ${name ?? 'missing or ambiguous'} isn't the host`,
      })
      return socket.destroy()
    }
    // The station resolves the name itself and dials the address it checked,
    // so a whitelisted name can't lead to the host, the LAN or a metadata service.
    let addresses: string[]
    try {
      addresses = await resolve(host)
    } catch {
      audit({ ...entry, result: 'does not resolve' })
      return socket.destroy()
    }
    if (!addresses.length || !addresses.every(isPublic)) {
      audit({ ...entry, result: 'resolves to an address that is not public' })
      return socket.destroy()
    }
    const upstream = dial(addresses[0], port)
    let up = 0
    let down = 0
    let finished = false
    const done = (result: string) => {
      if (finished) return
      finished = true
      audit({ ...entry, result, up, down })
      socket.destroy()
      upstream.destroy()
    }
    // A dial that never answers is given up on.
    upstream.setTimeout(DIAL_TIMEOUT_MS, () => done('dial timed out'))
    upstream.once('connect', () => {
      upstream.setTimeout(0)
      upstream.write(hello)
      up += hello.length
      socket.on('data', (c) => void (up += c.length))
      upstream.on('data', (c) => void (down += c.length))
      socket.pipe(upstream)
      upstream.pipe(socket)
      socket.resume()
    })
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
    // The body, as long as content-length says (routes take no chunked uploads).
    const length = Number(head.headers.get('content-length') ?? 0)
    if (
      head.headers.has('transfer-encoding') ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      return refuse(socket, 400, 'send a content-length body', entry)
    if (length > MAX_BODY) return refuse(socket, 413, 'body too large', entry)
    let body: Buffer<ArrayBufferLike>
    try {
      body = await readUntil(
        socket,
        (b) => (b.length >= length ? b.subarray(0, length) : undefined),
        head.rest,
        MAX_BODY,
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
    // The VM leaving, or the whole call running too long, stops the upstream call.
    const abort = new AbortController()
    socket.once('close', () => abort.abort())
    let response: Response
    try {
      response = await fetch(url, {
        method: head.method,
        headers,
        body: ['GET', 'HEAD'].includes(head.method)
          ? undefined
          : new Uint8Array(body),
        redirect: 'manual',
        signal: AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(ROUTE_TIMEOUT_MS),
        ]),
      })
    } catch {
      return refuse(socket, 502, 'upstream unreachable', entry)
    }
    const out = [
      `HTTP/1.1 ${response.status} ${(response.statusText || 'OK').replace(/[\r\n]/g, ' ')}`,
    ]
    response.headers.forEach((v, k) => {
      if (!DROPPED_RESPONSE_HEADERS.has(k)) out.push(`${k}: ${v}`)
    })
    out.push('transfer-encoding: chunked', 'connection: close', '', '')
    let bytes = 0
    // Write and wait for the VM to read: a VM that stops reading doesn't make
    // the station hold the whole response.
    const send = async (data: string | Uint8Array) => {
      if (!socket.write(data) && !socket.destroyed)
        await new Promise((r) => {
          socket.once('drain', r)
          socket.once('close', r)
        })
    }
    try {
      await send(out.join('\r\n'))
      if (response.body)
        for await (const chunk of response.body) {
          if (socket.destroyed) break
          bytes += chunk.length
          await send(`${chunk.length.toString(16)}\r\n`)
          await send(chunk)
          await send('\r\n')
        }
      socket.end('0\r\n\r\n')
      audit({ ...entry, result: response.status, down: bytes })
    } catch {
      audit({ ...entry, result: 'stopped', down: bytes })
      socket.destroy()
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
