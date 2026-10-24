// `mirab init`: make an agent folder. It never writes a .env and never
// overwrites a file; model access comes from harar, not from the project.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { MODEL, agentNameProblem } from './define'

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5-5'

/** The folders an agent may fill, one capability each. */
export const AGENT_FOLDERS = [
  'tools',
  'skills',
  'subagents',
  'schedules',
  'channels',
] as const

export interface InitResult {
  /** Files written, relative to the project. */
  written: string[]
  /** Something init skipped and the person should know about. */
  notes: string[]
}

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
  if (!lstatSync(directory).isDirectory()) return `${directory} isn't a folder`
  // lstat, so a dangling symlink named agent counts as taken too.
  if (lstatSync(join(directory, 'agent'), { throwIfNoEntry: false }))
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

/** Makes the project. Everything is checked before anything is written, so a
 *  refusal leaves the folder as it was. */
export async function initAgent(options: InitOptions): Promise<InitResult> {
  const name = options.name.trim()
  const problem = agentNameProblem(name)
  if (problem) throw new Error(`The agent name ${problem}`)
  const model = options.model ?? DEFAULT_MODEL
  if (!MODEL.test(model))
    throw new Error(
      `The model is provider/model, like ${DEFAULT_MODEL}: ${JSON.stringify(model)}`,
    )
  const directory = resolve(options.directory)
  const taken = initProblem(directory)
  if (taken) throw new Error(taken)
  const files: Record<string, string> = agentFiles(name, model)
  // An existing .gitignore is kept and gets only the lines it lacks.
  const gitignore = join(directory, '.gitignore')
  let ignoreAdd: string | undefined
  if (existsSync(gitignore)) {
    const have = new Set(
      readFileSync(gitignore, 'utf8')
        .split('\n')
        .map((l) => l.trim()),
    )
    const missing = files['.gitignore']
      .split('\n')
      .filter((l) => l && !have.has(l))
    if (missing.length) ignoreAdd = missing.join('\n') + '\n'
    delete files['.gitignore']
  }
  const clash = Object.keys(files).find((path) =>
    lstatSync(join(directory, path), { throwIfNoEntry: false }),
  )
  if (clash)
    throw new Error(
      `${join(directory, clash)} already exists; nothing was written`,
    )
  await mkdir(directory, { recursive: true })
  const result: InitResult = { written: [], notes: [] }
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path)
    await mkdir(join(target, '..'), { recursive: true })
    // `wx`: never overwrite, even a file that appeared since the check.
    await writeFile(target, contents, { flag: 'wx' })
    result.written.push(path)
  }
  if (ignoreAdd) {
    await appendFile(gitignore, ignoreAdd)
    result.written.push('.gitignore (added lines)')
  }
  if (options.git !== false) {
    // Never a repository inside another one.
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: directory,
      encoding: 'utf8',
    })
    if (inside.status === 0 && inside.stdout.trim() === 'true')
      result.notes.push('Already inside a git repository, so no git init.')
    else if (spawnSync('git', ['init', '-q'], { cwd: directory }).status !== 0)
      result.notes.push(
        `git init didn't work in ${basename(directory)}; the agent is made, run it yourself.`,
      )
  }
  return result
}
