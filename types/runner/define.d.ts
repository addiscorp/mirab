import { z } from 'zod';
/** The guests a runner can run. */
export declare const RUNNER_PLATFORMS: readonly ['linux-x64', 'linux-arm64'];
export type RunnerPlatform = (typeof RUNNER_PLATFORMS)[number];
/** Every runner carries `mirab-<os>-<arch>` (e.g. `mirab-linux-arm64`), so a
 *  job asks for a fresh VM of a platform with one label. */
export declare const platformLabel: (platform: RunnerPlatform) => string;
/** One command in the VM. Steps run as the unprivileged `runner` user unless
 *  `asRoot` (then the step is responsible for dropping to it, with RUNNER_SETPRIV). */
export interface RunnerStep {
    argv: string[];
    env?: Record<string, string>;
    asRoot?: boolean;
}
/** A file put into the VM before the job's steps. `secret` files are never
 *  logged; they should live on tmpfs (/run) and be removed once read. */
export interface RunnerFile {
    path: string;
    mode: number;
    content: string;
    secret?: boolean;
}
/** A one-time credential for exactly one job. Every value in `secret` is
 *  redacted from mirab's logs and never written to the host's disk. */
export interface RunnerTicket {
    name: string;
    secret: Record<string, string>;
    meta?: Record<string, string>;
}
/** What a forge adapter provides. */
export interface Forge {
    name: string;
    /** Host side: register one runner called `name` for one job. */
    ticket(req: {
        name: string;
        labels: string[];
        platform: RunnerPlatform;
    }): Promise<RunnerTicket>;
    guest: {
        /** Baked into the runner image as root, in the build VM. `key` names
         *  exactly what is installed (e.g. a version and checksum): a new key is
         *  a new image. Called again at most daily, to notice new releases. */
        install(platform: RunnerPlatform): Promise<{
            key: string;
            steps: RunnerStep[];
        }>;
        /** Hosts the image build may reach for `install`. */
        buildEgress: string[];
        /** One job: files put first, then the steps in order; the last one is
         *  the runner, which takes one job and exits. */
        job(ticket: RunnerTicket): {
            files: RunnerFile[];
            steps: RunnerStep[];
            env: Record<string, string>;
        };
        /** True for the runner's output line that says a job has started: the
         *  job timer (timeoutMinutes) starts there, not at boot. */
        started(line: string): boolean;
    };
    /** Delete this host's registrations named `prefix*` that aren't in `live`. */
    reconcile(prefix: string, live: string[]): Promise<void>;
    /** How many jobs are waiting right now that a runner with these labels
     *  could take. Optional; without it a pool can only be warm. Called every
     *  `pool.pollSeconds` while a pool has no VM, so it should be cheap. */
    queued?(req: {
        labels: string[];
        platform: RunnerPlatform;
    }): Promise<number>;
}
/** The toolsets a runner image can carry. */
export declare const TOOLSETS: readonly ['rust', 'node', 'go'];
export declare const runnerSchema: z.ZodObject<{
    name: z.ZodString;
    forge: z.ZodCustom<Forge, Forge>;
    labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
    image: z.ZodDefault<z.ZodObject<{
        tools: z.ZodDefault<z.ZodObject<{
            rust: z.ZodOptional<z.ZodString>;
            node: z.ZodOptional<z.ZodString>;
            go: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        packages: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    vm: z.ZodDefault<z.ZodObject<{
        vcpus: z.ZodDefault<z.ZodNumber>;
        memoryMiB: z.ZodDefault<z.ZodNumber>;
        diskGiB: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    pool: z.ZodDefault<z.ZodObject<{
        warm: z.ZodDefault<z.ZodNumber>;
        max: z.ZodDefault<z.ZodNumber>;
        idleHours: z.ZodDefault<z.ZodNumber>;
        pollSeconds: z.ZodDefault<z.ZodNumber>;
        waitMinutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    timeoutMinutes: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type RunnerDefinition = z.infer<typeof runnerSchema>;
export type RunnerInput = z.input<typeof runnerSchema>;
export declare function defineRunner(input: RunnerInput): RunnerDefinition;
/** The unprivileged user every job step runs as (created in the runner image). */
export declare const RUNNER_USER: {
    name: string;
    uid: number;
    home: string;
};
/** Prefix that drops a root command to the runner user, keeping its env. */
export declare const RUNNER_SETPRIV: string[];
/** The guest platform a VM on this host runs. */
export declare function hostRunnerPlatform(arch?: string): RunnerPlatform;
