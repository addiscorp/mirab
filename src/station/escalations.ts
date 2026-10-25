// Escalation (docs/architecture.md section 5): an agent that hits the
// whitelist asks for the host, and a person decides, outside the VM. The
// station records each ask in the config directory; `mirab escalations` lists
// them and `mirab allow <host>`, run in the person's own terminal, adds the
// host to that agent's allow file, which the running station reads on the next
// connection. Nothing in the VM can reach either file or the command.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { domainProblem } from '../agent/define'

/** At most this many hosts are remembered as asked for; the oldest go first. */
const MAX_ASKS = 100

export interface Ask {
  /** Whose ask: an agent's harar name, or `project:<path>` for a spawned CLI. */
  agent: string
  host: string
  first: string
  last: string
  count: number
}

const asksPath = (configDir: string) => join(configDir, 'escalations.json')
/** One file per agent: the hosts a person allowed it beyond its manifest. */
export const allowPath = (configDir: string, agent: string) =>
  join(configDir, 'allow', `${encodeURIComponent(agent)}.json`)

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

export function asks(configDir: string): Ask[] {
  const list = readJson<Ask[]>(asksPath(configDir), [])
  return Array.isArray(list) ? list : []
}

/** Records that `agent` asked for `host`. Only hosts a whitelist could hold are kept. */
export function recordAsk(
  configDir: string,
  agent: string,
  host: string,
  now = new Date(),
) {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (domainProblem(name)) return
  const list = asks(configDir)
  const at = now.toISOString()
  const seen = list.find((ask) => ask.agent === agent && ask.host === name)
  if (seen) {
    seen.last = at
    seen.count++
  } else list.push({ agent, host: name, first: at, last: at, count: 1 })
  writeJson(asksPath(configDir), list.slice(-MAX_ASKS))
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

/** A person's yes: `host` joins `agent`'s allow file, and its ask is done. */
export function allow(configDir: string, agent: string, host: string) {
  const problem = domainProblem(host)
  if (problem) throw new Error(`${host} ${problem}`)
  const hosts = allowedFor(configDir, agent)
  if (!hosts.includes(host))
    writeJson(allowPath(configDir, agent), { hosts: [...hosts, host].sort() })
  writeJson(
    asksPath(configDir),
    asks(configDir).filter(
      (ask) => !(ask.agent === agent && ask.host === host),
    ),
  )
}

/** A person's no: the ask is dropped (the agent may ask again). */
export function dismiss(configDir: string, agent: string, host: string) {
  writeJson(
    asksPath(configDir),
    asks(configDir).filter(
      (ask) => !(ask.agent === agent && ask.host === host),
    ),
  )
}
