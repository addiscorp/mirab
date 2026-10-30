import type { Level } from './policy';
/** The guest-agent wire protocol this CLI speaks; guest-agent/src/main.rs reads the same file. */
export declare const GUEST_PROTOCOL: number;
/** Where the guest image is rebuilt from; printed with every mismatch. */
export declare const REBUILD_HINT: string;
export interface Channel {
    write(data: Uint8Array): void;
    onData(cb: (chunk: Buffer) => void): void;
    onClose(cb: (error?: Error) => void): void;
    close(): void;
}
export interface ExecOptions {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    signal: AbortSignal;
    /** One call per output line (stdout and stderr), already de-framed. */
    onLine: (line: string) => Promise<void>;
    /** Cut a line longer than this to its first `cutLines` characters and skip
     *  the rest of it, instead of ending the step (the default above 32 KiB).
     *  For CI logs, where one huge line must not fail a job. */
    cutLines?: number;
}
export interface Isolation {
    readonly level: Level;
    readonly backend: string;
    /** What `mirab status` and job logs print. */
    readonly label: string;
    /** Host path of the job work directory -> where the guest sees it. */
    guestPath(hostPath: string): string;
    put(hostPath: string, content: string | Uint8Array, mode?: number): Promise<void>;
    /** Run a step; resolves with its exit code (124 timeout, 130 cancelled). */
    exec(argv: string[], options: ExecOptions): Promise<number>;
    /** Interactive program on a guest pty (spawn --vm). */
    pty?(request: PtyRequest): Promise<PtyHandle>;
    /** Read the guest file tree (working-directory sync); backends without a copy omit it. */
    files?: GuestFiles;
    /** Messages the guest initiates toward the host on a vsock port (hooks). */
    onGuestMessage?(port: number, handler: (message: any) => void): void;
    /** Serve the VM's guest-to-host `port` (e.g. the station's egress): `serve`
     *  listens on the socket path given, which belongs to this VM alone. */
    onGuestConnect?(port: number, serve: (socketPath: string) => Promise<import('node:net').Server>): Promise<void>;
    /** Stop the backend; preserve its workspace for recovery after incomplete sync. */
    close(options?: {
        preserveWorkspace?: boolean;
        /** Keep this VM's root disk (its own copy) at this path once it has
         *  stopped: how an agent's image is built and updated. */
        keepRoot?: string;
    }): Promise<void>;
}
/** One entry under a sync root, the same shape the guest agent's `list` op returns. */
export interface Entry {
    /** Path relative to the root, `/`-separated. */
    p: string;
    /** `f` regular file, `d` directory, `l` symlink. */
    k: 'f' | 'd' | 'l';
    /** Permission bits (0 for symlinks). */
    m: number;
    s?: number;
    /** sha256 hex of the content (files). */
    h?: string;
    /** Link target (symlinks). */
    t?: string;
}
export interface GuestFiles {
    list(root: string): Promise<Entry[]>;
    read(path: string): Promise<Buffer>;
}
export interface PtyRequest {
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    cols: number;
    rows: number;
}
export interface PtyHandle {
    write(data: Uint8Array | string): void;
    resize(cols: number, rows: number): void;
    onData(cb: (data: Buffer) => void): void;
    onExit(cb: (code: number) => void): void;
    /** Drop the connection: the guest hangs up the session. */
    close(): void;
}
export type Opener = () => Promise<Channel>;
export interface GuestHello {
    /** 1 for agents that predate the handshake (their ping reply has no number). */
    protocol: number;
    agent?: string;
}
export declare function guestPing(open: Opener): Promise<GuestHello>;
export declare class GuestProtocolError extends Error {
}
/** Refuse a guest agent that speaks another protocol, at connect time and
 *  with the fix, instead of failing mid-session on an op it lacks. */
export declare function checkGuestProtocol(hello: GuestHello, image: string): void;
export declare function guestPut(open: Opener, path: string, content: string | Uint8Array, mode?: number): Promise<void>;
export declare function guestFiles(open: Opener): GuestFiles;
export declare function guestExec(open: Opener, argv: string[], o: ExecOptions): Promise<number>;
export declare function guestPty(open: Opener, request: PtyRequest): Promise<PtyHandle>;
/** Read one length-prefixed JSON message from a connection the guest opened. */
export declare function readOneMessage(stream: {
    on(event: 'data', cb: (c: Buffer) => void): unknown;
}): Promise<any>;
