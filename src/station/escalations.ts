// Escalation (docs/architecture.md section 5): an agent that hits the
// whitelist asks for the host, and a person decides, outside the VM. The
// station only ever appends asks, one line each, to that agent's own file;
// `mirab escalations` reads them, and `mirab allow|dismiss|revoke <host>`,
// run in the person's own terminal, write the answers to files the station
// only reads. So no write of one can undo the other, one VM's asks never push
// out another's, and nothing in the VM can reach any of it.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { domainProblem } from '../agent/define'

/** New hosts one agent may ask for per minute; the rest are refused without a record. */
const ASKS_PER_MINUTE = 10

export interface Ask {
  /** Whose ask: an agent's harar name, or `project:<path>` for a spawned CLI. */
  agent: string
  host: string
  first: string
  last: string
  count: number
}

/** A file name for an agent, short enough for any filesystem. */
function fileName(agent: string) {
  const name = encodeURIComponent(agent)
  if (name.length <= 120) return name
  const hash = new Bun.CryptoHasher('sha256')
    .update(agent)
    .digest('hex')
    .slice(0, 16)
  return `${name.slice(0, 100)}-${hash}`
}

const asksPath = (configDir: string, agent: string) =>
  join(configDir, 'asks', `${fileName(agent)}.jsonl`)
const dismissedPath = (configDir: string, agent: string) =>
  join(configDir, 'dismissed', `${fileName(agent)}.json`)
/** One file per agent: the hosts a person allowed it beyond its manifest. */
export const allowPath = (configDir: string, agent: string) =>
  join(configDir, 'allow', `${fileName(agent)}.json`)

function readJson<T>(path: string, empty: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return empty
  }
}

/** Written aside and renamed into place, so a reader never sees half a file. */
function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  const part = `${path}.${process.pid}.part`
  writeFileSync(part, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(part, path)
}

const normal = (host: string) => host.toLowerCase().replace(/\.$/, '')

/**
 * The station's side, for one agent: records asks, at most once per host per
 * station run and `ASKS_PER_MINUTE` new hosts a minute, so a VM that floods
 * the station with names costs almost nothing and buries no one's asks.
 */
export function asker(configDir: string, agent: string) {
  const seen = new Set<string>()
  let minute = 0
  let thisMinute = 0
  return (host: string, now = new Date()) => {
    const name = normal(host)
    if (seen.has(name) || domainProblem(name)) return
    const at = Math.floor(now.getTime() / 60_000)
    if (at !== minute) {
      minute = at
      thisMinute = 0
    }
    if (thisMinute >= ASKS_PER_MINUTE) return
    thisMinute++
    seen.add(name)
    const path = asksPath(configDir, agent)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    appendFileSync(
      path,
      JSON.stringify({ agent, host: name, at: now.toISOString() }) + '\n',
      { mode: 0o600 },
    )
  }
}

/** The station's side: the hosts a person allowed `agent`, re-read only when the file changes. */
export function grants(configDir: string, agent: string) {
  const path = allowPath(configDir, agent)
  let stamp = ''
  let hosts: string[] = []
  return () => {
    let now = ''
    try {
      const st = statSync(path)
      now = `${st.mtimeMs}:${st.size}`
    } catch {
      now = 'none'
    }
    if (now !== stamp) {
      stamp = now
      hosts = allowedFor(configDir, agent)
    }
    return hosts
  }
}

/** The hosts a person allowed `agent` beyond its manifest. */
export function allowedFor(configDir: string, agent: string): string[] {
  const file = readJson<{ hosts?: unknown }>(allowPath(configDir, agent), {})
  return Array.isArray(file.hosts)
    ? file.hosts.filter(
        (h): h is string => typeof h === 'string' && !domainProblem(h),
      )
    : []
}

/** What waits for a person: every agent's asks, minus what was allowed or
 *  dismissed since; the most asked-for first. */
