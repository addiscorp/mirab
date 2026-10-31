// macOS backend: one Virtualization.framework microVM per job or agent,
// launched by the `mirab-vz` helper (vz/mirab-vz.swift, ad-hoc signed with the
// virtualization entitlement by scripts/build-vz-helper.sh).
//
// Same guest contract as Firecracker: the helper speaks Firecracker's vsock
// unix-socket protocol, so exec, put, pty, file listing and the hook relay are
// the shared vsockMembers. What differs:
// - the root disk is an APFS clone of the base image (copy-on-write, per VM);
// - the work directory is an APFS clone too, shared into the guest with
//   virtio-fs at /workspace, so the host checkout is never written and no
//   mke2fs is needed on the Mac;
// - networking is VZ NAT or nothing (see planVzNetwork).
import { execFileSync, spawn } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  readFileSync,
  statSync,
} from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  growDisk,
  vsockChannel,
  vsockMembers,
  type BootTimings,
  type VmStartOptions,
} from './firecracker'
import {
  checkGuestProtocol,
  guestPing,
  GuestProtocolError,
  type Isolation,
  type Opener,
} from './session'

export interface VzConfig {
  /** The signed mirab-vz helper. */
  helper: string
  /** Guest kernel with virtio-pci built in: the uncompressed arm64 `Image` on
   *  Apple silicon, a relocatable x86_64 `bzImage` on Intel Macs. */
  kernel: string
  /** Base ext4 image; each VM boots an APFS clone of it. For a macOS guest,
   *  the base macOS disk (`<macos>/disk.img`). */
  rootfs: string
  /** A macOS guest (Apple silicon): the base directory `mirab-vz
   *  macos-install` wrote (hardware-model, machine-id, aux.img, disk.img),
   *  provisioned with the guest agent. `kernel` is unused then. */
  macos?: string
  memoryMiB: number
  vcpus: number
  /** Guest vsock port the agent listens on. */
  port: number
  egress: 'auto' | 'block' | 'allow'
}

/** Guest -> host vsock ports the helper relays: the spawn --vm hook relay
 *  (9100) and the way out through the station (9101). */
export const GUEST_TO_HOST_PORTS = [9100, 9101]
/** The guest's loopback port for the way out, and the host vsock port it reaches. */
export const EGRESS_GUEST_PORT = 8790
export const EGRESS_HOST_PORT = 9101

export const VZ_NETWORK_MARKER = '/etc/mirab/vz-network.json'
export const VZ_SETUP_COMMAND = 'sudo ~/.mirab/bin/mirab vm network setup'
/** What the marker says once the pf anchor denies guests the LAN. */
export const VZ_LAN_DENIED = 'lan-denied'

/** This Mac can run Virtualization.framework guests (hosted CI Macs cannot). */
export function vzHostReady() {
  try {
    return (
      execFileSync('/usr/sbin/sysctl', ['-n', 'kern.hv_support'], {
        encoding: 'utf8',
      }).trim() === '1'
    )
  } catch {
    return false
  }
}

