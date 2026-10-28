import { type Isolation } from './session';
export declare const MARKER_DIR = "/etc/mirab/host-users";
/** What scripts/host-user-setup.sh wrote to /etc/mirab/host-users/<user>.json. */
export interface Marker {
    version: 1;
    user: string;
    uid: number;
    gid: number;
    owner: string;
    agent: string;
    workRoot: string;
    network?: string;
}
/** Everything detection looks at, so tests can describe any machine. */
export interface HostProbe {
    marker(user: string): string | undefined;
    uidOf(user: string): number | undefined;
    me: {
        uid: number;
        name: string;
        groups: number[];
    };
    stat(path: string): {
        uid: number;
        gid: number;
        mode: number;
        dir: boolean;
    } | undefined;
}
export declare const systemProbe: (markerDir?: string) => HostProbe;
export type HostUserState = {
    ok: true;
    marker: Marker;
} | {
    ok: false;
    reason: string;
    fix: string;
};
export declare const setupCommand: (user: string, owner: string) => string;
/** Is the host tier for `user` set up, and set up safely? Never runs sudo. */
export declare function hostUserState(user: string, probe: HostProbe): HostUserState;
/**
 * Stage the job directory under the shared work root, then run the agent as
 * the dedicated user. `runAs` is the privilege switch: the sudo rule from the
 * setup script; tests pass [] to exercise the same path as themselves.
 */
export declare function startHostUser(marker: Marker, work: string, log?: (line: string) => void, runAs?: string[]): Promise<Isolation>;
