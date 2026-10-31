export declare const NFT_FILE = "/etc/mirab/vm-network.nft";
export declare const UP_SCRIPT = "/usr/local/libexec/mirab-vm-network";
export declare const UNIT_NAME = "mirab-vm-network.service";
export declare const UNIT_FILE = "/etc/systemd/system/mirab-vm-network.service";
export declare const SYSCTL_FILE = "/etc/sysctl.d/90-mirab-vm.conf";
export declare const DEFAULT_SLOTS = 16;
/** Everything a guest must never reach. */
export declare const DENIED4: string[];
export interface LinuxNetworkFile {
    path: string;
    mode: number;
    content: string;
}
export interface LinuxNetworkPlan {
    user: string;
    slots: number;
}
export declare function checkPlan(p: LinuxNetworkPlan): void;
/** The files setup writes, in the order it writes them. */
export declare function linuxNetworkFiles(p: LinuxNetworkPlan): LinuxNetworkFile[];
/** What setup and remove touch on the machine; tests pass their own. */
export interface LinuxSetupSystem {
    isRoot(): boolean;
    platform: NodeJS.Platform;
    /** NixOS: /etc is generated from the system configuration (read-only). */
    nixos: boolean;
    /** Whether a user exists (setup refuses a typo). */
    userExists(name: string): boolean;
    /** A command on PATH, for the prerequisites check. */
    has(command: string): boolean;
    /** Runs a command; throws when it fails. */
    run(argv: string[]): void;
    /** Atomically installs a root:root file with this mode. */
    install(file: LinuxNetworkFile): void;
    remove(path: string): void;
}
export declare const realLinuxSystem: LinuxSetupSystem;
/** Installs the network for `user`'s VMs, or prints what it would do. Safe to run again. */
export declare function setupLinuxNetwork(opts: {
    user?: string;
    slots?: number;
    dryRun?: boolean;
    log?: (line: string) => void;
}, sys?: LinuxSetupSystem): void;
/** Undoes setup: the devices and rules first, then the files. */
export declare function removeLinuxNetwork(opts: {
    dryRun?: boolean;
    log?: (line: string) => void;
}, sys?: LinuxSetupSystem): void;
