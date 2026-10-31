// `sudo mirab vm network setup --user <name>` on Linux: the one-time owner
// step that gives Firecracker guests filtered egress, from the released binary
// instead of a loose script (the macOS twin is vz-network-setup.ts).
//
// Setup writes three root-owned files whose content this binary generates
// (nothing comes from a user-writable checkout), then runs them:
//   1. /etc/mirab/vm-network.nft: table `inet mirab_vm`. Guests reach the
//      internet; never the host, 10/8, 172.16/12, 192.168/16, the tailnet
//      (100.64/10), link-local (169.254/16, the metadata address), 127/8,
//      multicast, IPv6, or each other. Loaded before any bridge or tap exists,
//      so a broken rule set never leaves a device to leak through.
//   2. /usr/local/libexec/mirab-vm-network: `up` / `down` with plain ip, nft
//      and sysctl calls: bridge mirabbr0 (172.31.250.1/24), N isolated taps
//      owned by <user>, and Docker's mirab-egress network when Docker is there.
//   3. /etc/systemd/system/mirab-vm-network.service: runs `up` at boot.
// The taps belong to one user: the one whose VMs use them (woreda's service
// user, or a person running `mirab spawn --vm`). networkState reads them.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { BRIDGE } from './network'

export const NFT_FILE = '/etc/mirab/vm-network.nft'
export const UP_SCRIPT = '/usr/local/libexec/mirab-vm-network'
export const UNIT_NAME = 'mirab-vm-network.service'
export const UNIT_FILE = `/etc/systemd/system/${UNIT_NAME}`
export const SYSCTL_FILE = '/etc/sysctl.d/90-mirab-vm.conf'
export const DEFAULT_SLOTS = 16

/** Everything a guest must never reach. */
export const DENIED4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10', // the tailnet
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local, the cloud metadata address
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
]

export interface LinuxNetworkFile {
  path: string
  mode: number
  content: string
}

export interface LinuxNetworkPlan {
  user: string
  slots: number
}

/** A user name the generated script can carry without quoting games. */
const USER = /^[a-z_][a-z0-9_-]{0,31}$/

export function checkPlan(p: LinuxNetworkPlan) {
  if (!USER.test(p.user) || p.user === 'root')
    throw new Error(
      `--user ${p.user}: give the (non-root) user whose VMs use the network, e.g. --user woreda`,
    )
  if (!Number.isInteger(p.slots) || p.slots < 1 || p.slots > 256)
    throw new Error(`--slots ${p.slots}: a whole number from 1 to 256`)
}

