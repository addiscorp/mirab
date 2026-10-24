// station.json in mirab's config directory: where the station's harar is,
// and which harar secret each model route adds. Explicit, so nothing comes
// from the environment.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { secretsSchema } from './secrets'

export const stationConfigSchema = z.strictObject({
  harar: z.strictObject({
    /** The harar primary's (or per-user agent's) socket. */
    socket: z.string().startsWith('/', 'the harar socket is an absolute path'),
  }),
  models: z.strictObject({
    anthropic: z
      .strictObject({
        /** The harar secret holding the API key, e.g. `personal/anthropic/API_KEY`. */
        key: z.string().min(1),
      })
      .optional(),
    claude: z
      .strictObject({
        /** The harar secret holding Claude Code's token (`claude setup-token`),
         *  for Claude Code in a VM on the person's own subscription. */
        token: z.string().min(1),
      })
      .optional(),
  }),
  /** Keys for any service: each harar secret a project's .env may name, and
   *  the hosts it may go to. The VM gets placeholders; the station swaps them. */
  secrets: secretsSchema.optional(),
})
export type StationConfig = z.infer<typeof stationConfigSchema>

export const STATION_EXAMPLE = JSON.stringify(
  {
    harar: { socket: '/var/run/harar.sock' },
    models: {
      anthropic: { key: 'personal/anthropic/API_KEY' },
      claude: { token: 'personal/claude/OAUTH_TOKEN' },
    },
  },
  null,
  2,
)

/** station.json, or undefined when there is none and `optional` says that's fine. */
export async function loadStationConfig(
  configDir: string,
): Promise<StationConfig>
export async function loadStationConfig(
  configDir: string,
  options: { optional: true },
): Promise<StationConfig | undefined>
export async function loadStationConfig(
  configDir: string,
  options?: { optional: true },
): Promise<StationConfig | undefined> {
  const path = join(configDir, 'station.json')
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined && options?.optional) return undefined
  if (text === undefined)
    throw new Error(
      `${path} is missing: it says where harar is and which secret is the model key, like\n${STATION_EXAMPLE}`,
    )
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${path} isn't JSON`)
  }
  const parsed = stationConfigSchema.safeParse(data)
  if (!parsed.success)
    throw new Error(
      `${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  return parsed.data
}
