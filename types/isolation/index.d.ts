import { z } from 'zod';
import { type VmStartOptions } from './firecracker';
import { type ColimaState } from './colima';
import { type HostUserState } from './host-user';
import { type Level, type Resolved } from './policy';
import { type VmPlatform } from './image';
import type { Isolation } from './session';
export * from './policy';
export type { Isolation } from './session';
export { vmImagePaths } from './image';
/** `<config dir>/isolation.json`: what the owner set once on this host. */
export declare const hostConfigSchema: (configDir: string) => z.ZodObject<{
    floor: z.ZodOptional<z.ZodEnum<{
        container: "container";
        host: "host";
        none: "none";
        vm: "vm";
    }>>;
    default: z.ZodOptional<z.ZodEnum<{
        container: "container";
        host: "host";
        none: "none";
        vm: "vm";
    }>>;
    vm: z.ZodOptional<z.ZodObject<{
        firecracker: z.ZodDefault<z.ZodString>;
        vz: z.ZodDefault<z.ZodString>;
        kernel: z.ZodDefault<z.ZodString>;
        rootfs: z.ZodDefault<z.ZodString>;
        memoryMiB: z.ZodDefault<z.ZodNumber>;
        vcpus: z.ZodDefault<z.ZodNumber>;
        egress: z.ZodDefault<z.ZodEnum<{
            allow: "allow";
            auto: "auto";
            block: "block";
        }>>;
    }, z.core.$strict>>;
    container: z.ZodOptional<z.ZodObject<{
        engine: z.ZodDefault<z.ZodString>;
        image: z.ZodDefault<z.ZodString>;
        agent: z.ZodString;
        memory: z.ZodDefault<z.ZodString>;
        cpus: z.ZodDefault<z.ZodString>;
        pids: z.ZodDefault<z.ZodNumber>;
        egress: z.ZodDefault<z.ZodEnum<{
            allow: "allow";
            auto: "auto";
            block: "block";
        }>>;
    }, z.core.$strict>>;
    host: z.ZodOptional<z.ZodObject<{
        user: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type HostConfig = z.infer<ReturnType<typeof hostConfigSchema>>;
export type VmConfig = NonNullable<HostConfig['vm']>;
/** The `vm` level's backend: Virtualization.framework on macOS, Firecracker elsewhere. */
export declare const vmBackend: (platform?: NodeJS.Platform) => "firecracker" | "vz";
export declare function vmAvailable(vm: VmConfig, platform?: NodeJS.Platform): boolean;
export type { VmStartOptions } from './firecracker';
/** Boot one microVM with `work` at /workspace (null: no work directory and
 *  nothing of the host's inside), on this platform's backend. */
export declare function startVm(vm: VmConfig, work: string | null, vmDir: string, log?: (line: string) => void, platform?: NodeJS.Platform, opts?: VmStartOptions): Promise<Isolation>;
export declare function loadHostConfig(configDir: string): Promise<HostConfig>;
/** The level a run asks for, before availability: what decides whether the
 *  published VM image is worth fetching. */
export declare const requestedLevel: (host: HostConfig, req: Request) => "container" | "host" | "none" | "vm" | undefined;
export interface PreparedVm {
    host: HostConfig;
    /** Why the published VM image could not be fetched; `vm` then falls to the next tier. */
    vmUnavailable?: string;
}
/**
 * Load isolation.json and, when this run asks for `vm` and the owner did not
 * point it at their own kernel and rootfs, make sure the published guest
 * image for this mirab version is in <config dir>/vm (downloaded once, then
 * used offline) and describe `vm` with it.
 */
export declare function prepareVm(configDir: string, o: {
    want: boolean;
    log?: (line: string) => void;
    base?: string;
    /** The mirab release whose image to use (default: this copy's own). A
     *  package that embeds mirab from git names the canary of that commit. */
    version?: string;
    platform?: VmPlatform;
    /** The backend's own prerequisites (Firecracker, /dev/kvm) are present. */
    backendReady?: (host: HostConfig) => boolean;
}): Promise<PreparedVm>;
/** What this machine can do; tests pass their own. */
export interface Probes {
    platform: NodeJS.Platform;
    /** The `vm` backend (vmBackend) works with this config. */
    vm(vm: VmConfig): boolean;
    oci(engine: string, agent: string, endpoint?: string): boolean;
    colima(): ColimaState;
    hostUser(user: string): HostUserState;
}
export declare const systemProbes: () => Probes;
export interface Detected {
    levels: Level[];
    /** One line per backend that is configured or detected, for `mirab status`. */
    notes: string[];
    colima?: ColimaState;
    hostUser?: HostUserState;
}
export declare function detect(host: HostConfig, p?: Probes): Detected;
export declare function availableLevels(host: HostConfig, p?: Probes): Level[];
export interface Request {
    flag?: Level;
    job?: Level;
    profile?: Level;
}
/**
 * Resolve a run's isolation. With `vmUnavailable` (the published VM image
 * could not be fetched), a request for `vm` falls to the strongest other
 * tier the floor allows, never to `none`, and the result says so.
 */
export declare function resolveForHost(host: HostConfig, req: Request, p?: Probes, vmUnavailable?: string): Resolved;
export declare const backendName: (level: Level, platform?: NodeJS.Platform) => string;
/** One line for `mirab status` and job logs. */
export declare function describe(resolved: Resolved, backend?: string): string;
export declare function startIsolation(level: Level, host: HostConfig, work: string, vmDir: string, log?: (line: string) => void, p?: Probes): Promise<Isolation | null>;
export declare function statusLines(host: HostConfig, requested?: Request, p?: Probes): string[];
/** Called once before a session starts: one that cannot isolate does not start. */
export declare function assertCanIsolate(host: HostConfig, flag?: Level, p?: Probes, vmUnavailable?: string): Resolved;
/** The VM this machine runs (the published image, fetched on first use), or why not. */
export declare function requireVm(configDir: string, log?: (line: string) => void, version?: string): Promise<VmConfig>;