/** The files setup writes, in the order it writes them. */
export function linuxNetworkFiles(p: LinuxNetworkPlan): LinuxNetworkFile[] {
  checkPlan(p)
  const bridges = `{ "${BRIDGE}", "mirabbr1" }`
  return [
    {
      path: SYSCTL_FILE,
      mode: 0o644,
      content: 'net.ipv4.ip_forward=1\n',
    },
    {
      path: NFT_FILE,
      mode: 0o644,
      content: `# mirab microVMs and containers: internet yes; host, LAN, tailnet, metadata and each other no.
table inet mirab_vm {
  set denied4 {
    type ipv4_addr
    flags interval
    elements = { ${DENIED4.join(', ')} }
  }
  # Guests never reach the host itself (no DNS, no services, no ICMP).
  chain input {
    type filter hook input priority -10; policy accept;
    iifname ${bridges} drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname ${bridges} meta nfproto ipv6 drop
    iifname ${bridges} ip daddr @denied4 drop
    oifname ${bridges} ct state established,related accept
    oifname ${bridges} drop
  }
  chain postrouting {
    type nat hook postrouting priority 100; policy accept;
    iifname ${bridges} oifname != ${bridges} masquerade
  }
}
`,
    },
    {
      path: UP_SCRIPT,
      mode: 0o755,
      content: `#!/bin/sh
# Written by \`mirab vm network setup\` (do not edit; rerun setup instead).
# up: rules first, then mirabbr0 and ${p.slots} isolated taps owned by ${p.user}. down: all of it gone.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
case "\${1:-up}" in
up)
  sysctl -qw net.ipv4.ip_forward=1
  nft delete table inet mirab_vm 2>/dev/null || true
  nft -f ${NFT_FILE}
  ip link show ${BRIDGE} >/dev/null 2>&1 || ip link add ${BRIDGE} type bridge
  ip addr replace 172.31.250.1/24 dev ${BRIDGE}
  ip link set ${BRIDGE} up
  i=0
  while [ $i -lt ${p.slots} ]; do
    t=mirabtap$i
    # A tap left by another owner is recreated for ${p.user}.
    if ip link show "$t" >/dev/null 2>&1 && [ "$(cat /sys/class/net/$t/owner 2>/dev/null)" != "$(id -u ${p.user})" ]; then ip link del "$t"; fi
    ip link show "$t" >/dev/null 2>&1 || ip tuntap add dev "$t" mode tap user ${p.user}
    ip link set "$t" master ${BRIDGE}
    bridge link set dev "$t" isolated on
    ip link set "$t" up
    i=$((i + 1))
  done
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker network inspect mirab-egress >/dev/null 2>&1 || docker network create --driver bridge \\
      --subnet 172.31.249.0/24 -o com.docker.network.bridge.name=mirabbr1 \\
      -o com.docker.network.bridge.enable_icc=false mirab-egress >/dev/null
  fi
  # Docker's FORWARD policy is DROP: let the VM bridge through (the nft drops
  # above still win; they run first and a drop is final).
  if command -v iptables >/dev/null 2>&1 && iptables -n -L DOCKER-USER >/dev/null 2>&1; then
    iptables -C DOCKER-USER -i ${BRIDGE} -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -i ${BRIDGE} -j ACCEPT
    iptables -C DOCKER-USER -o ${BRIDGE} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null ||
      iptables -I DOCKER-USER -o ${BRIDGE} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  fi
  ;;
down)
  nft delete table inet mirab_vm 2>/dev/null || true
  if command -v iptables >/dev/null 2>&1; then
    iptables -D DOCKER-USER -i ${BRIDGE} -j ACCEPT 2>/dev/null || true
    iptables -D DOCKER-USER -o ${BRIDGE} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
  fi
  for t in /sys/class/net/mirabtap*; do [ -e "$t" ] && ip link del "\${t##*/}"; done
  ip link del ${BRIDGE} 2>/dev/null || true
  if command -v docker >/dev/null 2>&1; then docker network rm mirab-egress >/dev/null 2>&1 || true; fi
  ;;
*) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
`,
    },
    {
      path: UNIT_FILE,
      mode: 0o644,
      content: `[Unit]
Description=mirab microVM network (bridge ${BRIDGE}, ${p.slots} taps for ${p.user}, filtered egress)
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${UP_SCRIPT} up
ExecStop=${UP_SCRIPT} down
[Install]
WantedBy=multi-user.target
`,
    },
  ]
}

/** What setup and remove touch on the machine; tests pass their own. */
export interface LinuxSetupSystem {
  isRoot(): boolean
  platform: NodeJS.Platform
  /** NixOS: /etc is generated from the system configuration (read-only). */
  nixos: boolean
  /** Whether a user exists (setup refuses a typo). */
  userExists(name: string): boolean
  /** A command on PATH, for the prerequisites check. */
  has(command: string): boolean
  /** Runs a command; throws when it fails. */
  run(argv: string[]): void
  /** Atomically installs a root:root file with this mode. */
  install(file: LinuxNetworkFile): void
  remove(path: string): void
}

