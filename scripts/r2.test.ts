// scripts/r2.ts against a local S3 stand-in: a path-style bucket in memory,
// speaking the parts of the S3 API Bun's client uses (PUT, GET, HEAD, DELETE,
// ListObjectsV2). The CLI runs as release.yml runs it: a separate `bun`
// process with the STAGING_* environment.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { S3Client } from 'bun'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MANIFEST,
  clean,
  fetchStaged,
  sha256,
  stage,
  type StagedFile,
} from './r2'

const BUCKET = 'mirab-staging'
const objects = new Map<string, Uint8Array>()
let server: ReturnType<typeof Bun.serve>
let s3: S3Client
let env: Record<string, string>
const tmpRoot = join(import.meta.dir, '..', '.tmp')

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const [, bucket, ...rest] = url.pathname.split('/')
      if (bucket !== BUCKET)
        return new Response('NoSuchBucket', { status: 404 })
      const key = decodeURIComponent(rest.join('/'))
      if (
        req.method === 'GET' &&
        key === '' &&
        url.searchParams.get('list-type') === '2'
      ) {
        const prefix = url.searchParams.get('prefix') ?? ''
        const after = url.searchParams.get('start-after') ?? ''
        const max = Number(url.searchParams.get('max-keys') ?? 1000)
        const all = [...objects.keys()]
          .filter((k) => k.startsWith(prefix) && k > after)
          .sort()
        const page = all.slice(0, max)
        const contents = page
          .map(
            (k) =>
              `<Contents><Key>${xmlEscape(k)}</Key><Size>${objects.get(k)!.length}</Size><ETag>"0"</ETag><LastModified>2026-11-24T00:00:00.000Z</LastModified><StorageClass>STANDARD</StorageClass></Contents>`,
          )
          .join('')
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${all.length > page.length}</IsTruncated>${contents}</ListBucketResult>`,
          { headers: { 'content-type': 'application/xml' } },
        )
      }
      if (req.method === 'PUT') {
        objects.set(key, new Uint8Array(await req.arrayBuffer()))
        return new Response(null, { status: 200, headers: { etag: '"0"' } })
      }
      const body = objects.get(key)
      if (req.method === 'DELETE') {
        objects.delete(key)
        return new Response(null, { status: 204 })
      }
      if (!body)
        return new Response('<Error><Code>NoSuchKey</Code></Error>', {
          status: 404,
        })
      const headers = { 'content-length': String(body.length), etag: '"0"' }
      if (req.method === 'HEAD') return new Response(null, { headers })
      return new Response(body, { headers })
    },
  })
  const endpoint = `http://127.0.0.1:${server.port}`
  s3 = new S3Client({
    accessKeyId: 'test',
    secretAccessKey: 'test',
    endpoint,
    bucket: BUCKET,
    region: 'auto',
  })
  env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    STAGING_R2_ENDPOINT: endpoint,
    STAGING_AWS_ACCESS_KEY_ID: 'test',
    STAGING_AWS_SECRET_ACCESS_KEY: 'test',
    STAGING_R2_BUCKET: BUCKET,
  }
  mkdirSync(tmpRoot, { recursive: true })
})

afterAll(() => server.stop(true))
beforeEach(() => objects.clear())

