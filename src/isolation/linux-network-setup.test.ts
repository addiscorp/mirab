import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  linuxNetworkFiles,
  NFT_FILE,
  removeLinuxNetwork,
  setupLinuxNetwork,
  UNIT_FILE,
  UNIT_NAME,
  UP_SCRIPT,
  type LinuxNetworkFile,
  type LinuxSetupSystem,
} from './linux-network-setup'

/** A Linux host that records what setup does to it, in order. */
function fakeLinux(
  opts: {
    root?: boolean
    platform?: NodeJS.Platform
    users?: string[]
    missing?: string[]
    nftCheckFails?: boolean
    nixos?: boolean
  } = {},
) {
  const events: string[] = []
  const files = new Map<string, LinuxNetworkFile>()
  const sys: LinuxSetupSystem = {
    isRoot: () => opts.root ?? true,
    platform: opts.platform ?? 'linux',
    nixos: opts.nixos ?? false,
    userExists: (n) => (opts.users ?? ['woreda', 'sami']).includes(n),
    has: (c) => !(opts.missing ?? []).includes(c),
    run(argv) {
      events.push(`run ${argv.join(' ')}`)
      if (opts.nftCheckFails && argv[0] === 'nft' && argv[1] === '-c')
        throw new Error('nft: syntax error')
    },
    install(file) {
      events.push(`install ${file.path}`)
      files.set(file.path, file)
    },
    remove(path) {
      events.push(`remove ${path}`)
      files.delete(path)
    },
  }
  return { sys, events, files }
}
const quiet = () => {}

describe('the files setup writes', () => {
  const files = linuxNetworkFiles({ user: 'woreda', slots: 4 })
  const byPath = (p: string) => files.find((f) => f.path === p)!.content

  test('rules deny the host, the LAN, the tailnet, link-local and IPv6; masquerade the rest', () => {
    const nft = byPath(NFT_FILE)
    for (const net of [
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '100.64.0.0/10',
      '169.254.0.0/16',
      '127.0.0.0/8',
    ])
      expect(nft).toContain(net)
    expect(nft).toMatch(
      /chain input \{[^}]*iifname \{ "mirabbr0", "mirabbr1" \} drop/s,
    )
    expect(nft).toMatch(/meta nfproto ipv6 drop/)
    expect(nft).toMatch(/ip daddr @denied4 drop/)
    expect(nft).toMatch(/masquerade/)
  })

  test('up loads the rules before any bridge or tap exists, and the taps belong to the user, isolated', () => {
    const up = byPath(UP_SCRIPT)
    expect(up.indexOf(`nft -f ${NFT_FILE}`)).toBeLessThan(
      up.indexOf('ip link add mirabbr0'),
    )
    expect(up).toContain('ip tuntap add dev "$t" mode tap user woreda')
    expect(up).toContain('bridge link set dev "$t" isolated on')
    expect(up).toContain('while [ $i -lt 4 ]')
  })

  test('the generated script is valid sh', () => {
    const dir = mkdtempSync(join(resolve('.tmp'), 'netsetup-'))
    const f = join(dir, 'up.sh')
    writeFileSync(f, byPath(UP_SCRIPT))
    expect(spawnSync('sh', ['-n', f]).status).toBe(0)
  })

  test('the boot unit runs only the root-owned generated script, never a path in a checkout', () => {
    const unit = byPath(UNIT_FILE)
    expect(/^ExecStart=(\S+)/m.exec(unit)![1]).toBe(UP_SCRIPT)
    expect(UP_SCRIPT.startsWith('/usr/local/libexec/')).toBe(true)
    expect(unit).not.toContain(resolve('.'))
    expect(files.find((f) => f.path === UP_SCRIPT)!.mode).toBe(0o755)
  })

  test('a user name the script cannot carry safely, root, or a silly slot count are refused', () => {
    expect(() => linuxNetworkFiles({ user: 'a;rm -rf /', slots: 4 })).toThrow(
      /--user/,
    )
    expect(() => linuxNetworkFiles({ user: 'root', slots: 4 })).toThrow(
      /--user/,
    )
    expect(() => linuxNetworkFiles({ user: 'woreda', slots: 0 })).toThrow(
      /--slots/,
    )
    expect(() => linuxNetworkFiles({ user: 'woreda', slots: 1000 })).toThrow(
      /--slots/,
    )
  })
})

