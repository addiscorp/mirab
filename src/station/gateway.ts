// mirab's side of rixse's gateway (`import { gateway } from 'rixse'`): one
// gateway session per VM, mounted as the VM's only way out. The gateway
// knows nothing about VMs; this maps the guest's egress port to it, puts its
// certificate authority where the guest's programs trust it, and passes its
// environment on. Shared by `mirab spawn --vm` and `mirab dev`.
import { gateway, type Route, type Upstream } from 'rixse'
import type { Isolation } from '../isolation/session'
import { EGRESS_GUEST_PORT, EGRESS_HOST_PORT } from '../isolation/vz'
import type { StationConfig } from './config'
import { hararVault } from './vault'
import { shellQuote } from '../spawn-adapters/types'

/** Where the gateway's authority lands in the guest. */
export const GUEST_CA = '/usr/local/share/ca-certificates/mirab-station.crt'
/** The bundle curl, git, Go and OpenSSL programs read. */
const GUEST_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'
/** The gateway's address in the guest. */
export const GUEST_PROXY = `http://127.0.0.1:${EGRESS_GUEST_PORT}`

export interface VmStation {
  /** What the guest's programs get: a placeholder per secret, and the gateway as their proxy. */
  env: Record<string, string>
  /** Things the person should know. */
  notes: string[]
  /** Serves the VM's way out, and makes the guest trust the gateway's authority. */
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
  /** Whose grants: `project:<real path>`. */
  agent: string
  /** Tests point the hosts the gateway opens at a local stand-in. */
  upstream?: (host: string) => Promise<Upstream>
}): Promise<VmStation> {
  const session = await gateway({
    project: o.project,
    vault: hararVault(o.station.harar.socket),
    configDir: o.configDir,
    zone: o.zone,
    auditLog: o.auditLog,
    routes: o.routes,
    allow: o.allow,
    agent: o.agent,
    guest: { proxy: GUEST_PROXY, caPath: GUEST_CA },
    upstream: o.upstream,
  })
  // The gateway says what's missing; mirab says how to give it, here.
  const notes = session.notes.map((note) => {
    // The agent is the one mirab named; a project path can hold spaces.
    const m = /names harar:\/\/(\S+), which /.exec(note)
    return m && note.includes(`, which ${o.agent} hasn't been allowed`)
      ? `${note}. Allow it: mirab secrets allow ${m[1]} --agent ${shellQuote(o.agent)}`
      : note
  })
  if (o.station.secrets !== undefined)
    notes.push(
      "station.json's secrets are ignored now: harar says where each secret may go (harar hosts allow <secret> <host>, or a role's send at a primary)",
    )
  return {
    env: session.env,
    notes,
    async attach(iso) {
      await iso.onGuestConnect!(EGRESS_HOST_PORT, (socketPath) =>
        session.listen(socketPath),
      )
      if (!session.caCert) return
      await iso.put(GUEST_CA, session.caCert, 0o644)
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
        throw new Error("the VM couldn't be told to trust the gateway")
    },
    close: () => session.close(),
  }
}
