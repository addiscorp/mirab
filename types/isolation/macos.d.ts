import { z } from 'zod';
export declare const macosDir: (configDir: string) => string;
declare const baseSchema: z.ZodObject<{
    version: z.ZodString;
    build: z.ZodString;
    ipsw: z.ZodString;
    diskGiB: z.ZodNumber;
    installedAt: z.ZodString;
    agent: z.ZodString;
    mirab: z.ZodString;
}, z.core.$strip>;
export type MacosBase = z.infer<typeof baseSchema> & {
    dir: string;
};
/** `27.2` before `27.10`, `27.2` before `27.2.1`. */
export declare function compareVersions(a: string, b: string): number;
/** The provisioned bases on this machine, newest first. A directory without
 *  base.json (an install that stopped, or one made by hand) is not a base. */
export declare function listMacosBases(configDir: string): MacosBase[];
/** The base a darwin-arm64 runner uses when isolation.json names none. */
export declare const newestMacosBase: (configDir: string) => string | undefined;
export interface RestoreImage {
    url: string;
    version: string;
    build: string;
    supported: boolean;
}
export declare class MacosPullError extends Error {
}
/** How provisioning gets administrator rights: `sudo` in a terminal (so it
 *  works over SSH too), else macOS's own password dialog. */
export type Elevate = (argv: string[], why: string) => Promise<void>;
export declare const elevate: Elevate;
export interface PullOptions {
    configDir: string;
    /** A local .ipsw instead of the newest one Apple publishes for this Mac. */
    ipsw?: string;
    diskGiB?: number;
    /** Keep the restore image after installing (25 GB or so). */
    keepIpsw?: boolean;
    log?: (line: string) => void;
    elevate?: Elevate;
    /** The helper and agent; tests and checkouts point elsewhere. */
    helper?: string;
    agent?: string;
    /** `<os>-<arch>` of this machine (tests pretend). */
    host?: string;
    /** Live progress of the long steps (the CLI draws it as one line on a
     *  terminal); without it, they log a line every few percent. */
    progress?: (p: PullProgress | null) => void;
}
/** A long step: `fraction` is 0..1, or absent while it can't say yet (Apple's
 *  installer prepares for a minute or so first). `null` ends the step. */
export interface PullProgress {
    step: string;
    fraction?: number;
    detail?: string;
}
/** Fetch, install and provision the newest macOS this Mac runs (or `ipsw`);
 *  a base that is already here is returned as it is. */
export declare function pullMacos(o: PullOptions): Promise<MacosBase>;
/** Disk a base takes (its sparse disk.img's allocated blocks). */
export declare function baseBytes(dir: string): Promise<number>;
export {};
