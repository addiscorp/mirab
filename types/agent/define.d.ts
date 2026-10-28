import { z } from 'zod';
/** Why `name` isn't a harar name of `kind` (`<org>.<kind>.<local>`), or null. */
export declare function nameProblem(name: string, kind: 'agent' | 'channel' | 'human', example: string): string | null;
/** Why `name` isn't an agent name (`<org>.agent.<local>`, harar's rules), or null. */
export declare function agentNameProblem(name: string): string | null;
/** Why `name` isn't a human's harar name (`<org>.human.<local>`), or null. */
export declare function humanNameProblem(name: string): string | null;
/** `provider/model`, e.g. `anthropic/claude-sonnet-5-5`. */
export declare const MODEL: RegExp;
/** A tool's name is its file's name, or its key in `tools`; the model sees exactly that. */
export declare const TOOL_NAME: RegExp;
/** Why `name` can't be a tool's name, or null. `__proto__` is refused: as a
 *  key in plain data it is dropped or changes the object, never a tool. */
export declare function toolNameProblem(name: string): string | null;
/** A tool's input: a JSON Schema for an object, which is what models take. */
export declare const toolInput: z.ZodRecord<z.ZodString, z.ZodUnknown>;
/** A tool that is an executable in the VM: the model's input as JSON on its
 *  stdin (checked against `input` first), its answer as JSON on stdout. */
export declare const commandToolSchema: z.ZodObject<{
    description: z.ZodString;
    command: z.ZodString;
    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type CommandTool = z.infer<typeof commandToolSchema>;
/** Tools by name. zod's record drops a `__proto__` key before checking it,
 *  so the raw data is checked for one first. */
export declare function toolRecord<T extends z.ZodType>(tool: T): z.ZodPipe<z.ZodUnknown, z.ZodRecord<z.ZodString, T>>;
/** A whitelist entry as the station matches it: `api.github.com`, or
 *  `*.github.com` for every name under it. Names only, never an address. */
export declare function domainProblem(domain: string): string | null;
/** Characters that can make a terminal show something other than the text:
 *  controls, C1 controls, line separators and bidirectional overrides. A
 *  person approves rules by reading them, so none may appear in one. */
export declare const UNSHOWABLE: RegExp;
/** What agent/agent.ts declares. TypeScript tools are files in agent/tools/;
 *  `tools` here holds command tools. */
export declare const agentSchema: z.ZodObject<{
    name: z.ZodString;
    model: z.ZodString;
    tools: z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodRecord<z.ZodString, z.ZodObject<{
        description: z.ZodString;
        command: z.ZodString;
        args: z.ZodOptional<z.ZodArray<z.ZodString>>;
        input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    packages: z.ZodOptional<z.ZodArray<z.ZodString>>;
    domains: z.ZodOptional<z.ZodArray<z.ZodString>>;
    channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
    gateway: z.ZodOptional<z.ZodObject<{
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
export type Agent = z.infer<typeof agentSchema>;
export declare function defineAgent(agent: Agent): Agent;
export interface Tool<Input extends z.ZodType> {
    description: string;
    inputSchema: Input;
    execute(input: z.infer<Input>): unknown | Promise<unknown>;
}
export declare function defineTool<Input extends z.ZodType>(tool: Tool<Input>): Tool<Input>;
