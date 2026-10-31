export declare const FIRECRACKER_PIN: {
    version: string;
    tarball: string;
    sha256: string;
    files: Record<string, string>;
};
/** `<dir>/firecracker`, the pinned release; a matching one already there is kept. */
export declare function installFirecracker(dir: string, o?: {
    fetcher?: typeof fetch;
    log?: (line: string) => void;
}): Promise<string>;
