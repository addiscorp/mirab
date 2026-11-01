// Toolsets baked into a runner image: versions resolved on the host (so the
// image key names exact versions), archives checked in the build VM against
// the upstream checksum. Laid out the way GitHub's hosted images do
// (<tool cache>/<tool>/<version>/<arch>/ plus a sibling <arch>.complete), so
// actions/setup-node and setup-go find them and skip their download.
import { createHash } from 'node:crypto'
import { AWS_CLI_KEY, AWS_CLI_KEY_FINGERPRINT } from './aws-key'
import type { RunnerPlatform, RunnerStep } from './define'

export const TOOL_CACHE = '/opt/hostedtoolcache'
export const RUST_HOME = '/opt/rust'

export interface ResolvedTool {
  tool: 'rust' | 'node' | 'go' | 'aws'
  version: string
  url: string
  /** The archive's sha256; for aws, the sha256 of its detached signature
   *  (the signature itself is checked against AWS's key in the build VM). */
  sha256: string
  /** Hosts the build VM fetches from. */
  hosts: string[]
}

export type Fetcher = (url: string) => Promise<string>

const defaultFetch: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

const SHA256 = /^[0-9a-f]{64}$/

/** `24` matches 24.x.y, `24.21` matches 24.21.y, `24.21.0` only itself. */
export function versionMatches(spec: string, version: string): boolean {
  return version === spec || version.startsWith(spec + '.')
}

const arm = (p: RunnerPlatform) => p.endsWith('-arm64')
const os = (p: RunnerPlatform) => (p.startsWith('darwin-') ? 'darwin' : 'linux')
const nodeArch = (p: RunnerPlatform) => (arm(p) ? 'arm64' : 'x64')
const goArch = (p: RunnerPlatform) => (arm(p) ? 'arm64' : 'amd64')
const rustTriple = (p: RunnerPlatform) =>
  p === 'darwin-arm64'
    ? 'aarch64-apple-darwin'
    : arm(p)
      ? 'aarch64-unknown-linux-gnu'
      : 'x86_64-unknown-linux-gnu'
/** The tool cache's arch directory (setup-node and setup-go use these). */
export const cacheArch = nodeArch

export async function resolveNode(
  spec: string,
  platform: RunnerPlatform,
  get: Fetcher = defaultFetch,
): Promise<ResolvedTool> {
  const index = JSON.parse(await get('https://nodejs.org/dist/index.json')) as {
    version: string
  }[]
  const hit = index.find((r) =>
    versionMatches(spec, r.version.replace(/^v/, '')),
  )
  if (!hit) throw new Error(`node ${spec}: no such release`)
  const version = hit.version.replace(/^v/, '')
  const file = `node-v${version}-${os(platform)}-${nodeArch(platform)}.tar.xz`
  const sums = await get(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)
  const sha256 = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, f]) => f === file)?.[0]
  if (!sha256 || !SHA256.test(sha256))
    throw new Error(`node ${version}: no checksum for ${file}`)
  return {
    tool: 'node',
    version,
    url: `https://nodejs.org/dist/v${version}/${file}`,
    sha256,
    hosts: ['nodejs.org'],
  }
}

export async function resolveGo(
  spec: string,
  platform: RunnerPlatform,
  get: Fetcher = defaultFetch,
): Promise<ResolvedTool> {
  const releases = JSON.parse(
    await get('https://go.dev/dl/?mode=json&include=all'),
  ) as {
    version: string
    stable: boolean
    files: {
      filename: string
      os: string
      arch: string
      sha256: string
      kind: string
    }[]
  }[]
  const hit = releases.find(
    (r) => r.stable && versionMatches(spec, r.version.replace(/^go/, '')),
  )
  if (!hit) throw new Error(`go ${spec}: no such stable release`)
  const file = hit.files.find(
    (f) =>
      f.os === os(platform) &&
      f.arch === goArch(platform) &&
      f.kind === 'archive',
  )
  if (!file || !SHA256.test(file.sha256))
    throw new Error(
      `go ${hit.version}: no ${os(platform)}-${goArch(platform)} archive`,
    )
  return {
    tool: 'go',
    version: hit.version.replace(/^go/, ''),
    url: `https://dl.google.com/go/${file.filename}`,
    sha256: file.sha256,
    hosts: ['dl.google.com'],
  }
}

