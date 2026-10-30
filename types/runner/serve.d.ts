import { type VmConfig } from '../isolation';
import type { Isolation } from '../isolation/session';
import { hostRunnerPlatform, type RunnerDefinition, type RunnerPlatform, type RunnerStep } from './define';
import { type RunnerImage, type RunnerRecipe } from './image';
export declare const runnersDir: (configDir: string) => string;
/** idle: no VM, watching the forge for a job (warm 0). queued: waiting for
 *  room in the host's budget. waiting: booted and registered, no job yet. */
export type SlotPhase = 'image' | 'idle' | 'queued' | 'booting' | 'waiting' | 'busy' | 'stopping';
export interface SlotState {
    vmName: string;
    phase: SlotPhase;
    since: string;
}
export interface RunnerState {
    name: string;
    host: string;
    forge: string;
    image?: string;
    slots: SlotState[];
    jobs: number;
    lastError?: {
        at: string;
        message: string;
    };
}
/** Things serveRunners does to the world; tests pass their own. */
export interface ServeDeps {
    startVm: (vm: VmConfig, vmDir: string, log: (line: string) => void) => Promise<Isolation>;
    image: (def: RunnerDefinition, recipe: RunnerRecipe) => Promise<RunnerImage>;
    recipe: (def: RunnerDefinition) => Promise<RunnerRecipe>;
    sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    now: () => Date;
    /** How long a minute is (the job and idle timers); tests shorten it. */
    minuteMs: number;
}
export interface ServeOptions {
    configDir: string;
    vm: VmConfig;
    /** Names registrations `<host>-<name>-<random>`. */
    host?: string;
    /** RAM all runner VMs together may use (default: host RAM − 3 GiB). */
    budgetMiB?: number;
    /** vCPUs all runner VMs together may use (default: the host's CPUs). */
    budgetVcpus?: number;
    signal?: AbortSignal;
    log?: (line: string) => void;
    deps?: Partial<ServeDeps>;
}
/** A runner's VM: nothing of the host's inside (no work share or drive) and
 *  no guest-to-host port. */
export declare function startRunnerVm(vm: VmConfig, vmDir: string, log: (line: string) => void): Promise<Isolation>;
/** A host name usable in a registration name. */
export declare function hostLabel(name?: string): string;
/** Replaces every secret value in `line` (the ticket's, while it lives). */
export declare function redact(line: string, secrets: Iterable<string>): string;
/** The env every job step gets: base, then the image's toolsets, then the
 *  forge's job env, then the step's own (later wins). PATH is composed. */
export declare function jobEnv(def: RunnerDefinition, image: Pick<RunnerImage['meta'], 'env' | 'path'> & {
    platform?: RunnerPlatform;
}, job: Record<string, string>, step?: Record<string, string>): Record<string, string>;
/** Lines longer than this are cut (host side, by guestExec's cutLines). */
export declare const STEP_LINE_CHARS = 4000;
/** The argv mirab really execs for a step: as the runner user unless asRoot.
 *  No pipeline in the guest: anything between the step and the agent can hold
 *  its output back (cut, and mawk without -W interactive, buffer off a
 *  terminal), and a job's "started" line must arrive while it runs, or an
 *  on-demand VM's idle timer ends the job. Long lines are cut on the host. */
export declare function stepArgv(step: RunnerStep, platform?: RunnerPlatform): string[];
/** Refuses a host that can't run these definitions safely. */
export declare function admission(defs: RunnerDefinition[], o: {
    configDir: string;
    budgetMiB: number;
    budgetVcpus: number;
    backend: 'vz' | 'firecracker';
    filtered: boolean;
    freeBytes: number;
}): Promise<void>;
export declare function serveRunners(defs: RunnerDefinition[], o: ServeOptions): Promise<void>;
/** The labels a registration carries: `mirab-<os>-<arch>`, then the definition's. */
export declare const runnerLabels: (def: RunnerDefinition, platform: RunnerPlatform) => string[];
export { hostRunnerPlatform };
export type { RunnerPlatform };
