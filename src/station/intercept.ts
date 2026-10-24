// The station opening a tunnel for a host it holds keys for (secrets.ts).
// egress checks the CONNECT and the TLS server name as for any tunnel, then
// hands the connection here instead of to the host: it goes into the
// station's own HTTPS server (a private socket, certificate from ca.ts),
// where each request's placeholders are swapped for real values and the
// request is sent on over the station's own TLS, to an address it checked,
// with the host's real certificate verified.
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
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
  /** A secret's real value (harar, through the station's cache). */
  value(secret: string): Promise<string>
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
    const address = addresses[0]
    if (!address || !addresses.every(isPublic))
      throw new Error('resolves to an address that is not public')
    return { address, port: 443 }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = String(
      (req.socket as { servername?: string }).servername ?? '',
    ).toLowerCase()
    const path = (req.url ?? '/').split('?')[0]
    const entry = { kind: 'intercept', host, method: req.method, path }
    const refuse = (status: number, reason: string) => {
      o.audit({ ...entry, result: reason })
      req.resume()
      res.writeHead(status, {
        'content-type': 'text/plain',
        connection: 'close',
      })
      res.end(`mirab station: ${reason}\n`)
    }
    // The name the VM's TLS asked for (egress checked it against the CONNECT),
    // and the request must be for that same host.
    if (!hosts.some((h) => allowed(host, [h])))
      return refuse(421, 'not a host the station opens')
    const named = String(req.headers.host ?? '')
      .toLowerCase()
      .replace(/:443$/, '')
    if (named !== host) return refuse(421, `Host ${named} isn't ${host}`)
    const raw = withoutHop(req.rawHeaders)
    let swapped
    try {
      swapped = await swapHeaders(host, raw, o.placeholders, o.secrets, o.value)
    } catch {
      return refuse(502, 'the key could not be read from harar')
    }
    if (!swapped.ok) return refuse(403, swapped.reason)
    let target: Upstream
    try {
      target = await where(host)
    } catch (e) {
      return refuse(502, (e as Error).message)
    }
    const headers: Record<string, string | string[]> = {}
    for (let i = 0; i < swapped.headers.length; i += 2) {
      const name = swapped.headers[i]
      const prev = headers[name]
      headers[name] =
        prev === undefined
          ? swapped.headers[i + 1]
          : ([] as string[]).concat(prev, swapped.headers[i + 1])
    }
    const up = httpsRequest({
      host: target.address,
      port: target.port,
      servername: host,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
      ca: target.ca,
      // The host's own certificate, whatever address it was dialed at.
      checkServerIdentity: (_, cert) => checkServerIdentity(host, cert),
      timeout: REQUEST_TIMEOUT_MS,
    })
    let finished = false
    const done = (result: unknown) => {
      if (finished) return
      finished = true
      o.audit({ ...entry, used: swapped.used, result })
    }
    up.on('response', (answer) => {
      const back = withoutHop(answer.rawHeaders)
      res.writeHead(answer.statusCode ?? 502, back)
      answer.pipe(res)
      answer.on('end', () => done(answer.statusCode))
      answer.on('error', () => done('upstream broke off'))
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
  }

  // Bun serves the default certificate whatever the SNI, so one leaf names every host.
  const server = createServer(
    { key: leaf.key, cert: leaf.cert, ALPNProtocols: ['http/1.1'] },
    (req, res) => void handle(req, res),
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
