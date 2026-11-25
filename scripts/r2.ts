// Hands release files from job to job through R2, never GitHub artifacts:
// the private mirab-staging bucket, never mirab-releases. Bun's own S3
// client: the mirab image has no aws CLI, and Bun is on every runner of ours
// (the avacanada/ava scripts/r2.ts pattern).
//
//   bun scripts/r2.ts stage <dir> <prefix/>     every file in the folder, then
//                                               <prefix/>files.json: path, size, sha256
//   bun scripts/r2.ts fetch <prefix/> <dir>     every file files.json lists, each
//                                               checked against its size and sha256
//   bun scripts/r2.ts clean <prefix/>           every object under the prefix
//
// fetch refuses (exit 1) when files.json is missing, or a listed file is
// missing or its bytes differ from what stage recorded. Objects under the
// prefix that files.json doesn't list (a re-run's leftovers) are ignored.
//
// Credentials and place come from the environment the workflow sets, all
// STAGING_-prefixed so the publish job's own release keys (AWS_*, R2_*) are
// never picked up by mistake: STAGING_R2_ENDPOINT, STAGING_AWS_ACCESS_KEY_ID,
// STAGING_AWS_SECRET_ACCESS_KEY, STAGING_R2_BUCKET.
import { S3Client } from 'bun'
import { mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const MANIFEST = 'files.json'

export interface StagedFile {
  path: string
  size: number
  sha256: string
}

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} isn't set`)
  return v
}

export function client(): S3Client {
  return new S3Client({
    accessKeyId: env('STAGING_AWS_ACCESS_KEY_ID'),
    secretAccessKey: env('STAGING_AWS_SECRET_ACCESS_KEY'),
    endpoint: env('STAGING_R2_ENDPOINT'),
    bucket: env('STAGING_R2_BUCKET'),
    region: 'auto',
  })
}

function prefixOf(p: string): string {
  if (!p.endsWith('/') || p.startsWith('/') || p.split('/').includes('..')) {
    throw new Error(`${p}: a prefix is relative and ends with /`)
  }
  return p
}

export async function sha256(file: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(file).stream()) h.update(chunk)
  return h.digest('hex')
}

/** Every key under `prefix`, following the listing's pages. */
async function keys(s3: S3Client, prefix: string): Promise<string[]> {
  const out: string[] = []
  let startAfter: string | undefined
  for (;;) {
    const page = await s3.list({ prefix, startAfter, maxKeys: 1000 })
    const found = (page.contents ?? []).map((c) => c.key)
    out.push(...found)
    if (!page.isTruncated || found.length === 0) return out
    startAfter = found[found.length - 1]
  }
}

/** Uploads every file under `dir`, then the manifest of what it uploaded. */
export async function stage(
  s3: S3Client,
  dir: string,
  prefix: string,
): Promise<StagedFile[]> {
  prefixOf(prefix)
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => relative(dir, join(f.parentPath, f.name)).split(sep).join('/'))
    .sort()
  if (files.length === 0) throw new Error(`${dir} has no files to stage`)
  if (files.includes(MANIFEST))
    throw new Error(`${dir}/${MANIFEST} would clash with the manifest`)
  const staged: StagedFile[] = []
  for (const path of files) {
    const from = join(dir, path)
    const entry = {
      path,
      size: Bun.file(from).size,
      sha256: await sha256(from),
    }
    await s3.write(prefix + path, Bun.file(from), {
      type: 'application/octet-stream',
    })
    staged.push(entry)
    console.log(
      `staged ${from} → ${prefix}${path} (${entry.size} bytes, sha256 ${entry.sha256})`,
    )
  }
  // Last, so a fetch never sees a manifest whose files aren't all there yet.
  await s3.write(prefix + MANIFEST, JSON.stringify(staged, null, 2) + '\n', {
    type: 'application/json',
  })
  return staged
}

/** Downloads every file the manifest lists and checks each one's bytes. */
export async function fetchStaged(
  s3: S3Client,
  prefix: string,
  dir: string,
): Promise<StagedFile[]> {
  prefixOf(prefix)
  const manifest = s3.file(prefix + MANIFEST)
  if (!(await manifest.exists()))
    throw new Error(`${prefix}${MANIFEST} isn't there: nothing was staged`)
  const staged = (await manifest.json()) as StagedFile[]
  if (!Array.isArray(staged) || staged.length === 0)
    throw new Error(`${prefix}${MANIFEST} lists no files`)
  for (const f of staged) {
    if (f.path.startsWith('/') || f.path.split('/').includes('..'))
      throw new Error(`${f.path}: not a path under ${dir}`)
    const to = join(dir, f.path)
    mkdirSync(dirname(to), { recursive: true })
    const object = s3.file(prefix + f.path)
    if (!(await object.exists()))
      throw new Error(
        `${prefix}${f.path} is listed in ${MANIFEST} but isn't there`,
      )
    await Bun.write(to, object)
    const size = Bun.file(to).size
    const got = await sha256(to)
    if (size !== f.size || got !== f.sha256) {
      throw new Error(
        `${prefix}${f.path} doesn't match what was staged: ${size} bytes, sha256 ${got}; expected ${f.size} bytes, sha256 ${f.sha256}`,
      )
    }
    console.log(`fetched ${prefix}${f.path} → ${to} (sha256 ${got}, matches)`)
  }
  return staged
}

/** Deletes every object under `prefix`. */
export async function clean(s3: S3Client, prefix: string): Promise<number> {
  prefixOf(prefix)
  const all = await keys(s3, prefix)
  for (const k of all) await s3.delete(k)
  console.log(`removed ${all.length} object(s) under ${prefix}`)
  return all.length
}

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2)
  try {
    if (cmd === 'stage' && a && b) await stage(client(), a, b)
    else if (cmd === 'fetch' && a && b) await fetchStaged(client(), a, b)
    else if (cmd === 'clean' && a) await clean(client(), a)
    else
      throw new Error(
        'usage: r2.ts stage <dir> <prefix/> | fetch <prefix/> <dir> | clean <prefix/>',
      )
  } catch (e) {
    console.error(`r2.ts: ${(e as Error).message}`)
    process.exit(1)
  }
}
