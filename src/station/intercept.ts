// The station opening a tunnel for a host it holds keys for (secrets.ts).
// egress checks the CONNECT and the TLS server name as for any tunnel, then
// hands the connection here instead of to the host: it goes into the
// station's own HTTPS server (a private socket, certificate from ca.ts),
// where each request's placeholders are swapped for real values and the
// request is sent on over the station's own TLS, to an address it checked,
// with the host's real certificate verified.
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { Transform } from 'node:stream'
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkServerIdentity } from 'node:tls'
import type { StationAuthority } from './ca'
import { allowed, isPublic } from './hosts'
import { swapHeaders, type Placeholders, type Secrets } from './secrets'

/** Headers that belong to one hop, never passed on. */
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
])
/** [name, value, ...] without the one-hop headers. */
function withoutHop(raw: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i + 1 < raw.length; i += 2)
    if (!HOP.has(raw[i].toLowerCase())) out.push(raw[i], raw[i + 1])
  return out
}

/** An opened connection with no bytes either way for this long is closed:
 *  as long as one request may take, so a quiet long request survives. */
const IDLE_MS = 30 * 60_000
/** Time to reach one of a host's addresses. */
const DIAL_MS = 5_000

/** Whether something answers at address:port (the station dials only checked addresses). */
function reachable(address: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: address, port })
    s.setTimeout(DIAL_MS, () => (s.destroy(), done(false)))
    s.once('connect', () => (s.destroy(), done(true)))
    s.once('error', () => done(false))
  })
}

/** Longest real value first, so one that holds another is taken out whole;
 *  never an empty one. */
function longestFirst(revealed: [string, string][]) {
  return revealed.filter(([r]) => r).sort(([a], [b]) => b.length - a.length)
}

/** `text` with every real value put back to its placeholder. */
export function redactText(text: string, revealed: [string, string][]): string {
  let out = text
  for (const [real, placeholder] of longestFirst(revealed))
    out = out.split(real).join(placeholder)
  return out
}

/** A body stream with every real value put back to its placeholder, also
 *  when a value is split across chunks. */
export class Redact extends Transform {
  private readonly pairs: [Buffer, Buffer][]
  private readonly keep: number
  private tail: Buffer = Buffer.alloc(0)

  constructor(revealed: [string, string][]) {
    super()
    this.pairs = longestFirst(revealed).map(([r, p]) => [
      Buffer.from(r),
      Buffer.from(p),
    ])
    this.keep = Math.max(0, ...this.pairs.map(([r]) => r.length - 1))
  }

  private scrub(buffer: Buffer): Buffer {
    let out = buffer
    for (const [real, placeholder] of this.pairs) {
      const parts: Buffer[] = []
      let at = 0
      for (let i = out.indexOf(real); i >= 0; i = out.indexOf(real, at)) {
        parts.push(out.subarray(at, i), placeholder)
        at = i + real.length
      }
      if (at) out = Buffer.concat([...parts, out.subarray(at)])
    }
    return out
  }

  override _transform(chunk: Buffer, _: string, done: () => void) {
    const all = this.scrub(Buffer.concat([this.tail, chunk]))
    // The last few bytes wait for the next chunk: they may begin a value.
    const cut = Math.max(0, all.length - this.keep)
    this.tail = all.subarray(cut)
    if (cut) this.push(all.subarray(0, cut))
    done()
  }

  override _flush(done: () => void) {
    if (this.tail.length) this.push(this.scrub(this.tail))
    done()
  }
}

/** How long one request may take, start to finish (a big git push included). */
const REQUEST_TIMEOUT_MS = 30 * 60_000

export interface Upstream {
  /** The address to dial (already checked) and the port. */
  address: string
  port: number
  /** Trust for the upstream's certificate; the system's roots when unset (tests set it). */
  ca?: string
}