export const realLinuxSystem: LinuxSetupSystem = {
  isRoot: () => process.getuid?.() === 0,
  platform: process.platform,
  nixos: existsSync('/etc/NIXOS'),
  userExists(name) {
    try {
      execFileSync('id', ['-u', name], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },
  has(command) {
    try {
      execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },
  run(argv) {
    execFileSync(argv[0]!, argv.slice(1), { stdio: 'inherit' })
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

function precheck(sys: LinuxSetupSystem, dryRun: boolean, verb: string) {
  if (sys.platform !== 'linux')
    throw new Error('this is the Linux (Firecracker) network setup')
  if (sys.nixos)
    throw new Error(
      'on NixOS, /etc comes from your configuration: enable the network declaratively with the mirab NixOS module (services.mirab-vm-network) instead',
    )
  if (!dryRun && !sys.isRoot())
    throw new Error(
      `run with sudo: sudo mirab vm network ${verb}${verb === 'setup' ? ' --user <name>' : ''} (or add --dry-run to see what it does)`,
    )
}

/** Installs the network for `user`'s VMs, or prints what it would do. Safe to run again. */
export function setupLinuxNetwork(
  opts: {
    user?: string
    slots?: number
    dryRun?: boolean
    log?: (line: string) => void
  },
  sys: LinuxSetupSystem = realLinuxSystem,
) {
  const dryRun = !!opts.dryRun
  const log = opts.log ?? console.log
  precheck(sys, dryRun, 'setup')
  const user = opts.user ?? process.env.SUDO_USER
  if (!user)
    throw new Error(
      'give the user whose VMs use the network: sudo mirab vm network setup --user <name>',
    )
  const plan = { user, slots: opts.slots ?? DEFAULT_SLOTS }
  checkPlan(plan)
  if (!sys.userExists(user))
    throw new Error(`no user ${user} on this machine (create it first)`)
  const missing = ['ip', 'nft', 'bridge', 'systemctl'].filter(
    (c) => !sys.has(c),
  )
  if (missing.length)
    throw new Error(
      `missing ${missing.join(', ')}: install iproute2 and nftables (systemd is required)`,
    )
  const files = linuxNetworkFiles(plan)
  const step = (what: string, act: () => void) =>
    dryRun ? log(`+ ${what}`) : act()
  for (const f of files) {
    if (dryRun) log(`--- ${f.path} (${f.mode.toString(8)})\n${f.content}`)
    else sys.install(f)
  }
  // A broken rule set must never be half-applied: check it before `up` loads it.
  step(`nft -c -f ${NFT_FILE}`, () => sys.run(['nft', '-c', '-f', NFT_FILE]))
  step('systemctl daemon-reload', () => sys.run(['systemctl', 'daemon-reload']))
  // restart, not start: a rerun (new user, more slots) applies now.
  step(
    `systemctl enable ${UNIT_NAME} && systemctl restart ${UNIT_NAME}`,
    () => {
      sys.run(['systemctl', 'enable', UNIT_NAME])
      sys.run(['systemctl', 'restart', UNIT_NAME])
    },
  )
  log(
    `${dryRun ? 'would install' : 'installed'}: mirab VM network (${plan.slots} taps for ${user}, filtered egress), kept across reboots by ${UNIT_NAME}. Check with: mirab vm network status`,
  )
}

/** Undoes setup: the devices and rules first, then the files. */
export function removeLinuxNetwork(
  opts: { dryRun?: boolean; log?: (line: string) => void },
  sys: LinuxSetupSystem = realLinuxSystem,
) {
  const dryRun = !!opts.dryRun
  const log = opts.log ?? console.log
  precheck(sys, dryRun, 'remove')
  const step = (what: string, act: () => void) =>
    dryRun ? log(`+ ${what}`) : act()
  step(`systemctl disable --now ${UNIT_NAME}`, () => {
    try {
      sys.run(['systemctl', 'disable', '--now', UNIT_NAME])
    } catch {
      // never installed, or already stopped
    }
  })
  step(`${UP_SCRIPT} down`, () => {
    try {
      sys.run([UP_SCRIPT, 'down'])
    } catch {
      // the script is gone already
    }
  })
  step(`rm ${UNIT_FILE} ${UP_SCRIPT} ${NFT_FILE} ${SYSCTL_FILE}`, () => {
    for (const f of [UNIT_FILE, UP_SCRIPT, NFT_FILE, SYSCTL_FILE]) sys.remove(f)
  })
  step('systemctl daemon-reload', () => sys.run(['systemctl', 'daemon-reload']))
  log(
    `${dryRun ? 'would remove' : 'removed'}: mirab VM network; VMs get no network until setup runs again`,
  )
}