describe('sudo mirab vm network setup', () => {
  test('writes the files, checks the rules, then enables and (re)starts the unit', () => {
    const { sys, events, files } = fakeLinux()
    setupLinuxNetwork({ user: 'woreda', slots: 8, log: quiet }, sys)
    expect([...files.keys()]).toContain(NFT_FILE)
    expect(events.filter((e) => e.startsWith('run'))).toEqual([
      `run nft -c -f ${NFT_FILE}`,
      'run systemctl daemon-reload',
      `run systemctl enable ${UNIT_NAME}`,
      `run systemctl restart ${UNIT_NAME}`,
    ])
    // every file is written before anything runs
    expect(events.findIndex((e) => e.startsWith('run'))).toBeGreaterThan(
      events.map((e) => e.startsWith('install')).lastIndexOf(true),
    )
  })

  test('a rule set nft rejects never brings the network up', () => {
    const { sys, events } = fakeLinux({ nftCheckFails: true })
    expect(() =>
      setupLinuxNetwork({ user: 'woreda', log: quiet }, sys),
    ).toThrow(/syntax error/)
    expect(
      events.some(
        (e) => e.includes('systemctl restart') || e.includes('enable'),
      ),
    ).toBe(false)
  })

  test('the user defaults to the one running sudo', () => {
    const { sys, files } = fakeLinux()
    const before = process.env.SUDO_USER
    process.env.SUDO_USER = 'sami'
    try {
      setupLinuxNetwork({ log: quiet }, sys)
    } finally {
      if (before === undefined) delete process.env.SUDO_USER
      else process.env.SUDO_USER = before
    }
    expect(files.get(UP_SCRIPT)!.content).toContain('mode tap user sami')
  })

  test('refuses without root, off Linux, on NixOS, for a missing user, or without iproute2/nftables, before touching anything', () => {
    for (const [o, msg] of [
      [{ root: false }, /run with sudo/],
      [{ platform: 'darwin' }, /Linux/],
      [{ users: [] as string[] }, /no user woreda/],
      [{ missing: ['nft'] }, /missing nft/],
      [{ nixos: true }, /NixOS module/],
    ] as [Parameters<typeof fakeLinux>[0], RegExp][]) {
      const { sys, events } = fakeLinux(o)
      expect(() =>
        setupLinuxNetwork({ user: 'woreda', log: quiet }, sys),
      ).toThrow(msg)
      expect(events).toEqual([])
    }
  })

  test('--dry-run prints every file and step and changes nothing', () => {
    const { sys, events } = fakeLinux({ root: false })
    const lines: string[] = []
    setupLinuxNetwork(
      { user: 'woreda', dryRun: true, log: (l) => lines.push(l) },
      sys,
    )
    expect(events).toEqual([])
    const out = lines.join('\n')
    expect(out).toContain(`--- ${NFT_FILE}`)
    expect(out).toContain(`+ systemctl enable ${UNIT_NAME}`)
    expect(out).toContain('would install')
  })
})

describe('sudo mirab vm network remove', () => {
  test('stops the unit and takes the devices down before deleting the files', () => {
    const { sys, events } = fakeLinux()
    removeLinuxNetwork({ log: quiet }, sys)
    const down = events.indexOf(`run ${UP_SCRIPT} down`)
    expect(
      events.indexOf(`run systemctl disable --now ${UNIT_NAME}`),
    ).toBeLessThan(down)
    expect(down).toBeLessThan(events.indexOf(`remove ${UP_SCRIPT}`))
  })
})
