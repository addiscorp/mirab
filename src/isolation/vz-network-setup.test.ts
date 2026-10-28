import { describe, expect, test } from 'bun:test'
import {
  maskPrefix,
  removeVzNetwork,
  setupVzNetwork,
  VZ_ANCHOR_FILE,
  VZ_DAEMON_PLIST,
  vzNetworkFiles,
  type VzNetworkFile,
  type VzSetupSystem,
} from './vz-network-setup'
import { VZ_LAN_DENIED, VZ_NETWORK_MARKER } from './vz'

/** A Mac that records what setup does to it, in order. */
function fakeMac(
  opts: {
    root?: boolean
    platform?: NodeJS.Platform
    loaded?: boolean
    pfctlCheckFails?: boolean
    defaults?: Record<string, string>
  } = {},
) {
  const events: string[] = []
  const files = new Map<string, VzNetworkFile>()
  const sys: VzSetupSystem = {
    isRoot: () => opts.root ?? true,
    platform: opts.platform ?? 'darwin',
    readDefault: (key) => opts.defaults?.[key],
    run(argv) {
      events.push(`run ${argv.join(' ')}`)
      if (opts.pfctlCheckFails && argv[0] === '/sbin/pfctl' && argv[1] === '-n')
        throw new Error('pfctl: syntax error')
    },
    succeeds(argv) {
      events.push(`check ${argv.join(' ')}`)
      return argv[1] === 'print' ? !!opts.loaded : true
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

describe('netmask → prefix', () => {
  test('common masks', () => {
    expect(maskPrefix('255.255.255.0')).toBe(24)
    expect(maskPrefix('255.255.0.0')).toBe(16)
    expect(maskPrefix('255.255.255.252')).toBe(30)
    expect(maskPrefix('255.255.255.255')).toBe(32)
  })
  test('a mask that is not contiguous ones is refused, not guessed', () => {
    expect(() => maskPrefix('255.0.255.0')).toThrow(/contiguous/)
    expect(() => maskPrefix('255.255.256.0')).toThrow(/netmask/)
  })
})

describe('mirab vm network setup', () => {
  test('installs the anchor, checks it, loads it, and writes the marker last', () => {
    const mac = fakeMac()
    setupVzNetwork({ log: quiet }, mac.sys)
    expect(mac.events).toEqual([
      `install ${VZ_ANCHOR_FILE}`,
      'run /sbin/pfctl -n -a com.apple/mirab-vz -f /etc/pf.anchors/mirab-vz',
      `install ${VZ_DAEMON_PLIST}`,
      'check /bin/launchctl print system/gg.mirab.vz-net',
      `run /bin/launchctl bootstrap system ${VZ_DAEMON_PLIST}`,
      `install ${VZ_NETWORK_MARKER}`,
    ])
  })

  test('the anchor denies the Mac, its LAN and the tailnet, on vmnet’s own subnet', () => {
    const mac = fakeMac({
      defaults: {
        Shared_Net_Address: '192.168.70.1',
        Shared_Net_Mask: '255.255.255.0',
      },
    })
    setupVzNetwork({ log: quiet }, mac.sys)
    const anchor = mac.files.get(VZ_ANCHOR_FILE)!.content
    expect(anchor).toContain(
      'pass in quick inet proto { tcp udp } from 192.168.70.1/24 to 192.168.70.1 port 53',
    )
    const block = anchor.split('\n').find((l) => l.startsWith('block'))!
    expect(block).toStartWith(
      'block drop in quick inet from 192.168.70.1/24 to {',
    )
    for (const range of [
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '100.64.0.0/10',
      '169.254.0.0/16',
      '127.0.0.0/8',
    ])
      expect(block).toContain(range)
  })

  test('the LaunchDaemon runs only /sbin/pfctl, never mirab', () => {
    const plist = vzNetworkFiles({
      gateway: '192.168.64.1',
      subnet: '192.168.64.1/24',
    })[1]!.content
    const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map(
      (m) => m[1],
    )
    expect(args[0]).toBe('gg.mirab.vz-net')
    expect(args[1]).toBe('/sbin/pfctl')
    expect(plist).not.toContain('mirab/bin')
  })

  test('the marker says what vzNetworkState trusts, and every file is root-only writable', () => {
    const files = vzNetworkFiles({
      gateway: '192.168.64.1',
      subnet: '192.168.64.1/24',
    })
    expect(JSON.parse(files[2]!.content).network).toBe(VZ_LAN_DENIED)
    for (const f of files) expect(f.mode & 0o022).toBe(0)
  })

  test('an anchor pfctl rejects is never loaded and no marker appears', () => {
    const mac = fakeMac({ pfctlCheckFails: true })
    expect(() => setupVzNetwork({ log: quiet }, mac.sys)).toThrow(/pfctl/)
    expect(mac.files.has(VZ_DAEMON_PLIST)).toBe(false)
    expect(mac.files.has(VZ_NETWORK_MARKER)).toBe(false)
    expect(mac.events.some((e) => e.includes('bootstrap'))).toBe(false)
  })

  test('running it again reloads the daemon instead of failing to bootstrap', () => {
    const mac = fakeMac({ loaded: true })
    setupVzNetwork({ log: quiet }, mac.sys)
    expect(mac.events).toContain(
      'run /bin/launchctl kickstart -k system/gg.mirab.vz-net',
    )
    expect(mac.events.some((e) => e.includes('bootstrap'))).toBe(false)
  })

  test('without root it changes nothing and says how to run it', () => {
    const mac = fakeMac({ root: false })
    expect(() => setupVzNetwork({ log: quiet }, mac.sys)).toThrow(
      /sudo ~\/.mirab\/bin\/mirab vm network setup/,
    )
    expect(mac.events).toEqual([])
  })

  test('--dry-run needs no root, touches nothing, and prints every file', () => {
    const mac = fakeMac({ root: false })
    const lines: string[] = []
    setupVzNetwork({ dryRun: true, log: (l) => lines.push(l) }, mac.sys)
    expect(mac.events).toEqual([])
    const out = lines.join('\n')
    for (const path of [VZ_ANCHOR_FILE, VZ_DAEMON_PLIST, VZ_NETWORK_MARKER])
      expect(out).toContain(`--- ${path} (644)`)
    expect(out).toContain('100.64.0.0/10')
  })

  test('off macOS it refuses', () => {
    const mac = fakeMac({ platform: 'linux' })
    expect(() => setupVzNetwork({ log: quiet }, mac.sys)).toThrow(/macOS/)
    expect(mac.events).toEqual([])
  })
})

describe('mirab vm network remove', () => {
  test('drops the marker before the filter, then every file', () => {
    const mac = fakeMac({ loaded: true })
    setupVzNetwork({ log: quiet }, mac.sys)
    mac.events.length = 0
    removeVzNetwork({ log: quiet }, mac.sys)
    expect(mac.events[0]).toBe(`remove ${VZ_NETWORK_MARKER}`)
    const bootout = mac.events.indexOf(
      'run /bin/launchctl bootout system/gg.mirab.vz-net',
    )
    expect(bootout).toBeGreaterThan(0)
    expect(mac.files.size).toBe(0)
  })

  test('without root it changes nothing', () => {
    const mac = fakeMac({ root: false })
    expect(() => removeVzNetwork({ log: quiet }, mac.sys)).toThrow(/sudo/)
    expect(mac.events).toEqual([])
  })
})
