import { type Isolation } from './session';
export interface OciConfig {
    /** `docker` or `podman` (anything with the same CLI). */
    engine: string;
    image: string;
    /** Static linux guest agent binary, mounted read-only into the container. */
    agent: string;
    memory: string;
    cpus: string;
    pids: number;
    egress: 'auto' | 'block' | 'allow';
    /** Engine endpoint (`docker --host`), e.g. Colima's socket on macOS. */
    host?: string;
    /** Where the engine runs, for labels: `Colima vz VM`. */
    where?: string;
}
export declare const EGRESS_NETWORK = "mirab-egress";
/** Network the container joins: the filtered bridge, or none. `allow` without setup is an error. */
export declare function containerNetwork(mode: OciConfig['egress'], ready: boolean, setup?: string): "mirab-egress" | "none";
export declare const GUEST_WORK = "/workspace";
export declare const NETWORK_SETUP = "sudo scripts/vm-network-setup.sh";
/** The same script, run inside Colima's VM, where the containers' network lives. */
export declare const COLIMA_NETWORK_SETUP = "colima ssh -- sudo sh -s up < scripts/vm-network-setup.sh";
export declare function ociAvailable(engine: string, agent: string, host?: string): boolean;
export declare function startOci(cfg: OciConfig, work: string, log?: (line: string) => void): Isolation;
