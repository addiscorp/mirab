// The station for one VM: its routes, its whitelist and, when the project's
// .env names harar secrets that station.json gives hosts for, the hosts it
// opens to swap placeholders for keys. Shared by `mirab spawn --vm` and
// `mirab dev`, so both give a VM the same way out.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Isolation } from '../isolation/session'
import { EGRESS_GUEST_PORT, EGRESS_HOST_PORT } from '../isolation/vz'
import { stationAuthority } from './ca'
import type { StationConfig } from './config'
import { auditor, lookupAll, startEgress, type Route } from './egress'
import { hararGet } from './harar'
import { startIntercept, type Intercept, type Upstream } from './intercept'
import { Placeholders, referencesIn, type Secrets } from './secrets'

/** Where the station's authority lands in the guest. */
export const GUEST_CA = '/usr/local/share/ca-certificates/mirab-station.crt'
/** How long a secret's value is kept before harar is asked again. */
const VALUE_TTL_MS = 5 * 60_000
/** The bundle curl, git, Go and OpenSSL programs read. */
const GUEST_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'

export interface VmStation {
  /** What the guest's programs get: a placeholder per secret, and the station as their proxy. */
  env: Record<string, string>
  /** Things the person should know (a reference station.json has no hosts for). */
  notes: string[]
  /** Serves the VM's way out, and makes the guest trust the station's authority. */
  attach(iso: Isolation): Promise<void>
  close(): Promise<void>
}

export async function vmStation(o: {
  project: string
  station: StationConfig
  configDir: string
  zone: string
  auditLog: string
  routes: Record<string, Route>
  allow: string[]
  /** Tests point the hosts the station opens at a local stand-in. */
  upstream?: (host: string) => Promise<Upstream>
}): Promise<VmStation> {
  const text = await readFile(join(o.project, '.env'), 'utf8').catch(() => '')
  const references = referencesIn(text)
  const configured = o.station.secrets ?? {}
  const placeholders = new Placeholders()
  const secrets: Secrets = Object.create(null)
  const env: Record<string, string> = {}
  const notes: string[] = []
  for (const [name, secret] of references) {
    if (!Object.hasOwn(configured, secret)) {
      notes.push(
        `${name} names harar://${secret}, which station.json has no hosts for (secrets); the VM doesn't get it`,
      )
      continue
    }
    secrets[secret] = configured[secret]
    env[name] = placeholders.for(secret)
  }
  // Each secret is read from harar at most every VALUE_TTL_MS, so a rotated
  // key is picked up; a failure is not kept.
  const values = new Map<string, { value: Promise<string>; until: number }>()
  const value = (secret: string) => {
    const held = values.get(secret)
    if (held && held.until > Date.now()) return held.value
    const v = hararGet(o.station.harar.socket, secret)
    v.catch(() => values.delete(secret))
    values.set(secret, { value: v, until: Date.now() + VALUE_TTL_MS })
    return v
  }
  const audit = auditor(o.zone, o.auditLog)
  let intercept: Intercept | undefined
  let authority: Awaited<ReturnType<typeof stationAuthority>> | undefined
  if (placeholders.size) {
    authority = await stationAuthority(join(o.configDir, 'station-ca'))
    intercept = await startIntercept({
      secrets,
      placeholders,
      value,
      authority,
      audit,
      resolve: lookupAll,
      upstream: o.upstream,
    })
    const proxy = `http://127.0.0.1:${EGRESS_GUEST_PORT}`
    Object.assign(env, {
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      NODE_EXTRA_CA_CERTS: GUEST_CA,
    })
  }
  return {
    env,
    notes,
    async attach(iso) {
      await iso.onGuestConnect!(EGRESS_HOST_PORT, (socketPath) =>
        startEgress({
          socketPath,
          zone: o.zone,
          allow: o.allow,
          routes: o.routes,
          auditLog: o.auditLog,
          intercept,
        }),
      )
      if (!authority) return
      await iso.put(GUEST_CA, authority.cert, 0o644)
      const code = await iso.exec(
        ['sh', '-c', `cat ${GUEST_CA} >> ${GUEST_BUNDLE}`],
        {
          cwd: '/',
          env: { PATH: '/usr/bin:/bin' },
          timeoutMs: 10_000,
          signal: new AbortController().signal,
          onLine: async () => {},
        },
      )
      if (code !== 0)
        throw new Error("the VM couldn't be told to trust the station")
    },
    close: async () => intercept?.close(),
  }
}
