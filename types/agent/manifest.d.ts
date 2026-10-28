import { z } from 'zod';
import { type Tool } from './define';
/** A TypeScript tool, `agent/<file>`, run by the agent loop. */
export declare const typescriptToolSchema: z.ZodObject<{
    description: z.ZodString;
    file: z.ZodString;
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strict>;
export declare const manifestSchema: z.ZodObject<{
    name: z.ZodString;
    model: z.ZodString;
    instructions: z.ZodString;
    tools: z.ZodPipe<z.ZodUnknown, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodObject<{
        description: z.ZodString;
        file: z.ZodString;
        input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>, z.ZodObject<{
        description: z.ZodString;
        command: z.ZodString;
        args: z.ZodOptional<z.ZodArray<z.ZodString>>;
        input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>]>>>;
    packages: z.ZodArray<z.ZodString>;
    domains: z.ZodArray<z.ZodString>;
    channels: z.ZodArray<z.ZodString>;
    gateway: z.ZodDefault<z.ZodObject<{
        rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
            host: z.ZodString;
            method: z.ZodOptional<z.ZodString>;
            path: z.ZodOptional<z.ZodString>;
            effect: z.ZodEnum<{
                apply: "apply";
                forbidden: "forbidden";
                request: "request";
            }>;
        }, z.core.$strict>>>;
        secrets: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            agent: z.ZodString;
            approved: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Manifest = z.infer<typeof manifestSchema>;
/** Checks manifest data from anywhere (agent.ts, `nix eval --json`). */
export declare function parseManifest(data: unknown, from: string): Manifest;
export interface LoadedManifest {
    manifest: Manifest;
    /** The TypeScript tools as their files export them, by name. */
    typescript: Record<string, Tool<z.ZodType>>;
}
/** Reads `<project>/agent` (agent.ts, instructions.md, tools/*.ts) into a manifest. */
export declare function loadManifest(project: string): Promise<LoadedManifest>;
