export declare const COLIMA_INSTALL = "brew install colima docker && colima start --vm-type vz --mount-type virtiofs";
export interface ColimaMount {
    location: string;
    writable: boolean;
}
export type ColimaState = {
    running: true;
    /** `unix://…/docker.sock`, passed to docker as `--host`. */
    socket: string;
    vmType: string;
    arch: string;
    mountType: string;
    mounts: ColimaMount[];
} | {
    running: false;
    reason: string;
    fix: string;
};
export interface ColimaProbe {
    /** stdout of `colima status --json`, or undefined if it failed or is not installed. */
    status(): string | undefined;
    installed(): boolean;
    /** ~/.colima/default/colima.yaml, if present. */
    config(): string | undefined;
    home: string;
    exists(path: string): boolean;
}
export declare const systemColimaProbe: (profile?: string) => ColimaProbe;
/** The `mounts:` list of colima.yaml; an empty list means Colima's default ($HOME, writable). */
export declare function colimaMounts(yaml: string | undefined, home: string): {
    location: string;
    writable: boolean;
}[];
export declare function detectColima(p: ColimaProbe): ColimaState;
/** The mount that makes `path` visible in Colima's VM, if any (and writable when asked). */
export declare function colimaMountFor(path: string, mounts: ColimaMount[], writable: boolean): ColimaMount | undefined;
export declare function colimaStatusLine(c: ColimaState): string;
