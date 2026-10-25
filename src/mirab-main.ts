import { homedir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import pkg from '../package.json'
import { profileCommands } from './agent-profiles'
import { DEFAULT_MODEL, initAgent, initProblem } from './agent/init'
import { agentNameProblem } from './agent/define'
import { loadManifest } from './agent/manifest'
import { MULTIPASS_UNAVAILABLE, usesMultipass } from './isolation/multipass'
import { localEvents, spawnCommands } from './spawn'

export const program = new Command()
  .enablePositionalOptions()
  .option(
    '--config-dir <path>',
    "mirab's config directory (isolation.json, VM state)",
  )
  .hook('preAction', (_, command) => {
    // One config directory: given before the command, it fills in the
    // command's own --config-dir unless that was given too.
    const global = program.opts().configDir
    if (
      global &&
      command.options.some((option) => option.long === '--config-dir') &&
      command.getOptionValueSource('configDir') !== 'cli'
    )
      command.setOptionValue('configDir', global)
  })
  .name('mirab')
  .description('mirab: agents in VMs on your own machine')
  .version(pkg.version)

// ---------- init: a new agent ----------

/** The agent's harar name: --name, else asked for when there is a terminal. */
async function askName(name?: string): Promise<string> {
  if (name) return name
  if (!process.stdin.isTTY)
    throw Error(
      'Give the agent its harar name: mirab init --name <org>.agent.<name>',
    )
  const { default: inquirer } = await import('inquirer')
  const answer = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message:
        "The agent's harar name (<org>.agent.<name>, like gg.addis.agent.ops):",
      validate: (value: string) => {
        const problem = agentNameProblem(value.trim())
        return problem ? `That name ${problem}` : true
      },
    },
  ])
  return String(answer.name).trim()
}

async function init(
  directory: string,
  opts: { name?: string; model?: string; git?: boolean },
) {
  // Refuse a busy folder before asking anything.
  const taken = initProblem(directory)
  if (taken) throw Error(taken)
  const name = (await askName(opts.name)).trim()
  const { written, notes } = await initAgent({
    directory,
    name,
    model: opts.model,
    git: opts.git,
  })
  console.log(
    `Made ${name} in ${directory}: ${written.filter((f) => !f.endsWith('.gitkeep')).join(', ')}`,
  )
  for (const note of notes) console.log(note)
  console.log('Model access comes from harar, never a .env.')
}

program
  .command('init [directory]')
  .description(
    'make an agent: agent/agent.ts, instructions, tools, skills, channels',
  )
  .option('--name <name>', "the agent's harar name, <org>.agent.<name>")
  .option('--model <model>', 'provider/model', DEFAULT_MODEL)
  .option('--no-git', "don't run git init")
  .action(
    async (
      directory: string | undefined,
      opts: { name?: string; model?: string; git?: boolean },
    ) => {
      await init(directory ?? '.', opts)
    },
  )

program
  .command('manifest [project]')
  .description("the agent's manifest, as JSON: what mirab dev and up read")
  .action(async (project: string | undefined) => {
    const { manifest } = await loadManifest(project ?? '.')
    console.log(JSON.stringify(manifest, null, 2))
  })

program
  .command('dev [project]')
  .description(
    "chat with the project's agent, running in its own VM on this machine",
  )
  .action(async (project: string | undefined) => {
    const configDir =
      program.opts().configDir ?? join(homedir(), '.config', 'mirab')
    const { devInTerminal } = await import('./dev')
    const { loadStationConfig } = await import('./station/config')
    process.exitCode = await devInTerminal({
      project: project ?? '.',
      configDir,
      station: await loadStationConfig(configDir),
      auditLog: join(configDir, 'egress.log'),
      log: (line) => console.error(line),
    })
  })

const imageCmd = program
  .command('image')
  .description("an agent's VM image: its packages, built once and cached")

imageCmd
  .command('build [project]')
  .description("build the agent's image from its packages, unless it's cached")
  .action(async (project: string | undefined) => {
    const configDir =
      program.opts().configDir ?? join(homedir(), '.config', 'mirab')
    const { agentManifest } = await import('./dev')
    const { agentImage } = await import('./images')
    const log = (line: string) => console.error(line)
    const { manifest, vm } = await agentManifest({
      project: project ?? '.',
      configDir,
      log,
    })
    if (!manifest.packages.length)
      return console.log(
        `${manifest.name} has no packages: it runs on the base image`,
      )
    console.log(
      await agentImage({ configDir, vm, packages: manifest.packages, log }),
    )
  })

imageCmd
  .command('update [project]')
  .description(
    "boot the agent's image, and upgrade it if apt has anything newer",
  )
  .action(async (project: string | undefined) => {
    const configDir =
      program.opts().configDir ?? join(homedir(), '.config', 'mirab')
    const { agentManifest } = await import('./dev')
    const { updateImage } = await import('./images')
    const log = (line: string) => console.error(line)
    const { manifest, vm } = await agentManifest({
      project: project ?? '.',
      configDir,
      log,
    })
    if (!manifest.packages.length)
      return console.log(
        `${manifest.name} has no packages: it runs on the base image`,
      )
    const { upgraded } = await updateImage({
      configDir,
      vm,
      packages: manifest.packages,
      log,
    })
    console.log(
      upgraded.length ? `upgraded: ${upgraded.join(' ')}` : 'up to date',
    )
  })

// A bare `mirab`, with nothing else at all, in an empty folder makes an agent;
// anything else here (an option, a mistyped command) never does.
program.action(async () => {
  if (process.argv.length > 2 || initProblem(process.cwd()))
    return program.help()
  await init('.', { model: DEFAULT_MODEL })
})

// ---------- agent: profiles ----------

profileCommands(program.command('agent').description('agent profiles'))

// ---------- spawn (with attach and stop) ----------

spawnCommands(program)

// ---------- vm ----------

const vmCmd = program
  .command('vm')
  .description('agents in a VM: vz on macOS, Firecracker on Linux')

vmCmd
  .command('status')
  .description('which VM backend mirab spawn --vm uses here')
  .action(async () => {
    const configDir =
      program.opts().configDir ?? join(homedir(), '.config', 'mirab')
    if (usesMultipass(configDir)) return console.log(MULTIPASS_UNAVAILABLE)
    console.log(
      process.platform === 'darwin'
        ? 'mirab spawn --vm uses vz (the vm block in isolation.json); see docs/VM.md'
        : 'mirab spawn --vm uses Firecracker; see docs/VM.md',
    )
  })

// ---------- events ----------

program
  .command('events <id>')
  .description("a local agent session's events")
  .action(async (id: string) => {
    await localEvents(id)
  })

export function main() {
  return program.parseAsync().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
