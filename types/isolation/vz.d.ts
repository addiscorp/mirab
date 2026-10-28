import { type BootTimings, type VmStartOptions } from './firecracker';
import { type Isolation } from './session';
export interface VzConfig {
    /** The signed mirab-vz helper. */
    helper: string;
    /** Guest kernel with virtio-pci built in: the uncompressed arm64 `Image` on
     *  Apple silicon, a relocatable x86_64 `bzImage` on Intel Macs. */
    kernel: string;
    /** Base ext4 image; each VM boots an APFS clone of it. */
    rootfs: string;
    memoryMiB: number;
    vcpus: number;
    /** Guest vsock port the agent listens on. */
    port: number;
    egress: 'auto' | 'block' | 'allow';
}
/** Guest -> host vsock ports the helper relays: the spawn --vm hook relay
 *  (9100) and the way out through the station (9101). */
export declare const GUEST_TO_HOST_PORTS: number[];
/** The guest's loopback port for the way out, and the host vsock port it reaches. */
export declare const EGRESS_GUEST_PORT = 8790;
export declare const EGRESS_HOST_PORT = 9101;
export declare const VZ_NETWORK_MARKER = "/etc/mirab/vz-network.json";
export declare const VZ_SETUP_COMMAND = "sudo ~/.mirab/bin/mirab vm network setup";
/** What the marker says once the pf anchor denies guests the LAN. */
export declare const VZ_LAN_DENIED = "lan-denied";
/** This Mac can run Virtualization.framework guests (hosted CI Macs cannot). */
export declare function vzHostReady(): boolean;
export declare function vzAvailable(c: Pick<VzConfig, 'helper' | 'kernel' | 'rootfs'>, platform?: NodeJS.Platform): boolean;
export interface VzNetworkState {
    /** The owner installed the pf anchor that denies VZ NAT guests the LAN. */
    filtered: boolean;
    reason?: string;
}
/** Reads the root-owned marker `mirab vm network setup` writes; never runs sudo or pfctl. */
export declare function vzNetworkState(marker?: string): VzNetworkState;
export interface VzNetworkPlan {
    net: 'none' | 'nat';
    note: string;
}
/**
 * VZ NAT (vmnet shared mode) gives the guest the internet AND the Mac's LAN,
 * the Mac itself and the tailnet. Only a root pf anchor can deny those, so NAT
 * is used only when that anchor is installed; otherwise the VM has no network.
 */
export declare function planVzNetwork(egress: VzConfig['egress'], state: VzNetworkState): VzNetworkPlan;
export declare function vzNetworkStatusLine(egress: VzConfig['egress'], state: VzNetworkState): string;
export declare function kernelCommandLine(net: VzNetworkPlan['net'], now: Date): string;
/** The helper's `run` arguments; `share` null = no virtio-fs device at all. */
export declare function vzRunArgs(o: {
    cfg: Pick<VzConfig, 'kernel' | 'vcpus' | 'memoryMiB'>;
    root: string;
    uds: string;
    vmDir: string;
    share: string | null;
    net: VzNetworkPlan['net'];
    listen: number[];
    now?: Date;
}): string[];
export declare function startVz(cfg: VzConfig, work: string | null, vmDir: string, log?: (line: string) => void, network?: VzNetworkState, opts?: VmStartOptions): Promise<Isolation & {
    timings: BootTimings;
    pid: number;
}>;