/** Rust: rustup-init (checked by its published sha256) installs the toolchain
 *  `spec`; rustup checks every component it downloads itself. */
export async function resolveRust(
  spec: string,
  platform: RunnerPlatform,
  get: Fetcher = defaultFetch,
): Promise<ResolvedTool> {
  const url = `https://static.rust-lang.org/rustup/dist/${rustTriple(platform)}/rustup-init`
  const sha256 = (await get(`${url}.sha256`)).trim().split(/\s+/)[0]
  if (!sha256 || !SHA256.test(sha256))
    throw new Error(`rustup-init: no checksum at ${url}.sha256`)
  return {
    tool: 'rust',
    version: spec,
    url,
    sha256,
    hosts: ['static.rust-lang.org'],
  }
}

/** AWS CLI v2: the newest release matching `spec`, from AWS's changelog. The
 *  build VM checks the zip's PGP signature against the AWS CLI team's key. */
export type ByteFetcher = (url: string) => Promise<Uint8Array>

const defaultFetchBytes: ByteFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** AWS CLI v2: the newest release matching `spec`, from AWS's changelog. The
 *  build VM checks the zip's (binary, detached) PGP signature against the AWS
 *  CLI team's key; the image key holds the signature's sha256. */
export async function resolveAws(
  spec: string,
  platform: RunnerPlatform,
  get: Fetcher = defaultFetch,
  getBytes: ByteFetcher = defaultFetchBytes,
): Promise<ResolvedTool> {
  if (os(platform) !== 'linux')
    throw new Error(
      `aws ${spec}: the aws toolset is for Linux images (AWS ships macOS as a .pkg)`,
    )
  const changelog = await get(
    'https://raw.githubusercontent.com/aws/aws-cli/v2/CHANGELOG.rst',
  )
  const version = [...changelog.matchAll(/^(2\.\d+\.\d+)\s*$/gm)]
    .map((m) => m[1]!)
    .find((v) => versionMatches(spec, v))
  if (!version) throw new Error(`aws ${spec}: no such AWS CLI v2 release`)
  const url = `https://awscli.amazonaws.com/awscli-exe-linux-${arm(platform) ? 'aarch64' : 'x86_64'}-${version}.zip`
  const sig = await getBytes(`${url}.sig`)
  // An OpenPGP packet (high bit set), not an error page.
  if (sig.length < 64 || !(sig[0]! & 0x80))
    throw new Error(`aws ${version}: no signature at ${url}.sig`)
  return {
    tool: 'aws',
    version,
    url,
    sha256: createHash('sha256').update(sig).digest('hex'),
    hosts: ['awscli.amazonaws.com'],
  }
}

