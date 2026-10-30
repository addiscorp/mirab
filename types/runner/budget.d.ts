export interface Need {
    memoryMiB: number;
    vcpus: number;
}
export interface Lease extends Need {
    release(): void;
}
export interface BudgetSnapshot {
    memoryMiB: number;
    vcpus: number;
    usedMemoryMiB: number;
    usedVcpus: number;
    /** Leases held, by whoever asked. */
    leases: (Need & {
        by: string;
    })[];
    /** Waiting for room, front first. */
    queue: (Need & {
        by: string;
    })[];
}
export declare class HostBudget {
    readonly total: Need;
    private used;
    private held;
    private queue;
    constructor(total: Need);
    /** True when a VM this size can ever run here. */
    fits(need: Need): boolean;
    /** Waits for room (in turn) and returns the lease; rejects if `signal`
     *  aborts first, or if the VM is bigger than the whole budget. */
    acquire(need: Need, by: string, signal?: AbortSignal): Promise<Lease>;
    snapshot(): BudgetSnapshot;
    private pump;
}
