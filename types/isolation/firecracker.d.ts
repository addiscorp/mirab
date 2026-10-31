import { type Server } from 'node:net';
import { type Channel, type Isolation, type Opener } from './session';
export interface FirecrackerConfig {
    firecracker: string;
    kernel: string;
    /** Read-only base image containing mirab-guest-agent and /init-mirab.sh. */
    rootfs: string;
    memoryMiB: number;
    vcpus: number;
    /** Guest vsock port the agent listens on. */
    port: number;
    /** `block` = no network device; `allow` = tap or refuse; `auto` = tap when set up, else none. */
    egress: 'auto' | 'block' | 'allow';
}
export declare const GUEST_WORK = "/workspace";
/**
 * The Firecracker to run when isolation.json names none: the one shipped next
 * to the mirab executable (where mirab's packaging will put it), else
 * `firecracker` on PATH. `vm.firecracker` in isolation.json wins over both.
 */
export declare function defaultFirecracker(execPath?: string): string;
/** /dev/kvm, Firecracker and mke2fs: what this host needs besides the guest image. */
export declare function firecrackerHostReady(firecracker: string): boolean;
export declare function firecrackerAvailable(c: Pick<FirecrackerConfig, 'firecracker' | 'kernel' | 'rootfs'>): boolean;
export declare function vsockChannel(uds: string, port: number): Promise<Channel>;
/**
 * The Isolation members every vsock backend shares (Firecracker, vz): the
 * work directory (when there is one) appears at /workspace, and guest connections to host port N
 * arrive on the unix socket `<uds>_N` (Firecracker's convention, which the vz
 * helper follows too).
 */
export declare function vsockMembers(open: Opener, uds: string, work: string | null, listeners: Server[]): Pick<Isolation, 'guestPath' | 'put' | 'exec' | 'pty' | 'files' | 'onGuestMessage' | 'onGuestConnect'>;
/** What a VM start may add to the backend's config. */
export interface VmStartOptions {
    /** Grow this VM's root disk clone to this size before boot (sparse; never
     *  shrinks). The guest sees a bigger /dev/vda; growing the filesystem on it
     *  (resize2fs) is the guest's job. */
    rootGiB?: number;
    /** vz: guest-to-host vsock ports to forward (default GUEST_TO_HOST_PORTS);
     *  [] for a VM that must not reach the host at all. Firecracker forwards a
     *  port only when someone serves it (onGuestConnect), so it needs no list. */
    listen?: number[];
    /** vz on Apple silicon: boot this VM as macOS from a provisioned base
     *  directory (its disk is `<macos>/disk.img`). Only for this VM: a host's
     *  `vm.macos` never turns its other VMs into macOS. */
    macos?: string;
}
/** Sparse-grows a disk image file to `gib` GiB; refuses to shrink one. */
export declare function growDisk(path: string, gib: number): Promise<void>;
/** Checked bytes, not a signed 32-bit shift: large work images stay positive. */
export declare function workImageBytes(usedKiB: number): number;
export interface BootTimings {
    imageMs: number;
    bootToAgentMs: number;
}
export declare function startFirecracker(cfg: FirecrackerConfig, work: string | null, vmDir: string, log?: (line: string) => void, opts?: VmStartOptions): Promise<Isolation & {
    timings: BootTimings;
    pid: number;
}>;
