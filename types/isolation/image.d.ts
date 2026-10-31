import { z } from 'zod';
/** Where mirab's releases and guest images live. */
export declare const RELEASES = "https://mirab-releases.addis.gg";
export declare const MIRAB_VERSION: string;
/** The release this copy of mirab was installed from (`0.1.0-canary-abc1234`):
 *  the release workflow stamps release.json into what it ships. From a
 *  checkout there is none, and the package version stands in. */
export declare const MIRAB_RELEASE: string;
/** Where the guest kernel, rootfs, (macOS) vz helper and macOS guest agent live, published or
 *  built by `bun run vm:image`; `vm` uses them when isolation.json names no
 *  other files. */
export declare function vmImagePaths(configDir: string): {
    dir: string;
    kernel: string;
    rootfs: string;
    vz: string;
    /** The guest agent macOS guests run (mirab image pull macos installs it). */
    agent: string;
    record: string;
};
/** The VM platforms a release publishes, and the file each role is built as. */
export declare const VM_PLATFORMS: {
    readonly 'linux-x64': {
        readonly kernel: 'vmlinux';
        readonly rootfs: 'rootfs.ext4';
    };
    readonly 'darwin-x64': {
        readonly kernel: 'bzImage';
        readonly rootfs: 'rootfs.ext4';
        readonly vz: 'mirab-vz';
    };
    readonly 'darwin-arm64': {
        readonly kernel: 'Image';
        readonly rootfs: 'rootfs.ext4';
        readonly vz: 'mirab-vz';
        readonly agent: 'mirab-guest-agent';
    };
};
export type VmPlatform = keyof typeof VM_PLATFORMS;
export type VmRole = 'kernel' | 'rootfs' | 'vz' | 'agent';
export declare const vmPlatform: (platform?: string, arch?: string) => VmPlatform | undefined;
declare const entry: z.ZodObject<{
    file: z.ZodString;
    sha256: z.ZodString;
    size: z.ZodNumber;
    unpacked: z.ZodObject<{
        sha256: z.ZodString;
        size: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export type VmFileEntry = z.infer<typeof entry>;
export declare const vmManifestSchema: z.ZodObject<{
    version: z.ZodString;
    protocol: z.ZodNumber;
    commit: z.ZodString;
    platforms: z.ZodObject<{
        'linux-x64': z.ZodOptional<z.ZodObject<{
            kernel: z.ZodObject<{
                file: z.ZodString;
                sha256: z.ZodString;
                size: z.ZodNumber;
                unpacked: z.ZodObject<{
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>;
            rootfs: z.ZodObject<{
                file: z.ZodString;
                sha256: z.ZodString;
                size: z.ZodNumber;
                unpacked: z.ZodObject<{
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>;
        }, z.core.$strip>>;
        'darwin-x64': z.ZodOptional<z.ZodObject<{
            kernel: z.ZodObject<{
                file: z.ZodString;
                sha256: z.ZodString;
                size: z.ZodNumber;
                unpacked: z.ZodObject<{
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>;
            rootfs: z.ZodObject<{
                file: z.ZodString;
                sha256: z.ZodString;
                size: z.ZodNumber;
                unpacked: z.ZodObject<{
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>;
            vz: z.ZodObject<{
                file: z.ZodString;
                sha256: z.ZodString;
                size: z.ZodNumber;
                unpacked: z.ZodObject<{
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>;
        }, z.core.$strip>>;
        'darwin-arm64': z.ZodOptional<z.ZodObject<{
            kernel: z.ZodObject<{
                file: z.ZodString;
                sha256: z.ZodString;
                size: z.ZodNumber;
                unpacked: z.ZodObject<{
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>;
            rootfs: z.ZodObject<{
                file: z.ZodString;
                sha256: z.ZodString;
                size: z.ZodNumber;
                unpacked: z.ZodObject<{
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>;
            vz: z.ZodObject<{
                file: z.ZodString;
                sha256: z.ZodString;
                size: z.ZodNumber;
                unpacked: z.ZodObject<{
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>;
            agent: z.ZodOptional<z.ZodObject<{
                file: z.ZodString;
                sha256: z.ZodString;
                size: z.ZodNumber;
                unpacked: z.ZodObject<{
                    sha256: z.ZodString;
                    size: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type VmManifest = z.infer<typeof vmManifestSchema>;
export declare class VmImageError extends Error {
}
/** What the next tier hint says when no image could be fetched. */
export declare const VM_IMAGE_FALLBACK_HINT = "connect and retry, build the image yourself (docs/VM.md), or use --isolation container|host";
/** The published image for this CLI version and platform is installed and intact (cheap: sizes). */
export declare function releaseImageInstalled(configDir: string, version?: string, platform?: "darwin-arm64" | "darwin-x64" | "linux-x64" | undefined): boolean;
/** `bun run vm:image` (or another hand build) owns <config dir>/vm: never overwrite it. */
export declare const localImageInstalled: (configDir: string) => boolean;
export interface EnsureOptions {
    configDir: string;
    version?: string;
    platform?: VmPlatform;
    /** The release root (cli/ on the bucket); tests point it at a fake. */
    base?: string;
    log?: (line: string) => void;
}
/**
 * Make sure <config dir>/vm holds the published guest image for this mirab
 * version and platform: nothing to do when it is already there (offline is
 * fine), otherwise download, verify and install it. Throws VmImageError with
 * the reason and the fallback when it cannot.
 */
export declare function ensureVmImage(o: EnsureOptions): Promise<'installed' | 'downloaded' | 'local'>;
export {};
