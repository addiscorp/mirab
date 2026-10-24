// Keys for any service, without the VM ever holding one. A project's .env
// names its secrets by reference (`STRIPE_KEY=harar://prod/shop/STRIPE_KEY`,
// what `harar import` leaves); the VM gets a placeholder for each, different
// every session. On the way out, for a host that station.json lists for that
// secret, the station swaps the placeholder in the request's headers for the
// real value from harar. Anywhere else the request is refused. Bodies and URLs
// are never rewritten.
import { z } from 'zod'
import { domainProblem } from '../agent/define'
import { allowed } from './hosts'

/** station.json `secrets`: each harar secret, and the hosts it may go to. */
export const secretsSchema = z.record(
  z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/, 'a harar secret path'),
  z.strictObject({
    hosts: z
      .array(
        z.string().superRefine((host, ctx) => {
          const problem = domainProblem(host)
          if (problem)
            ctx.addIssue({ code: 'custom', message: `host ${problem}` })
        }),
      )
      .min(1),
  }),
)
export type Secrets = z.infer<typeof secretsSchema>

/** Every placeholder looks like this, so the station can find them in a header. */
export const PLACEHOLDER = /mirab-ph-[0-9a-f]{24}/g
const HAS_PLACEHOLDER = /mirab-ph-[0-9a-f]{24}/

/** One VM session's placeholders: a fresh one per secret, kept only in the station. */
export class Placeholders {
  private readonly bySecret = new Map<string, string>()
  private readonly byToken = new Map<string, string>()

  for(secret: string): string {
    let token = this.bySecret.get(secret)
    if (!token) {
      token = `mirab-ph-${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('hex')}`
      this.bySecret.set(secret, token)
      this.byToken.set(token, secret)
    }
    return token
  }

  secretOf(token: string): string | undefined {
    return this.byToken.get(token)
  }

  get size() {
    return this.byToken.size
  }
}

/** `harar://` references in a .env file: variable name → secret path. */
export function referencesIn(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    if (value.startsWith('harar://'))
      out.set(m[1], value.slice('harar://'.length))
  }
  return out
}

export type Swap =
  | {
      ok: true
      headers: string[]
      used: string[]
      /** Each real text the swap put in, and the placeholder text it replaced:
       *  for taking a value back out of anything the host sends back. */
      revealed: [real: string, placeholder: string][]
    }
  | { ok: false; reason: string }

/** Header names the station never passes on. */
const DROP = new Set(['proxy-authorization', 'proxy-connection'])

/**
 * The request's headers with every placeholder replaced by its real value,
 * or why not. `rawHeaders` is [name, value, name, value, ...] as Node gives
 * it. Basic credentials are decoded, swapped and encoded again, since git and
 * other HTTP clients send tokens that way.
 */
export async function swapHeaders(
  host: string,
  rawHeaders: string[],
  placeholders: Placeholders,
  secrets: Secrets,
  value: (secret: string) => Promise<string>,
): Promise<Swap> {
  const used = new Set<string>()
  const revealed: [string, string][] = []
  const swapIn = async (text: string): Promise<string | { reason: string }> => {
    let out = text
    for (const token of new Set(text.match(PLACEHOLDER) ?? [])) {
      const secret = placeholders.secretOf(token)
      if (!secret)
        return { reason: 'a placeholder this session never gave out' }
      const rule = Object.hasOwn(secrets, secret) ? secrets[secret] : undefined
      if (!rule || !allowed(host, rule.hosts))
        return { reason: `${secret} doesn't go to ${host}` }
      const real = await value(secret)
      if (!real) return { reason: `${secret} is empty in harar` }
      if (/[\r\n\0]/.test(real)) return { reason: `${secret} isn't one line` }
      out = out.split(token).join(real)
      used.add(secret)
      revealed.push([real, token])
    }
    return out
  }
  const headers: string[] = []
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]
    let text = rawHeaders[i + 1]
    if (DROP.has(name.toLowerCase())) continue
    const basic = /^(basic\s+)([A-Za-z0-9+/=]+)$/i.exec(text)
    const decoded = basic
      ? Buffer.from(basic[2], 'base64').toString('utf8')
      : undefined
    // Basic credentials are touched only when they hold a placeholder, so any
    // other (even binary) credential passes exactly as sent.
    if (basic && decoded !== undefined && HAS_PLACEHOLDER.test(decoded)) {
      const swapped = await swapIn(decoded)
      if (typeof swapped !== 'string') return { ok: false, ...swapped }
      const encoded = Buffer.from(swapped, 'utf8').toString('base64')
      revealed.push([encoded, basic[2]])
      text = basic[1] + encoded
    } else {
      const swapped = await swapIn(text)
      if (typeof swapped !== 'string') return { ok: false, ...swapped }
      text = swapped
    }
    headers.push(name, text)
  }
  return { ok: true, headers, used: [...used], revealed }
}
