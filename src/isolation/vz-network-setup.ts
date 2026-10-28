// `sudo mirab vm network setup`: the one-time owner step that gives macOS `vz`
// guests filtered egress, from the released binary instead of a loose script.
//
// VZ NAT (vmnet shared mode) puts guests on a host bridge (192.168.64.0/24 by
// default) and NATs them out of the Mac, which also reaches the Mac itself,
// its LAN, the tailnet and link-local. Only pf (root) can deny that. Setup:
//   1. writes the pf anchor: guests may use the vmnet DNS forwarder on the
//      gateway and DHCP, and nothing else in 10/8, 172.16/12, 192.168/16,
//      100.64/10, 169.254/16, 127/8 or multicast; the internet passes;
//   2. checks it with `pfctl -n` before anything loads it;
//   3. loads it under com.apple/mirab-vz (stock pf.conf already evaluates
//      anchor "com.apple/*", so pf.conf is not edited) from a LaunchDaemon
//      that runs only /sbin/pfctl, so it survives reboots;
//   4. writes the root-owned marker vzNetworkState reads (never pfctl) to
//      decide that a VM may get a NAT device.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  chownSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { VZ_LAN_DENIED, VZ_NETWORK_MARKER } from './vz'

export const VZ_ANCHOR = 'com.apple/mirab-vz'
export const VZ_ANCHOR_FILE = '/etc/pf.anchors/mirab-vz'
export const VZ_DAEMON_LABEL = 'gg.mirab.vz-net'
export const VZ_DAEMON_PLIST = `/Library/LaunchDaemons/${VZ_DAEMON_LABEL}.plist`
const VMNET_PLIST =
  '/Library/Preferences/SystemConfiguration/com.apple.vmnet.plist'

/** Everything a guest must never reach through VZ NAT. */
export const DENIED_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10', // the tailnet
  '169.254.0.0/16',
  '127.0.0.0/8',
  '224.0.0.0/4',
]

export interface VmnetNetwork {
  gateway: string
  subnet: string
}

/** 255.255.255.0 → 24. Refuses a mask that isn't contiguous ones then zeros. */
export function maskPrefix(mask: string): number {
  const octets = mask.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
  )
    throw new Error(`not a netmask: ${mask}`)
  const bits = octets.map((o) => o.toString(2).padStart(8, '0')).join('')
  if (!/^1*0*$/.test(bits)) throw new Error(`not a contiguous netmask: ${mask}`)
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0')
}

export interface VzNetworkFile {
  path: string
  mode: number
  content: string
}

