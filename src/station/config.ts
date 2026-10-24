// station.json in mirab's config directory: where the station's harar is,
// and which harar secret each model route adds. Explicit, so nothing comes
// from the environment.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

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
  }),
})
export type StationConfig = z.infer<typeof stationConfigSchema>

export const STATION_EXAMPLE = JSON.stringify(
  {
    harar: { socket: '/var/run/harar.sock' },
    models: { anthropic: { key: 'personal/anthropic/API_KEY' } },
  },
  null,
  2,
)

export async function loadStationConfig(
  configDir: string,
): Promise<StationConfig> {
  const path = join(configDir, 'station.json')
  const text = await readFile(path, 'utf8').catch(() => undefined)
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