/** A build job's out/ folder: nested files, one of them binary. */
function buildOutput(): string {
  const dir = mkdtempSync(join(tmpRoot, 'r2-test-'))
  mkdirSync(join(dir, 'linux-x64'), { recursive: true })
  mkdirSync(join(dir, 'darwin-arm64'), { recursive: true })
  writeFileSync(
    join(dir, 'linux-x64', 'vmlinux.gz'),
    crypto.getRandomValues(new Uint8Array(70_000)),
  )
  writeFileSync(
    join(dir, 'linux-x64', 'rootfs.ext4.gz'),
    crypto.getRandomValues(new Uint8Array(4_096)),
  )
  writeFileSync(join(dir, 'darwin-arm64', 'mirab-vz.gz'), 'vz helper\n')
  return dir
}

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(['bun', join(import.meta.dir, 'r2.ts'), ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out =
    (await new Response(p.stdout).text()) +
    (await new Response(p.stderr).text())
  return { code: await p.exited, out }
}

describe('stage, fetch, clean', () => {
  test('fetch gives back the same bytes stage uploaded, and files.json records them', async () => {
    const src = buildOutput()
    const staged = await stage(s3, src, 'staging/1/vm-x64/')
    expect(staged.map((f) => f.path)).toEqual([
      'darwin-arm64/mirab-vz.gz',
      'linux-x64/rootfs.ext4.gz',
      'linux-x64/vmlinux.gz',
    ])
    const manifest = JSON.parse(
      new TextDecoder().decode(objects.get(`staging/1/vm-x64/${MANIFEST}`)!),
    ) as StagedFile[]
    expect(manifest).toEqual(staged)
    for (const f of staged)
      expect(f.sha256).toBe(await sha256(join(src, f.path)))

    const dest = mkdtempSync(join(tmpRoot, 'r2-test-'))
    await fetchStaged(s3, 'staging/1/vm-x64/', dest)
    for (const f of staged)
      expect(readFileSync(join(dest, f.path))).toEqual(
        readFileSync(join(src, f.path)),
      )
  })

  test('fetch refuses a staged file whose bytes changed', async () => {
    await stage(s3, buildOutput(), 'staging/2/vm-x64/')
    const key = 'staging/2/vm-x64/linux-x64/vmlinux.gz'
    const bytes = objects.get(key)!.slice()
    bytes[100] ^= 0xff // same size, one byte flipped
    objects.set(key, bytes)
    const dest = mkdtempSync(join(tmpRoot, 'r2-test-'))
    await expect(fetchStaged(s3, 'staging/2/vm-x64/', dest)).rejects.toThrow(
      /linux-x64\/vmlinux\.gz doesn't match what was staged/,
    )
  })

  test('fetch refuses a missing manifest and a missing listed file, and ignores unlisted leftovers', async () => {
    const dest = mkdtempSync(join(tmpRoot, 'r2-test-'))
    await expect(
      fetchStaged(s3, 'staging/3/vz-darwin-x64/', dest),
    ).rejects.toThrow(/nothing was staged/)

    await stage(s3, buildOutput(), 'staging/3/vz-darwin-x64/')
    objects.set(
      'staging/3/vz-darwin-x64/old-attempt.gz',
      new Uint8Array([1, 2, 3]),
    )
    const got = await fetchStaged(s3, 'staging/3/vz-darwin-x64/', dest)
    expect(got.map((f) => f.path)).not.toContain('old-attempt.gz')
    expect(Bun.file(join(dest, 'old-attempt.gz')).size).toBe(0)

    objects.delete('staging/3/vz-darwin-x64/linux-x64/rootfs.ext4.gz')
    await expect(
      fetchStaged(s3, 'staging/3/vz-darwin-x64/', dest),
    ).rejects.toThrow(/listed in files\.json but isn't there/)
  })

  test('clean removes the run prefix and nothing outside it', async () => {
    await stage(s3, buildOutput(), 'staging/4/vm-x64/')
    await stage(s3, buildOutput(), 'staging/4/vm-arm64/')
    await stage(s3, buildOutput(), 'staging/40/vm-x64/')
    objects.set('0.2.2-canary-13ce444/release.json', new Uint8Array([123, 125]))
    expect(await clean(s3, 'staging/4/')).toBe(8)
    expect(
      [...objects.keys()].filter((k) => k.startsWith('staging/4/')),
    ).toEqual([])
    expect(
      [...objects.keys()].filter((k) => k.startsWith('staging/40/')).length,
    ).toBe(4)
    expect(objects.has('0.2.2-canary-13ce444/release.json')).toBe(true)
  })

  test('prefixes are relative and end with /', async () => {
    await expect(stage(s3, buildOutput(), 'staging/5')).rejects.toThrow(
      /ends with \//,
    )
    await expect(clean(s3, '/staging/')).rejects.toThrow(/relative/)
    await expect(clean(s3, 'staging/../')).rejects.toThrow(/relative/)
  })
})

describe('the CLI, as release.yml runs it', () => {
  test('stage then fetch exits 0 with the same bytes; a corrupted file makes fetch exit 1', async () => {
    const src = buildOutput()
    const dest = mkdtempSync(join(tmpRoot, 'r2-test-'))
    const staged = await cli('stage', src, 'staging/6/mirab-linux-x64/')
    expect(staged.code).toBe(0)
    const fetched = await cli('fetch', 'staging/6/mirab-linux-x64/', dest)
    expect(fetched.code).toBe(0)
    expect(readFileSync(join(dest, 'linux-x64/vmlinux.gz'))).toEqual(
      readFileSync(join(src, 'linux-x64/vmlinux.gz')),
    )

    const key = 'staging/6/mirab-linux-x64/darwin-arm64/mirab-vz.gz'
    objects.set(key, new TextEncoder().encode('not the vz helper\n'))
    const refused = await cli(
      'fetch',
      'staging/6/mirab-linux-x64/',
      mkdtempSync(join(tmpRoot, 'r2-test-')),
    )
    expect(refused.code).toBe(1)
    expect(refused.out).toContain(
      "darwin-arm64/mirab-vz.gz doesn't match what was staged",
    )

    const cleaned = await cli('clean', 'staging/6/')
    expect(cleaned.code).toBe(0)
    expect(objects.size).toBe(0)
  })

  test('only the STAGING_ keys count: the release keys alone exit 1, naming what is missing', async () => {
    // What the publish job has at job level: the mirab-releases keys. They
    // must never be used to reach staging.
    const objectsBefore = objects.size
    const p = Bun.spawn(
      [
        'bun',
        join(import.meta.dir, 'r2.ts'),
        'stage',
        buildOutput(),
        'staging/7/',
      ],
      {
        env: {
          PATH: env.PATH,
          R2_ENDPOINT: env.STAGING_R2_ENDPOINT,
          AWS_ACCESS_KEY_ID: 'release',
          AWS_SECRET_ACCESS_KEY: 'release',
          R2_BUCKET_RELEASES: 'mirab-releases',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const err = await new Response(p.stderr).text()
    expect(await p.exited).toBe(1)
    expect(err).toContain("STAGING_AWS_ACCESS_KEY_ID isn't set")
    expect(objects.size).toBe(objectsBefore)
  })
})