export function vzAvailable(
  c: Pick<VzConfig, 'helper' | 'kernel' | 'rootfs'>,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== 'darwin') return false
  try {
    accessSync(c.kernel, constants.R_OK)
    accessSync(c.rootfs, constants.R_OK)
    execFileSync(c.helper, ['check'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface VzNetworkState {
  /** The owner installed the pf anchor that denies VZ NAT guests the LAN. */
  filtered: boolean
  reason?: string
}

/** Reads the root-owned marker `mirab vm network setup` writes; never runs sudo or pfctl. */
export function vzNetworkState(marker = VZ_NETWORK_MARKER): VzNetworkState {
  try {
    const st = statSync(marker)
    if (st.uid !== 0 || st.mode & 0o022)
      return {
        filtered: false,
        reason: `${marker} is not root-owned and read-only`,
      }
    const m = JSON.parse(readFileSync(marker, 'utf8'))
    return m?.network === VZ_LAN_DENIED
      ? { filtered: true }
      : { filtered: false, reason: `${marker} does not say ${VZ_LAN_DENIED}` }
  } catch {
    return { filtered: false, reason: 'the vz pf anchor is not installed' }
  }
}

export interface VzNetworkPlan {
  net: 'none' | 'nat'
  note: string
}

/**
 * VZ NAT (vmnet shared mode) gives the guest the internet AND the Mac's LAN,
 * the Mac itself and the tailnet. Only a root pf anchor can deny those, so NAT
 * is used only when that anchor is installed; otherwise the VM has no network.
 */
export function planVzNetwork(
  egress: VzConfig['egress'],
  state: VzNetworkState,
): VzNetworkPlan {
  if (egress === 'block')
    return { net: 'none', note: 'vm network: none (egress: block)' }
  if (state.filtered)
    return {
      net: 'nat',
      note: 'vm network: VZ NAT, egress allowed, LAN/host/metadata denied by the mirab-vz pf anchor',
    }
  if (egress === 'allow')
    throw new Error(
      `egress: allow needs the vz network filter (${state.reason}). set it up with: ${VZ_SETUP_COMMAND}`,
    )
  return {
    net: 'none',
    note: `vm network: none (${state.reason}; VZ NAT would reach the LAN; for filtered egress: ${VZ_SETUP_COMMAND})`,
  }
}

export function vzNetworkStatusLine(
  egress: VzConfig['egress'],
  state: VzNetworkState,
) {
  try {
    return planVzNetwork(egress, state).note
  } catch (e) {
    return `vm network: refused (${(e as Error).message})`
  }
}

export function kernelCommandLine(net: VzNetworkPlan['net'], now: Date) {
  return (
    'console=hvc0 root=/dev/vda rw rootfstype=ext4 init=/init-mirab.sh quiet loglevel=1' +
    ` mirab.time=${Math.floor(now.getTime() / 1000)}` +
    (net === 'nat' ? ' mirab.net=dhcp' : '')
  )
}

/** APFS clonefile (copy-on-write); a plain copy when the clone is refused (another volume). */
function cloneTree(helper: string, src: string, dst: string) {
  try {
    execFileSync(helper, ['clone', src, dst], { stdio: 'pipe' })
  } catch {
    execFileSync('cp', ['-Rp', src, dst], { stdio: 'ignore' })
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The helper's `run` arguments; `share` null = no virtio-fs device at all. */
export function vzRunArgs(o: {
  cfg: Pick<VzConfig, 'kernel' | 'vcpus' | 'memoryMiB'> & {
    /** This VM's own copy of the macOS platform files (see startVz). */
    macos?: string
  }
  root: string
  uds: string
  vmDir: string
  share: string | null
  net: VzNetworkPlan['net']
  listen: number[]
  now?: Date
}): string[] {
  const boot = o.cfg.macos
    ? ['--macos', o.cfg.macos]
    : [
        '--kernel',
        o.cfg.kernel,
        '--cmdline',
        kernelCommandLine(o.net, o.now ?? new Date()),
      ]
  return [
    'run',
    ...boot,
    '--rootfs',
    o.root,
    '--cpus',
    String(o.cfg.vcpus),
    '--memory',
    String(o.cfg.memoryMiB),
    '--vsock',
    o.uds,
    '--serial',
    join(o.vmDir, 'serial.log'),
    ...(o.share === null ? [] : ['--share', `workspace=${o.share}`]),
    '--net',
    o.net,
    ...o.listen.flatMap((p) => ['--listen', String(p)]),
  ]
}

export async function startVz(
  cfg: VzConfig,
  work: string | null,
  vmDir: string,
  log: (line: string) => void = () => {},
  network: VzNetworkState = vzNetworkState(),
  opts: VmStartOptions = {},
): Promise<Isolation & { timings: BootTimings; pid: number }> {
  const plan = planVzNetwork(cfg.egress, network)
  log(plan.note)
  await mkdir(vmDir, { recursive: true, mode: 0o700 })
  // Unix socket paths are limited to 104 bytes on macOS, so they live in a short dir.
  const sockDir = await mkdtemp(join(tmpdir(), 'gv-'))
  const uds = join(sockDir, 'v'),
    root = join(vmDir, 'rootfs.img'),
    share = join(vmDir, 'work')
  const t0 = Date.now()
  let helper: ReturnType<typeof spawn> | undefined
  const listeners: Server[] = []
  const stop = async (options?: {
    preserveWorkspace?: boolean
    keepRoot?: string
  }) => {
    for (const l of listeners) l.close()
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      const exited = new Promise((r) => helper!.once('exit', r))
      helper.stdin?.end() // the helper stops the VM when its stdin closes
      helper.kill('SIGTERM')
      if (!(await Promise.race([exited.then(() => true), wait(4000)])))
        helper.kill('SIGKILL')
    }
    await rm(sockDir, { recursive: true, force: true })
    if (options?.keepRoot) await rename(root, options.keepRoot)
    if (!options?.preserveWorkspace)
      await rm(vmDir, { recursive: true, force: true })
  }
  try {
    cloneTree(cfg.helper, cfg.rootfs, root)
    chmodSync(root, 0o600) // the base is usually read-only; its clone is this VM's disk
    // A macOS guest's NVRAM is written while it runs: each VM gets its own copy.
    const macos = cfg.macos ? join(vmDir, 'macos') : undefined
    if (cfg.macos && macos) {
      await mkdir(macos, { mode: 0o700 })
      for (const f of ['hardware-model', 'machine-id', 'aux.img'])
        cloneTree(cfg.helper, join(cfg.macos, f), join(macos, f))
      chmodSync(join(macos, 'aux.img'), 0o600)
    } else if (opts.rootGiB) await growDisk(root, opts.rootGiB)
    // No work directory (a CI runner): no share, so nothing of the host's is inside.
    if (work !== null) cloneTree(cfg.helper, work, share)
    const timings: BootTimings = { imageMs: Date.now() - t0, bootToAgentMs: 0 }
    const args = vzRunArgs({
      cfg: { ...cfg, macos },
      root,
      uds,
      vmDir,
      share: work === null ? null : share,
      net: plan.net,
      listen: opts.listen ?? GUEST_TO_HOST_PORTS,
    })
    const t1 = Date.now()
    const h = spawn(cfg.helper, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    helper = h
    let stderr = ''
    h.stderr!.on('data', (c) => (stderr += c))
    h.stdout!.on('data', () => {})
    const open: Opener = () => vsockChannel(uds, cfg.port)
    for (;;) {
      try {
        checkGuestProtocol(await guestPing(open), cfg.rootfs)
        break
      } catch (e) {
        if (e instanceof GuestProtocolError) throw e
        if (h.exitCode !== null || h.signalCode !== null) {
          const serial = await readFile(
            join(vmDir, 'serial.log'),
            'utf8',
          ).catch(() => '')
          throw new Error(
            `mirab-vz exited: ${stderr.trim()} ${serial.slice(-400)}`.trim(),
          )
        }
        // A Linux microVM answers in about a second; macOS takes a minute or so.
        if (Date.now() - t1 > (cfg.macos ? 180_000 : 20_000))
          throw new Error(
            'microVM agent did not come up: ' + (e as Error).message,
          )
        await wait(cfg.macos ? 500 : 5)
      }
    }
    timings.bootToAgentMs = Date.now() - t1
    log(
      `microVM ready in ${timings.bootToAgentMs} ms (clone ${timings.imageMs} ms)`,
    )
    return {
      level: 'vm',
      backend: 'vz',
      label: 'vm (vz)',
      timings,
      pid: h.pid!,
      ...vsockMembers(open, uds, work, listeners),
      close: stop,
    }
  } catch (e) {
    await stop()
    throw e
  }
}