/** The three files setup writes, in the order it writes them. */
export function vzNetworkFiles(net: VmnetNetwork): VzNetworkFile[] {
  const { gateway: gw, subnet } = net
  return [
    {
      path: VZ_ANCHOR_FILE,
      mode: 0o644,
      content: `# mirab vz guests (vmnet shared network ${subnet}): internet yes, LAN/host/metadata no.
pass in quick inet proto { tcp udp } from ${subnet} to ${gw} port 53
pass in quick inet proto udp from any port 68 to any port 67
block drop in quick inet from ${subnet} to { ${DENIED_RANGES.join(' ')} }
`,
    },
    {
      path: VZ_DAEMON_PLIST,
      mode: 0o644,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${VZ_DAEMON_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>/sbin/pfctl</string><string>-E</string>
    <string>-a</string><string>${VZ_ANCHOR}</string>
    <string>-f</string><string>${VZ_ANCHOR_FILE}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`,
    },
    {
      path: VZ_NETWORK_MARKER,
      mode: 0o644,
      content:
        JSON.stringify({
          version: 1,
          network: VZ_LAN_DENIED,
          gateway: gw,
          subnet,
          anchor: VZ_ANCHOR,
        }) + '\n',
    },
  ]
}

/** What setup and remove touch on the machine; tests pass their own. */
export interface VzSetupSystem {
  isRoot(): boolean
  platform: NodeJS.Platform
  /** vmnet's configured shared network, if the owner changed it. */
  readDefault(key: 'Shared_Net_Address' | 'Shared_Net_Mask'): string | undefined
  /** Runs a command; throws when it fails. */
  run(argv: string[]): void
  /** Exit status of a command, for checks that may fail. */
  succeeds(argv: string[]): boolean
  /** Atomically installs a root:wheel file with this mode. */
  install(file: VzNetworkFile): void
  remove(path: string): void
}

export const realVzSystem: VzSetupSystem = {
  isRoot: () => process.getuid?.() === 0,
  platform: process.platform,
  readDefault(key) {
    try {
      return execFileSync('/usr/bin/defaults', ['read', VMNET_PLIST, key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return undefined
    }
  },
  run(argv) {
    execFileSync(argv[0]!, argv.slice(1), { stdio: 'inherit' })
  },
  succeeds(argv) {
    try {
      execFileSync(argv[0]!, argv.slice(1), { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },
  install({ path, mode, content }) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
    const tmp = `${path}.new`
    writeFileSync(tmp, content, { mode })
    chmodSync(tmp, mode)
    chownSync(tmp, 0, 0)
    renameSync(tmp, path)
  },
  remove(path) {
    rmSync(path, { force: true })
  },
}

export function vmnetNetwork(sys: VzSetupSystem): VmnetNetwork {
  const gateway = sys.readDefault('Shared_Net_Address') ?? '192.168.64.1'
  const mask = sys.readDefault('Shared_Net_Mask') ?? '255.255.255.0'
  return { gateway, subnet: `${gateway}/${maskPrefix(mask)}` }
}

function precheck(sys: VzSetupSystem, dryRun: boolean, verb: string) {
  if (sys.platform !== 'darwin')
    throw new Error(
      'mirab vm network is for macOS vz guests; Firecracker hosts are set up separately',
    )
  if (!dryRun && !sys.isRoot())
    throw new Error(
      `run with sudo: sudo ~/.mirab/bin/mirab vm network ${verb} (or add --dry-run to see what it does)`,
    )
}

const loaded = (sys: VzSetupSystem) =>
  sys.succeeds(['/bin/launchctl', 'print', `system/${VZ_DAEMON_LABEL}`])

/** Installs the filter, or prints what it would do. Safe to run again. */
export function setupVzNetwork(
  opts: { dryRun?: boolean; log?: (line: string) => void },
  sys: VzSetupSystem = realVzSystem,
) {
  const dryRun = !!opts.dryRun
  const log = opts.log ?? console.log
  precheck(sys, dryRun, 'setup')
  const net = vmnetNetwork(sys)
  const [anchor, daemon, marker] = vzNetworkFiles(net)
  const step = (what: string, act: () => void) =>
    dryRun ? log(`+ ${what}`) : act()
  const write = (f: VzNetworkFile) => {
    if (dryRun) log(`--- ${f.path} (${f.mode.toString(8)})\n${f.content}`)
    else sys.install(f)
  }

  write(anchor!)
  // A broken anchor must never reach the running firewall.
  step(`pfctl -n -a ${VZ_ANCHOR} -f ${VZ_ANCHOR_FILE}`, () =>
    sys.run(['/sbin/pfctl', '-n', '-a', VZ_ANCHOR, '-f', VZ_ANCHOR_FILE]),
  )
  write(daemon!)
  if (!dryRun && loaded(sys))
    // Already installed: rerun the daemon so the new anchor is loaded now.
    sys.run(['/bin/launchctl', 'kickstart', '-k', `system/${VZ_DAEMON_LABEL}`])
  else
    step(`launchctl bootstrap system ${VZ_DAEMON_PLIST}`, () =>
      sys.run(['/bin/launchctl', 'bootstrap', 'system', VZ_DAEMON_PLIST]),
    )
  // Last: mirab trusts the marker, so it appears only once the filter is live.
  write(marker!)
  log(
    `${dryRun ? 'would install' : 'installed'}: mirab vz network filter (anchor ${VZ_ANCHOR}, guests on ${net.subnet}). Check with: mirab vm network status`,
  )
}

/** Undoes setup: the marker first, so no VM is offered NAT without the filter. */
export function removeVzNetwork(
  opts: { dryRun?: boolean; log?: (line: string) => void },
  sys: VzSetupSystem = realVzSystem,
) {
  const dryRun = !!opts.dryRun
  const log = opts.log ?? console.log
  precheck(sys, dryRun, 'remove')
  const step = (what: string, act: () => void) =>
    dryRun ? log(`+ ${what}`) : act()
  step(`rm ${VZ_NETWORK_MARKER}`, () => sys.remove(VZ_NETWORK_MARKER))
  if (dryRun) log(`+ launchctl bootout system/${VZ_DAEMON_LABEL}`)
  else if (loaded(sys))
    sys.run(['/bin/launchctl', 'bootout', `system/${VZ_DAEMON_LABEL}`])
  step(`pfctl -a ${VZ_ANCHOR} -F all`, () =>
    sys.succeeds(['/sbin/pfctl', '-a', VZ_ANCHOR, '-F', 'all']),
  )
  step(`rm ${VZ_DAEMON_PLIST} ${VZ_ANCHOR_FILE}`, () => {
    sys.remove(VZ_DAEMON_PLIST)
    sys.remove(VZ_ANCHOR_FILE)
  })
  log(
    `${dryRun ? 'would remove' : 'removed'}: mirab vz network filter; vz VMs get no network until setup runs again`,
  )
}
