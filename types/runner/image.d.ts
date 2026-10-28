import type { VmConfig } from '../isolation';
import { type RunnerDefinition, type RunnerPlatform, type RunnerStep } from './define';
import { type Fetcher, type ResolvedTool } from './toolsets';
export declare const runnerImagesDir: (configDir: string) => string;
export interface RunnerImageMeta {
    key: string;
    platform: RunnerPlatform;
    forge: {
        name: string;
        key: string;
    };
    tools: ResolvedTool[];
    packages: string[];
    diskGiB: number;
    /** The toolsets' env, and PATH entries to put first, for every job. */
    env: Record<string, string>;
    path: string[];
    builtAt: string;
}
export interface RunnerImage {
    rootfs: string;
    meta: RunnerImageMeta;
}
export interface RunnerRecipe {
    platform: RunnerPlatform;
    forge: {
        name: string;
        key: string;
        steps: RunnerStep[];
        egress: string[];
    };
    tools: ResolvedTool[];
    packages: string[];
    diskGiB: number;
}
/** Everything that decides an image, resolved: the key is the hash of it. */
export declare function runnerRecipe(def: RunnerDefinition, o?: {
    platform?: RunnerPlatform;
    fetch?: Fetcher;
}): Promise<RunnerRecipe>;
export declare function runnerImageKey(base: string, r: RunnerRecipe): string;
/** The build, as root in the build VM, in order. */
export declare function buildSteps(r: RunnerRecipe): RunnerStep[];
/** The cached image for `r`, if it was built on this base. */
export declare function cachedRunnerImage(configDir: string, key: string): Promise<RunnerImage | undefined>;
/** The runner's image: from the cache, or built now (a few minutes). */
export declare function runnerImage(o: {
    configDir: string;
    vm: VmConfig;
    recipe: RunnerRecipe;
    log?: (line: string) => void;
}): Promise<RunnerImage>;
