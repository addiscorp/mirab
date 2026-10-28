import type { RunnerPlatform, RunnerStep } from './define';
export declare const TOOL_CACHE = "/opt/hostedtoolcache";
export declare const RUST_HOME = "/opt/rust";
export interface ResolvedTool {
    tool: 'rust' | 'node' | 'go';
    version: string;
    url: string;
    sha256: string;
    /** Hosts the build VM fetches from. */
    hosts: string[];
}
export type Fetcher = (url: string) => Promise<string>;
/** `24` matches 24.x.y, `24.21` matches 24.21.y, `24.21.0` only itself. */
export declare function versionMatches(spec: string, version: string): boolean;
declare const nodeArch: (p: RunnerPlatform) => "arm64" | "x64";
/** The tool cache's arch directory (setup-node and setup-go use these). */
export declare const cacheArch: typeof nodeArch;
export declare function resolveNode(spec: string, platform: RunnerPlatform, get?: Fetcher): Promise<ResolvedTool>;
export declare function resolveGo(spec: string, platform: RunnerPlatform, get?: Fetcher): Promise<ResolvedTool>;
/** Rust: rustup-init (checked by its published sha256) installs the toolchain
 *  `spec`; rustup checks every component it downloads itself. */
export declare function resolveRust(spec: string, platform: RunnerPlatform, get?: Fetcher): Promise<ResolvedTool>;
export declare function resolveTools(tools: {
    rust?: string;
    node?: string;
    go?: string;
}, platform: RunnerPlatform, get?: Fetcher): Promise<ResolvedTool[]>;
/** The build steps (root, in the build VM) for the resolved toolsets. */
export declare function toolSteps(tools: ResolvedTool[], platform: RunnerPlatform): RunnerStep[];
/** What a job's env needs to find the toolsets (merged into the base env). */
export declare function toolEnv(tools: ResolvedTool[], platform: RunnerPlatform): {
    env: Record<string, string>;
    path: string[];
};
export {};
