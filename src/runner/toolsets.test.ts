import { expect, test } from 'bun:test'
import {
  resolveGo,
  resolveNode,
  resolveRust,
  toolEnv,
  toolSteps,
  versionMatches,
  type Fetcher,
} from './toolsets'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

const fake =
  (pages: Record<string, string>): Fetcher =>
  async (url) => {
    if (!(url in pages)) throw new Error(`unexpected fetch ${url}`)
    return pages[url]!
  }

test('a version spec matches whole components only', () => {
  expect(versionMatches('24', '24.21.0')).toBe(true)
  expect(versionMatches('2', '24.21.0')).toBe(false)
  expect(versionMatches('24.2', '24.21.0')).toBe(false)
  expect(versionMatches('24.21.0', '24.21.0')).toBe(true)
})

test('node: the newest release matching the spec, with its published checksum', async () => {
  const get = fake({
    'https://nodejs.org/dist/index.json': JSON.stringify([
      { version: 'v25.1.0' },
      { version: 'v24.21.1' },
      { version: 'v24.21.0' },
    ]),
    'https://nodejs.org/dist/v24.21.1/SHASUMS256.txt': `${B}  node-v24.21.1-linux-x64.tar.xz\n${A}  node-v24.21.1-linux-arm64.tar.xz\n`,
  })
  const t = await resolveNode('24', 'linux-arm64', get)
  expect(t).toEqual({
    tool: 'node',
    version: '24.21.1',
    url: 'https://nodejs.org/dist/v24.21.1/node-v24.21.1-linux-arm64.tar.xz',
    sha256: A,
    hosts: ['nodejs.org'],
  })
  await expect(resolveNode('23', 'linux-arm64', get)).rejects.toThrow(
    /no such release/,
  )
})

test('go: the newest stable release for the platform', async () => {
  const get = fake({
    'https://go.dev/dl/?mode=json&include=all': JSON.stringify([
      { version: 'go1.26rc1', stable: false, files: [] },
      {
        version: 'go1.25.3',
        stable: true,
        files: [
          {
            filename: 'go1.25.3.linux-arm64.tar.gz',
            os: 'linux',
            arch: 'arm64',
            sha256: A,
            kind: 'archive',
          },
          {
            filename: 'go1.25.3.linux-amd64.tar.gz',
            os: 'linux',
            arch: 'amd64',
            sha256: B,
            kind: 'archive',
          },
        ],
      },
    ]),
  })
  const t = await resolveGo('1.25', 'linux-x64', get)
  expect([t.version, t.url, t.sha256]).toEqual([
    '1.25.3',
    'https://dl.google.com/go/go1.25.3.linux-amd64.tar.gz',
    B,
  ])
})

test('rust: rustup-init by its published sha256; a missing checksum is refused', async () => {
  const url =
    'https://static.rust-lang.org/rustup/dist/aarch64-unknown-linux-gnu/rustup-init'
  const t = await resolveRust(
    '1.91.0',
    'linux-arm64',
    fake({ [`${url}.sha256`]: `${A}  ./rustup-init\n` }),
  )
  expect([t.version, t.url, t.sha256]).toEqual(['1.91.0', url, A])
  await expect(
    resolveRust('1.91.0', 'linux-arm64', fake({ [`${url}.sha256`]: 'nope' })),
  ).rejects.toThrow(/checksum/)
})

test('install steps check the checksum before unpacking, in the tool-cache layout', () => {
  const node = {
    tool: 'node' as const,
    version: '24.21.1',
    url: 'https://nodejs.org/x.tar.xz',
    sha256: A,
    hosts: [],
  }
  const [step] = toolSteps([node], 'linux-arm64')
  const script = step!.argv[2]!
  expect(step!.argv.slice(0, 2)).toEqual(['sh', '-euc'])
  const check = script.indexOf('sha256sum -c -')
  const unpack = script.indexOf('tar -xf')
  expect(check).toBeGreaterThan(0)
  expect(unpack).toBeGreaterThan(check)
  expect(script).toContain("'/opt/hostedtoolcache/node/24.21.1/arm64'")
  expect(script).toContain(
    "touch '/opt/hostedtoolcache/node/24.21.1/arm64.complete'",
  )
  const { env, path } = toolEnv([node], 'linux-arm64')
  expect(env.RUNNER_TOOL_CACHE).toBe('/opt/hostedtoolcache')
  expect(path).toEqual(['/opt/hostedtoolcache/node/24.21.1/arm64/bin'])
})
