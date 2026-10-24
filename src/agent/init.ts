// `mirab init`: make an agent folder. It never writes a .env and never
// overwrites a file; model access comes from harar, not from the project.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { agentNameProblem } from './define'

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5-5'

/** The folders an agent may fill, one capability each. */
export const AGENT_FOLDERS = [
  'tools',
  'skills',
  'subagents',
  'schedules',
  'channels',
] as const

export interface InitOptions {
  /** Where the project goes; made if missing. */
  directory: string
  /** The agent's harar name, `<org>.agent.<name>`. */
  name: string
  model?: string
  /** Run `git init` (default true). */
  git?: boolean
}

/** Whether `directory` can take a new agent: missing, empty, or only dotfiles like .git. */
export function initProblem(directory: string): string | null {
  if (!existsSync(directory)) return null
  if (existsSync(join(directory, 'agent')))
    return `${directory} already has an agent/ folder`
  const taken = readdirSync(directory).filter(
    (entry) => !entry.startsWith('.') && entry !== 'README.md',
  )
  return taken.length
    ? `${directory} isn't empty (${taken.slice(0, 3).join(', ')}${taken.length > 3 ? ', …' : ''}); run it in an empty folder`
    : null
}

/** The files an agent starts with, by path relative to the project. */
export function agentFiles(name: string, model = DEFAULT_MODEL) {
  const local = name.split('.').at(-1)!
  return {
    'package.json':
      JSON.stringify(
        {
          name: local,
          private: true,
          type: 'module',
          scripts: { dev: 'mirab dev' },
          // mirab isn't on npm yet; its repository is public.
          dependencies: { mirab: 'github:addiscorp/mirab', zod: '^4.1.12' },
        },
        null,
        2,
      ) + '\n',
    // Never commit a key; mirab never reads one from here either.
    '.gitignore': 'node_modules/\n.env\n.env.*\n',
    'agent/agent.ts': `import { defineAgent } from 'mirab'

export default defineAgent({
  name: '${name}',
  model: '${model}',
})
`,
    'agent/instructions.md': `You are ${local}. Be concise, and use your tools when they help.
`,
    ...Object.fromEntries(
      AGENT_FOLDERS.map((folder) => [`agent/${folder}/.gitkeep`, '']),
    ),
  }
}

/** Makes the project and returns the files written. */
export async function initAgent(options: InitOptions): Promise<string[]> {
  const problem = agentNameProblem(options.name)
  if (problem) throw new Error(`The agent name ${problem}`)
  const directory = resolve(options.directory)
  const taken = initProblem(directory)
  if (taken) throw new Error(taken)
  const files = agentFiles(options.name, options.model)
  await mkdir(directory, { recursive: true })
  const written: string[] = []
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path)
    await mkdir(join(target, '..'), { recursive: true })
    // `wx`: never overwrite, even a file that appeared since the check.
    await writeFile(target, contents, { flag: 'wx' })
    written.push(path)
  }
  if (options.git !== false && !existsSync(join(directory, '.git'))) {
    const git = spawnSync('git', ['init', '-q'], { cwd: directory })
    if (git.status !== 0)
      throw new Error(`git init failed in ${basename(directory)}`)
  }
  return written
}
