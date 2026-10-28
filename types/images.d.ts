import { type VmConfig } from './isolation';
import type { Isolation } from './isolation/session';
/** Where apt goes, over HTTPS: the station lets nothing else out. */
export declare const UBUNTU_MIRRORS: string[];
export interface ImageMeta {
    key: string;
    packages: string[];
    base: string;
    builtAt: string;
    updatedAt: string;
    /** What the last update upgraded. */
    upgraded: string[];
}
export declare const imagesDir: (configDir: string) => string;
/** The base image: where it is, its size, when it was written, and a hash of
 *  its first 4 MB (the filesystem's superblock and early blocks), without
 *  reading all 3 GB. A new base is a new key. */
export declare function baseId(rootfs: string): Promise<string>;
/** A cache key for any build recipe: the base plus the recipe as canonical
 *  JSON (object keys sorted at every level), so equal recipes share a key. */
export declare function recipeKey(base: string, recipe: unknown): string;
/** The cache key: the base and the package list, order and repeats aside. */
export declare function imageKey(base: string, packages: string[]): string;
export interface CachedImage {
    rootfs: string;
    meta: ImageMeta;
}
export declare function cachedImage(configDir: string, key: string, base?: string): Promise<CachedImage | undefined>;
/** In a build VM: tools other than apt (curl, rustup) reach the station too. */
export declare const BUILD_ENV: {
    PATH: string;
    HOME: string;
    DEBIAN_FRONTEND: string;
    LANG: string;
    HTTP_PROXY: string;
    HTTPS_PROXY: string;
    http_proxy: string;
    https_proxy: string;
    NO_PROXY: string;
};
/** Runs one command as root in the VM; a failure carries the end of its output. */
export declare function run(iso: Pick<Isolation, 'exec'>, argv: string[], log?: (l: string) => void, env?: Record<string, string>): Promise<string[]>;
/** A build VM on `rootfs` whose only way out is the station, to the hosts in
 *  `allow` (default: Ubuntu's mirrors, for apt). `rootGiB` grows its root
 *  disk first; the build then grows the filesystem (resize2fs). */
export declare function bootForBuild(o: {
    configDir: string;
    vm: VmConfig;
    rootfs: string;
    key: string;
    allow?: string[];
    rootGiB?: number;
    log?: (line: string) => void;
}): Promise<{
    iso: Isolation;
    cleanup: () => Promise<void>;
}>;
/** Grows the running guest's root filesystem to fill its (grown) disk, while
 *  mounted. resize2fs can't: the kernel mounts the root as /dev/root, so it
 *  doesn't see /dev/vda as mounted and refuses an exclusive open. This is the
 *  ioctl resize2fs itself uses online (EXT4_IOC_RESIZE_FS). */
export declare const GROW_ROOT_FS: string;
/** Stops the VM and keeps its root disk as the image in `dir`, moving any
 *  image there now aside as the previous one. */
export declare function keep(iso: Pick<Isolation, 'exec' | 'close'>, dir: string, meta: object, opts?: {
    previous?: boolean;
}): Promise<string>;
/** The agent's image: from the cache, or built now. */
export declare function agentImage(o: {
    configDir: string;
    vm: VmConfig;
    packages: string[];
    log?: (line: string) => void;
}): Promise<string>;
/** The packages a dry-run `apt-get -s upgrade` would upgrade. */
export declare function upgradesIn(lines: string[]): string[];
/** Boots the agent's image and upgrades it in place when apt has anything
 *  newer; the image before stays as the previous one. */
export declare function updateImage(o: {
    configDir: string;
    vm: VmConfig;
    packages: string[];
    log?: (line: string) => void;
}): Promise<{
    rootfs: string;
    upgraded: string[];
}>;
export interface ListedImage {
    key: string;
    packages: string[];
    /** Built on the base this mirab boots now; otherwise it is never used again. */
    current: boolean;
    /** When it was built, updated or booted last. */
    usedAt: Date;
    bytes: number;
}
/** Every cached agent image, newest use first. */
export declare function listImages(configDir: string, currentBase: string): Promise<ListedImage[]>;
/**
 * What `mirab image prune` removes: images built on a base this mirab no
 * longer boots (after an upgrade they are never used again), images unused
 * for `days` (at least one), and what a build left behind a day or more ago:
 * scratch and an image directory that never got as far as its meta.json. An
 * image used in the last hour always stays, and a VM boots from its own copy,
 * so a running one is never touched. One that can't be removed is reported,
 * and the rest go on.
 */
export declare function pruneImages(o: {
    configDir: string;
    currentBase: string;
    days: number;
    dryRun?: boolean;
    now?: Date;
}): Promise<{
    removed: {
        key: string;
        why: string;
        bytes: number;
    }[];
    failed: {
        key: string;
        error: string;
    }[];
}>;