export async function resolveTools(
  tools: { rust?: string; node?: string; go?: string; aws?: string },
  platform: RunnerPlatform,
  get: Fetcher = defaultFetch,
  getBytes: ByteFetcher = defaultFetchBytes,
): Promise<ResolvedTool[]> {
  const out: ResolvedTool[] = []
  if (tools.rust) out.push(await resolveRust(tools.rust, platform, get))
  if (tools.node) out.push(await resolveNode(tools.node, platform, get))
  if (tools.go) out.push(await resolveGo(tools.go, platform, get))
  if (tools.aws) out.push(await resolveAws(tools.aws, platform, get, getBytes))
  return out
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Download to the root disk (not tmpfs /tmp) and check the checksum first.
 *  macOS checks with shasum; it may not have sha256sum. */
const fetchChecked = (t: ResolvedTool, to: string, platform: RunnerPlatform) =>
  `curl -fsSL -o ${q(to)} ${q(t.url)} && echo ${q(`${t.sha256}  ${to}`)} | ${os(platform) === 'darwin' ? 'shasum -a 256 -c -' : 'sha256sum -c -'}`

/** The build steps (root, in the build VM) for the resolved toolsets. */
export function toolSteps(
  tools: ResolvedTool[],
  platform: RunnerPlatform,
): RunnerStep[] {
  const arch = cacheArch(platform)
  return tools.map((t) => {
    if (t.tool === 'aws')
      return {
        argv: [
          'sh',
          '-euc',
          [
            'd=/opt/aws-cli/dl',
            'mkdir -p "$d" "$d/gnupg"',
            'chmod 700 "$d/gnupg"',
            `curl -fsSL -o "$d/aws.zip" ${q(t.url)}`,
            `curl -fsSL -o "$d/aws.zip.sig" ${q(`${t.url}.sig`)}`,
            // The signature the host resolved, and no other.
            `echo ${q(`${t.sha256}  `)}"$d/aws.zip.sig" | sha256sum -c -`,
            `printf '%s' ${q(AWS_CLI_KEY)} > "$d/aws.asc"`,
            'gpg --batch --homedir "$d/gnupg" --import "$d/aws.asc" 2>/dev/null',
            // Install only on a good signature by exactly the AWS CLI team's key.
            `gpg --batch --homedir "$d/gnupg" --status-fd 1 --verify "$d/aws.zip.sig" "$d/aws.zip" 2>/dev/null | grep -qF '[GNUPG:] VALIDSIG ${AWS_CLI_KEY_FINGERPRINT} '`,
            'unzip -q "$d/aws.zip" -d "$d"',
            '"$d/aws/install" --install-dir /opt/aws-cli/v2 --bin-dir /usr/local/bin --update',
            'rm -rf "$d"',
            // Build steps run with a minimal PATH: name the installed binary.
            '/usr/local/bin/aws --version',
          ].join(' && '),
        ],
      }
    if (t.tool === 'rust')
      return {
        argv: [
          'sh',
          '-euc',
          [
            `mkdir -p ${RUST_HOME}/dl`,
            fetchChecked(t, `${RUST_HOME}/dl/rustup-init`, platform),
            `chmod 755 ${RUST_HOME}/dl/rustup-init`,
            `RUSTUP_HOME=${RUST_HOME}/rustup CARGO_HOME=${RUST_HOME}/cargo ${RUST_HOME}/dl/rustup-init -y --no-modify-path --profile minimal --default-toolchain ${q(t.version)} -c clippy -c rustfmt`,
            `rm -rf ${RUST_HOME}/dl`,
          ].join(' && '),
        ],
      }
    const dir = `${TOOL_CACHE}/${t.tool}/${t.version}/${arch}`
    const archive = `${TOOL_CACHE}/.dl-${t.tool}`
    return {
      argv: [
        'sh',
        '-euc',
        [
          `mkdir -p ${q(dir)}`,
          fetchChecked(t, archive, platform),
          `tar -xf ${q(archive)} -C ${q(dir)} --strip-components=1`,
          `rm -f ${q(archive)}`,
          `touch ${q(`${dir}.complete`)}`,
        ].join(' && '),
      ],
    }
  })
}

/** What a job's env needs to find the toolsets (merged into the base env). */
export function toolEnv(
  tools: ResolvedTool[],
  platform: RunnerPlatform,
): { env: Record<string, string>; path: string[] } {
  const arch = cacheArch(platform)
  const env: Record<string, string> = {
    RUNNER_TOOL_CACHE: TOOL_CACHE,
    AGENT_TOOLSDIRECTORY: TOOL_CACHE,
  }
  const path: string[] = []
  for (const t of tools) {
    if (t.tool === 'rust') {
      env.RUSTUP_HOME = `${RUST_HOME}/rustup`
      env.CARGO_HOME = `${RUST_HOME}/cargo`
      path.push(`${RUST_HOME}/cargo/bin`)
    } else if (t.tool !== 'aws')
      // aws installs itself to /usr/local/bin, already on PATH.
      path.push(`${TOOL_CACHE}/${t.tool}/${t.version}/${arch}/bin`)
  }
  return { env, path }
}