export interface InterceptOptions {
  secrets: Secrets
  placeholders: Placeholders
  /** A secret's real value for one host (harar's send, through the station's cache). */
  value(secret: string, host: string): Promise<string>
  authority: StationAuthority
  audit(entry: Record<string, unknown>): void
  /** Where a host is: resolved here and checked public. */
  resolve(host: string): Promise<string[]>
  /** Tests point the upstream at a local stand-in. */
  upstream?: (host: string) => Promise<Upstream>
}

export interface Intercept {
  /** Whether the station opens tunnels to `host`. */
  handles(host: string): boolean
  /** Takes over a VM connection whose TLS hello (and anything after) is `first`. */
  open(vm: Socket, first: Buffer): void
  close(): Promise<void>
}

export async function startIntercept(o: InterceptOptions): Promise<Intercept> {
  const hosts = [...new Set(Object.values(o.secrets).flatMap((s) => s.hosts))]
  const leaf = await o.authority.leaf(hosts)
  const where = async (host: string): Promise<Upstream> => {
    if (o.upstream) return o.upstream(host)
    const addresses = await o.resolve(host)
    if (!addresses.length || !addresses.every(isPublic))
      throw new Error('resolves to an address that is not public')
    // Each checked address in turn, until one answers.
    for (const address of addresses)
      if (await reachable(address, 443)) return { address, port: 443 }
    throw new Error('no address answered')
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = String(
      (req.socket as { servername?: string }).servername ?? '',
    ).toLowerCase()
    const target = req.url ?? ''
    const entry = {
      kind: 'intercept',
      host,
      method: req.method,
      path: target.split('?')[0],
    }
    const refuse = (status: number, reason: string) => {
      o.audit({ ...entry, result: reason })
      req.resume()
      if (res.headersSent) return void res.destroy()
      res.writeHead(status, {
        'content-type': 'text/plain',
        connection: 'close',
      })
      res.end(`mirab station: ${reason}\n`)
    }
    // The name the VM's TLS asked for (egress checked it against the CONNECT),
    // and the request must be for that same host, by one Host header and an
    // ordinary path: an absolute URL or a second Host could route it elsewhere.
    if (!hosts.some((h) => allowed(host, [h])))
      return refuse(421, 'not a host the station opens')
    if (!/^\/(?!\/)/.test(target))
      return refuse(400, 'a path on the host itself only')
    if (req.method === 'TRACE' || req.method === 'CONNECT')
      return refuse(405, `${req.method} isn't passed on`)
    const hostHeaders = req.rawHeaders.filter(
      (_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'host',
    )
    const named = String(req.headers.host ?? '')
      .toLowerCase()
      .replace(/:443$/, '')
    if (hostHeaders.length !== 1 || named !== host)
      return refuse(421, `Host isn't ${host}`)
    const raw = withoutHop(req.rawHeaders).filter(
      (_, i, all) => (i % 2 ? all[i - 1] : all[i]).toLowerCase() !== 'host',
    )
    let swapped
    try {
      swapped = await swapHeaders(host, raw, o.placeholders, o.secrets, o.value)
    } catch {
      return refuse(502, 'the key could not be read from harar')
    }
    if (!swapped.ok) return refuse(403, swapped.reason)
    const revealed = swapped.revealed
    let upstream: Upstream
    try {
      upstream = await where(host)
    } catch (e) {
      return refuse(502, (e as Error).message)
    }
    // Exactly one Host, the name the VM's TLS asked for; and, where a key went
    // in, an answer the station can read, so it can take the key back out.
    const headers: Record<string, string | string[]> = { host }
    for (let i = 0; i < swapped.headers.length; i += 2) {
      const name = swapped.headers[i].toLowerCase()
      const prev = headers[name]
      headers[name] =
        prev === undefined
          ? swapped.headers[i + 1]
          : ([] as string[]).concat(prev, swapped.headers[i + 1])
    }
    if (revealed.length) headers['accept-encoding'] = 'identity'
    let up: ClientRequest
    try {
      up = httpsRequest({
        host: upstream.address,
        port: upstream.port,
        servername: host,
        method: req.method,
        path: target,
        headers,
        agent: false,
        ca: upstream.ca,
        // The host's own certificate, whatever address it was dialed at.
        checkServerIdentity: (_, cert) => checkServerIdentity(host, cert),
        timeout: REQUEST_TIMEOUT_MS,
      })
    } catch (e) {
      return refuse(400, `the request can't be sent: ${(e as Error).message}`)
    }
    let finished = false
    const done = (result: unknown) => {
      if (finished) return
      finished = true
      o.audit({ ...entry, used: swapped.used, result })
    }
    up.on('response', (answer) => {
      const encoding = String(answer.headers['content-encoding'] ?? 'identity')
      const transfer = String(answer.headers['transfer-encoding'] ?? '')
      if (
        revealed.length &&
        (encoding !== 'identity' || /gzip|deflate|compress|br/i.test(transfer))
      ) {
        answer.destroy()
        return refuse(502, `a ${encoding} answer can't be checked for the key`)
      }
      // Whatever the host sends back, a real value goes back to its placeholder.
      const back: string[] = []
      const raw = withoutHop(answer.rawHeaders)
      for (let i = 0; i < raw.length; i += 2) {
        // The body may change length once a value is taken out.
        if (revealed.length && raw[i].toLowerCase() === 'content-length')
          continue
        back.push(raw[i], redactText(raw[i + 1], revealed))
      }
      res.writeHead(answer.statusCode ?? 502, back)
      const body = revealed.length ? answer.pipe(new Redact(revealed)) : answer
      body.pipe(res)
      answer.on('end', () => done(answer.statusCode))
      // A broken answer is cut off, never ended as if it were whole.
      const broke = () => {
        done('upstream broke off')
        res.destroy()
      }
      answer.on('error', broke)
      answer.on('aborted', broke)
    })
    up.on('timeout', () => up.destroy(new Error('timed out')))
    up.on('error', (e) => {
      done(`upstream: ${e.message}`)
      if (!res.headersSent) {
        res.writeHead(502, {
          'content-type': 'text/plain',
          connection: 'close',
        })
        res.end('mirab station: the host did not answer\n')
      } else res.destroy()
    })
    req.pipe(up)
    req.on('error', () => up.destroy())
    // The VM gone: so is its request upstream.
    res.on('close', () => up.destroy())
  }

  // Bun serves the default certificate whatever the SNI, so one leaf names every host.
  const server = createServer(
    { key: leaf.key, cert: leaf.cert, ALPNProtocols: ['http/1.1'] },
    (req, res) =>
      void handle(req, res).catch(() => {
        if (res.headersSent) return void res.destroy()
        res.writeHead(502, { connection: 'close' })
        res.end()
      }),
  )
  // Unix socket paths are limited to 104 bytes on macOS.
  const dir = await mkdtemp(join(tmpdir(), 'mi-'))
  const socketPath = join(dir, 's')
  await new Promise<void>((r) => server.listen(socketPath, r))
  const open = new Set<Socket>()
  return {
    handles: (host) => hosts.some((h) => allowed(host, [h])),
    open(vm, first) {
      const inner = connect(socketPath)
      open.add(inner)
      inner.on('close', () => {
        open.delete(inner)
        vm.destroy()
      })
      inner.on('error', () => vm.destroy())
      vm.on('error', () => inner.destroy())
      vm.on('close', () => inner.destroy())
      // An opened connection with nothing either way for this long is closed.
      vm.setTimeout(IDLE_MS, () => vm.destroy())
      inner.write(first)
      vm.pipe(inner)
      inner.pipe(vm)
      vm.resume()
    },
    async close() {
      for (const s of open) s.destroy()
      await new Promise<void>((r) => server.close(() => r()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}