export function asks(configDir: string): Ask[] {
  let files: string[] = []
  try {
    files = readdirSync(join(configDir, 'asks')).filter((f) =>
      f.endsWith('.jsonl'),
    )
  } catch {
    return []
  }
  const out: Ask[] = []
  for (const file of files) {
    const byHost = new Map<string, Ask>()
    const answers = new Map<
      string,
      { allowed: Set<string>; dismissed: Record<string, string> }
    >()
    const answered = (agent: string) => {
      let known = answers.get(agent)
      if (!known) {
        known = {
          allowed: new Set(allowedFor(configDir, agent)),
          dismissed: readJson<Record<string, string>>(
            dismissedPath(configDir, agent),
            {},
          ),
        }
        answers.set(agent, known)
      }
      return known
    }
    for (const line of readFileSync(
      join(configDir, 'asks', file),
      'utf8',
    ).split('\n')) {
      let entry: { agent?: unknown; host?: unknown; at?: unknown }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const { agent, host, at } = entry
      if (
        typeof agent !== 'string' ||
        typeof host !== 'string' ||
        typeof at !== 'string' ||
        domainProblem(host)
      )
        continue
      const { allowed, dismissed } = answered(agent)
      if (allowed.has(host) || (dismissed[host] && at <= dismissed[host]))
        continue
      const key = `${agent}\n${host}`
      const seen = byHost.get(key)
      if (seen) {
        seen.count++
        seen.last = at
      } else byHost.set(key, { agent, host, first: at, last: at, count: 1 })
    }
    out.push(...byHost.values())
  }
  return out.sort((a, b) => b.count - a.count || (b.last > a.last ? 1 : -1))
}

/** A person's yes: `host` joins `agent`'s allow file, which answers its ask. */
export function allow(configDir: string, agent: string, host: string) {
  const name = normal(host)
  const problem = domainProblem(name)
  if (problem) throw new Error(`${host} ${problem}`)
  const hosts = allowedFor(configDir, agent)
  if (!hosts.includes(name))
    writeJson(allowPath(configDir, agent), { hosts: [...hosts, name].sort() })
}

/** A person's no, now: this ask is answered; a later one shows again. */
export function dismiss(
  configDir: string,
  agent: string,
  host: string,
  now = new Date(),
) {
  const dismissed = readJson<Record<string, string>>(
    dismissedPath(configDir, agent),
    {},
  )
  dismissed[normal(host)] = now.toISOString()
  writeJson(dismissedPath(configDir, agent), dismissed)
}

/** Takes back a yes: the host is refused again from the next connection. */
export function revoke(configDir: string, agent: string, host: string) {
  const name = normal(host)
  const hosts = allowedFor(configDir, agent)
  if (!hosts.includes(name)) throw new Error(`${agent} wasn't allowed ${name}`)
  writeJson(allowPath(configDir, agent), {
    hosts: hosts.filter((h) => h !== name),
  })
}

// Which of the person's secrets an agent may use. A project's .env names
// harar:// references, and it comes with whatever repo was cloned, so a
// reference alone gives an agent nothing: the person grants each secret to
// each agent once, here, outside the VM (`mirab secrets allow`), and harar
// still decides where it may go.

const SECRET_PATH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/

/** One file per agent: the harar secrets a person let it use. */
export const secretsPath = (configDir: string, agent: string) =>
  join(configDir, 'secrets', `${fileName(agent)}.json`)

/** The secrets `agent` may use. */
export function secretGrants(configDir: string, agent: string): string[] {
  const file = readJson<{ secrets?: unknown }>(
    secretsPath(configDir, agent),
    {},
  )
  return Array.isArray(file.secrets)
    ? file.secrets.filter(
        (s): s is string => typeof s === 'string' && SECRET_PATH.test(s),
      )
    : []
}

export function allowSecret(configDir: string, agent: string, secret: string) {
  if (
    !SECRET_PATH.test(secret) ||
    secret.split('/').some((p) => p === '..' || p === '.')
  )
    throw new Error(`${secret} isn't a harar secret path`)
  const secrets = secretGrants(configDir, agent)
  if (!secrets.includes(secret))
    writeJson(secretsPath(configDir, agent), {
      secrets: [...secrets, secret].sort(),
    })
}

export function revokeSecret(configDir: string, agent: string, secret: string) {
  const secrets = secretGrants(configDir, agent)
  if (!secrets.includes(secret))
    throw new Error(`${agent} wasn't allowed ${secret}`)
  writeJson(secretsPath(configDir, agent), {
    secrets: secrets.filter((s) => s !== secret),
  })
}
