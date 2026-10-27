// The station's model routes. The VM sends a placeholder; the station adds
// the person's long-lived credential on the way out, so nothing in the VM
// ever holds it (docs/architecture.md section 5). The credential comes from
// harar's send for the route's own host, like any other key: harar decides,
// and records each time.
import { EGRESS_GUEST_PORT } from '../isolation/vz'
import type { StationConfig } from './config'
import type { Route } from './egress'
import { hararSend } from './harar'

export const ANTHROPIC = 'https://api.anthropic.com'
/** What the VM sends where a key or token would be. */
export const PLACEHOLDER = 'mirab-placeholder'

/** The base URL a route has in the guest: the station's loopback port. */
export const guestRouteURL = (name: string) =>
  `http://127.0.0.1:${EGRESS_GUEST_PORT}/${name}`

/** `secret` for `upstream`'s host, from harar's send; a refusal says how to
 *  let it go there. */
function sent(socket: string, secret: string, upstream: string) {
  const host = new URL(upstream).hostname
  return () =>
    hararSend(socket, secret, host).catch((e: Error) => {
      throw new Error(
        `${e.message} (to let it: harar hosts allow ${secret} ${host}, or a role's send at a primary)`,
      )
    })
}

/** An API key (mirab's own agent loop): `x-api-key`. */
export function anthropicKeyRoute(
  station: StationConfig,
  upstream = ANTHROPIC,
): Route | undefined {
  const key = station.models.anthropic?.key
  if (!key) return undefined
  return {
    upstream,
    header: 'x-api-key',
    paths: ['/v1/messages'],
    credential: sent(station.harar.socket, key, upstream),
  }
}

/** Claude Code on the person's own subscription: its OAuth token
 *  (`claude setup-token`) as `Authorization: Bearer`. */
export function claudeRoute(
  station: StationConfig,
  upstream = ANTHROPIC,
): Route | undefined {
  const token = station.models.claude?.token
  if (!token) return undefined
  return {
    upstream,
    header: 'authorization',
    format: (credential) => `Bearer ${credential}`,
    paths: ['/v1/messages'],
    credential: sent(station.harar.socket, token, upstream),
  }
}

/** The host's own Anthropic and Claude settings (keys, tokens, custom
 *  headers, Bedrock or Vertex) never reach a VM that uses the route. */
export function withClaudeRoute(
  env: Record<string, string>,
): Record<string, string> {
  const kept = Object.fromEntries(
    Object.entries(env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_)/.test(k)),
  )
  return { ...kept, ...claudeGuestEnvironment() }
}

/** Claude Code's environment in the guest: the placeholder token, the
 *  station's route as its API, and nothing else on the network (no
 *  telemetry, error reports or self-updates). Anything else it tries goes
 *  to the station as a proxy, where the whitelist decides and the audit log
 *  shows it. */
export const claudeGuestEnvironment = (): Record<string, string> => ({
  ANTHROPIC_BASE_URL: guestRouteURL('claude'),
  HTTPS_PROXY: `http://127.0.0.1:${EGRESS_GUEST_PORT}`,
  HTTP_PROXY: `http://127.0.0.1:${EGRESS_GUEST_PORT}`,
  NO_PROXY: '127.0.0.1,localhost',
  CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
})
