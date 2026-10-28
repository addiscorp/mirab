export declare const LEVELS: readonly ['vm', 'container', 'host', 'none'];
export type Level = (typeof LEVELS)[number];
export declare const strength: (level: Level) => number;
export type RequestSource = 'flag' | 'job' | 'profile' | 'host-default' | 'auto';
export interface PolicyInput {
    /** `--isolation` on this run. Most specific, wins over everything below. */
    flag?: Level;
    /** `isolation:` on the workflow job. */
    job?: Level;
    /** `isolation` in the agent profile. */
    profile?: Level;
    /** The host default the owner set once in the host config. */
    hostDefault?: Level;
    /** Owner floor: levels weaker than this are refused, never upgraded. */
    floor?: Level;
    /** Backends usable on this machine. */
    available: readonly Level[];
}
export interface Resolved {
    level: Level;
    source: RequestSource;
    /** Set when the requested level could not be had and a weaker tier took the run. */
    fallback?: string;
}
export declare class IsolationRefused extends Error {
}
export declare function parseLevel(text: string | undefined, where: string): Level | undefined;
export declare function resolveIsolation(input: PolicyInput): Resolved;
export declare const labelFor: (level: Level, backend: string) => string;
