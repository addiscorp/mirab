import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { AWS_CLI_KEY_FINGERPRINT } from './aws-key'
import {
  resolveAws,
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

test('macOS: node, rust and go resolve their darwin downloads, checked with shasum', async () => {
  const get = fake({
    'https://nodejs.org/dist/index.json': JSON.stringify([
      { version: 'v24.21.1' },
    ]),
    'https://nodejs.org/dist/v24.21.1/SHASUMS256.txt': `${B}  node-v24.21.1-linux-arm64.tar.xz\n${A}  node-v24.21.1-darwin-arm64.tar.xz\n`,
    'https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init.sha256': `${A}  rustup-init\n`,
  })
  const node = await resolveNode('24', 'darwin-arm64', get)
  expect(node.url).toBe(
    'https://nodejs.org/dist/v24.21.1/node-v24.21.1-darwin-arm64.tar.xz',
  )
  expect(node.sha256).toBe(A)
  const rust = await resolveRust('1.99.1', 'darwin-arm64', get)
  expect(rust.url).toBe(
    'https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init',
  )
  const steps = toolSteps([node, rust], 'darwin-arm64').map((s) =>
    s.argv.join(' '),
  )
  expect(steps.every((s) => s.includes('shasum -a 256 -c -'))).toBe(true)
  expect(steps.some((s) => s.includes('sha256sum'))).toBe(false)
  // Linux keeps sha256sum.
  expect(toolSteps([node], 'linux-arm64')[0]!.argv.join(' ')).toContain(
    'sha256sum -c -',
  )
})

/** A binary detached signature, the way AWS serves it (an OpenPGP packet). */
const SIG = new Uint8Array([0x89, ...Array.from({ length: 100 }, (_, i) => i)])
const bytes = (pages: Record<string, Uint8Array>) => async (url: string) => {
  if (!(url in pages)) throw new Error(`unexpected fetch ${url}`)
  return pages[url]!
}
const CHANGELOG = `=========\nCHANGELOG\n=========\n\n2.31.20\n=======\n\n* api-change: x\n\n2.31.19\n=======\n\n2.30.4\n======\n`

test("aws: the newest 2.x from AWS's changelog, this architecture's zip, keyed by its signature", async () => {
  const zip =
    'https://awscli.amazonaws.com/awscli-exe-linux-aarch64-2.31.20.zip'
  const get = fake({
    'https://raw.githubusercontent.com/aws/aws-cli/v2/CHANGELOG.rst': CHANGELOG,
  })
  const t = await resolveAws(
    '2',
    'linux-arm64',
    get,
    bytes({ [`${zip}.sig`]: SIG }),
  )
  expect(t).toMatchObject({
    tool: 'aws',
    version: '2.31.20',
    url: zip,
    hosts: ['awscli.amazonaws.com'],
  })
  expect(t.sha256).toBe(createHash('sha256').update(SIG).digest('hex'))
  const x64 = fake({
    'https://raw.githubusercontent.com/aws/aws-cli/v2/CHANGELOG.rst': CHANGELOG,
  })
  const sigs = bytes({
    'https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.30.4.zip.sig': SIG,
    'https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.31.20.zip.sig':
      new TextEncoder().encode('<html>Access Denied</html>'.repeat(5)),
  })
  expect((await resolveAws('2.30', 'linux-x64', x64, sigs)).url).toContain(
    'linux-x86_64-2.30.4.zip',
  )
  await expect(resolveAws('2.31', 'linux-x64', x64, sigs)).rejects.toThrow(
    /no signature/,
  )
  await expect(resolveAws('2.99', 'linux-x64', x64, sigs)).rejects.toThrow(
    /no such AWS CLI v2 release/,
  )
  await expect(resolveAws('2', 'darwin-arm64', get, sigs)).rejects.toThrow(
    /Linux images/,
  )
})

test('aws: installs only on a good signature by exactly the AWS CLI key, and adds nothing to PATH', async () => {
  const zip = 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.31.20.zip'
  const t = await resolveAws(
    '2',
    'linux-x64',
    fake({
      'https://raw.githubusercontent.com/aws/aws-cli/v2/CHANGELOG.rst':
        CHANGELOG,
    }),
    bytes({ [`${zip}.sig`]: SIG }),
  )
  const script = toolSteps([t], 'linux-x64')[0]!.argv.at(-1)!
  const verify = script.indexOf(`VALIDSIG ${AWS_CLI_KEY_FINGERPRINT} `)
  expect(verify).toBeGreaterThan(-1)
  // the signature is the one the host resolved; verified before anything is unpacked or installed
  expect(script.indexOf('sha256sum -c -')).toBeLessThan(verify)
  expect(verify).toBeLessThan(script.indexOf('unzip'))
  expect(script.indexOf('unzip')).toBeLessThan(script.indexOf('/aws/install'))
  // The check itself, through sh: only the AWS key's VALIDSIG line passes.
  const check = script.slice(script.indexOf('| grep') + 1).split(' && ')[0]!
  const run = (status: string) =>
    Bun.spawnSync(['sh', '-c', `printf '%s\\n' "$S" | ${check}`], {
      env: { ...process.env, S: status },
    }).exitCode
  expect(
    run(
      `[GNUPG:] GOODSIG A6310ACC4672475C AWS CLI Team\n[GNUPG:] VALIDSIG ${AWS_CLI_KEY_FINGERPRINT} 2026-10-30 1793383820 0 4 0 1 10 00 ${AWS_CLI_KEY_FINGERPRINT}`,
    ),
  ).toBe(0)
  expect(
    run(
      '[GNUPG:] VALIDSIG 0123456789ABCDEF0123456789ABCDEF01234567 2026-10-30 1 0 4 0 1 10 00 0123456789ABCDEF0123456789ABCDEF01234567',
    ),
  ).toBe(1)
  expect(run('[GNUPG:] BADSIG A6310ACC4672475C AWS CLI Team')).toBe(1)
  expect(script).toContain('BEGIN PGP PUBLIC KEY BLOCK')
  expect(toolEnv([t], 'linux-x64').path).toEqual([])
})
