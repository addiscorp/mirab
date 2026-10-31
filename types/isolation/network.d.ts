export declare const BRIDGE = "mirabbr0";
export declare const SETUP_COMMAND: string;
export interface NetworkState {
    ready: boolean;
    /** Tap slots this user can use. */
    slots: number[];
    reason?: string;
}
export declare function networkState(uid?: number, sys?: string): NetworkState;
export declare function guestNetwork(slot: number): {
    tap: string;
    mac: string;
    ip: string;
    cidr: number;
    gateway: string;
    dns: string;
};
/** Kernel args read by /init-mirab.sh in the guest. */
export declare function bootNetArgs(n: ReturnType<typeof guestNetwork>): string;
/** Claim a free tap slot with a pid lock file; stale locks of dead pids are taken over. */
export declare function claimTap(slots: number[], lockDir: string): {
    slot: number;
    release: () => void;
};
export declare function networkStatusLine(mode: 'auto' | 'block' | 'allow', s: NetworkState): string;
export interface NetworkPlan {
    net?: ReturnType<typeof guestNetwork>;
    release: () => void;
    /** Printed in the job log. */
    note: string;
}
/** Decide whether a VM gets a network device. `allow` without setup is an error, `auto` degrades loudly. */
export declare function planNetwork(mode: 'auto' | 'block' | 'allow', state: NetworkState, lockDir: string): NetworkPlan;
