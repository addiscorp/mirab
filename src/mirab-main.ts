import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import pkg from '../package.json'
import { profileCommands } from './agent-profiles'
import { DEFAULT_MODEL, initAgent, initProblem } from './agent/init'
import { agentNameProblem } from './agent/define'
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

const manifestCmd = program
  .command('manifest')
  .description(
    "the agent's manifest: what it asks to reach, and what you approved",
  )

manifestCmd
  .command('show [project]', { isDefault: true })
  .description(
    "the manifest, read from the agent's code in its own VM (never run on this machine), within what you approved",
  )
  .action(async (project: string | undefined) => {
    const configDir =
      program.opts().configDir ?? join(homedir(), '.config', 'mirab')
    const { agentManifest } = await import('./dev')
    const { pendingReach } = await import('./agent/approved')
    const log = (line: string) => console.error(line)
    const { manifest } = await agentManifest({
      project: project ?? '.',
      configDir,
      log,
    })
    const pending = pendingReach(configDir, resolve(project ?? '.'))
    console.log(
      JSON.stringify(pending ? { ...manifest, pending } : manifest, null, 2),
    )
  })

manifestCmd
  .command('approve [project]')
  .description(
    "approve what the agent's definition asks for beyond what you approved (run it here, never in the agent's VM)",
  )
  .option('--yes', 'approve without asking (no terminal to ask on)')
  .action(async (project: string | undefined, opts: { yes?: boolean }) => {
    const configDir =
      program.opts().configDir ?? join(homedir(), '.config', 'mirab')
    const { approvedReach, approvePending, beyond, describe, pendingReach } =
      await import('./agent/approved')
    const root = resolve(project ?? '.')
    const shown = pendingReach(configDir, root)
    if (!shown) {
      console.error(
        'mirab manifest approve: nothing is waiting (mirab dev or mirab manifest shows what the agent asks for)',
      )
      process.exitCode = 1
      return
    }
    const now = approvedReach(configDir, root) ?? { domains: [], packages: [] }
    console.error(`The agent here asks for ${describe(beyond(now, shown))}.`)
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        console.error('mirab manifest approve: no terminal to ask on; --yes')
        process.exitCode = 2
        return
      }
      const { createInterface } = await import('node:readline/promises')
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      })
      const answer = await rl.question('Approve? [y/N] ')
      rl.close()
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.error('Not approved; it stays left out.')
        return
      }
    }
    const approved = approvePending(configDir, root, shown)
    console.log(JSON.stringify({ approved }, null, 2))
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
  .command('list')
  .description('the agent images cached on this machine')
  .action(async () => {
    const configDir =
      program.opts().configDir ?? join(homedir(), '.config', 'mirab')
    const { requireVm } = await import('./spawn-vm')
    const { baseId, listImages } = await import('./images')
    const vm = await requireVm(configDir, (line) => console.error(line))
    const images = await listImages(configDir, await baseId(vm.rootfs))
    console.log(
      JSON.stringify(
        images.map((i) => ({ ...i, usedAt: i.usedAt.toISOString() })),
        null,
        2,
      ),
    )
  })

imageCmd
  .command('prune')
  .description(
    'remove images built on an older base, unused ones, and what stopped builds left',
  )
  .option('--days <n>', 'how long unused before an image goes', '30')
  .option('--dry-run', 'say what would go, remove nothing')
  .action(async (options: { days: string; dryRun?: boolean }) => {
    const days = /^[1-9][0-9]*$/.test(options.days) ? Number(options.days) : NaN
    if (!Number.isInteger(days)) {
      console.error(
        'mirab image prune: --days is a whole number of days, at least 1',
      )
      process.exitCode = 2
      return
    }
    const configDir =
      program.opts().configDir ?? join(homedir(), '.config', 'mirab')
    const { requireVm } = await import('./spawn-vm')
    const { baseId, pruneImages } = await import('./images')
    const vm = await requireVm(configDir, (line) => console.error(line))
    const { removed, failed } = await pruneImages({
      configDir,
      currentBase: await baseId(vm.rootfs),
      days,
      dryRun: options.dryRun,
    })
    const freed = removed.reduce((sum, r) => sum + r.bytes, 0)
    console.log(
      JSON.stringify(
        {
          removed,
          failed,
          freedBytes: freed,
          dryRun: Boolean(options.dryRun),
        },
        null,
        2,
      ),
    )
    if (failed.length) process.exitCode = 1
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

// ---------- escalations: what agents asked for, and a person's answer ----------

const configDirOf = () =>
  program.opts().configDir ?? join(homedir(), '.config', 'mirab')

/** The agent whose ask `host` is: the one given, or the only one that asked. */
async function askFor(host: string, agent?: string) {
  const { asks } = await import('./station/escalations')
  if (agent) return agent
  const askers = asks(configDirOf()).filter((ask) => ask.host === host)
  if (askers.length === 1) return askers[0].agent
  throw Error(
    askers.length
      ? `${host} was asked for by ${askers.map((a) => a.agent).join(', ')}: say which with --agent`
      : `nothing asked for ${host}; give --agent to allow it anyway`,
  )
}

program
  .command('escalations')
  .description(
    'hosts agents asked for that their whitelist refused, most asked first',
  )
  .action(async () => {
    const { asks } = await import('./station/escalations')
    const shown = asks(configDirOf()).map((ask) => ({
      ...ask,
      host: ask.host.length > 80 ? `${ask.host.slice(0, 77)}...` : ask.host,
      // Punycode can look like a familiar name once a browser shows it.
      ...(ask.host.split('.').some((label) => label.startsWith('xn--'))
        ? { warning: 'punycode name: check what it spells' }
        : {}),
    }))
    console.log(JSON.stringify(shown, null, 2))
  })

const hostArg = (host: string) => host.toLowerCase().replace(/\.$/, '')

program
  .command('allow <host>')
  .description(
    "let an agent reach a host it asked for (run it here, never in the agent's VM; quote wildcards: '*.example.com')",
  )
  .option('--agent <name>', 'whose ask: an agent name, or project:<path>')
  .action(async (host: string, opts: { agent?: string }) => {
    const { allow, allowPath } = await import('./station/escalations')
    const name = hostArg(host)
    const agent = await askFor(name, opts.agent)
    allow(configDirOf(), agent, name)
    console.log(
      `${agent} may now reach ${name}, for every session it runs (${allowPath(configDirOf(), agent)}); mirab revoke ${name} takes it back. To keep it in git, add '${name}' to domains in agent/agent.ts`,
    )
  })

program
  .command('dismiss <host>')
  .description('say no to an ask: it is dropped, and the host stays refused')
  .option('--agent <name>', 'whose ask: an agent name, or project:<path>')
  .action(async (host: string, opts: { agent?: string }) => {
    const { dismiss } = await import('./station/escalations')
    const name = hostArg(host)
    const agent = await askFor(name, opts.agent)
    dismiss(configDirOf(), agent, name)
    console.log(`dismissed ${agent}'s ask for ${name}`)
  })

program
  .command('revoke <host>')
  .description(
    'take back a yes: the host is refused again from the next connection',
  )
  .requiredOption(
    '--agent <name>',
    'whose grant: an agent name, or project:<path>',
  )
  .action(async (host: string, opts: { agent: string }) => {
    const { revoke } = await import('./station/escalations')
    revoke(configDirOf(), opts.agent, hostArg(host))
    console.log(`${opts.agent} may no longer reach ${hostArg(host)}`)
  })

const secretsCmd = program
  .command('secrets')
  .description(
    "which of your harar secrets an agent may use (a project's .env only names them); harar says where each may go",
  )

secretsCmd
  .command('allow <secret>')
  .description(
    "let an agent use a harar secret (run it here, never in the agent's VM)",
  )
  .option('--agent <name>', 'whose: project:<path> (default: the project here)')
  .action(async (secret: string, opts: { agent?: string }) => {
    const { allowSecret, projectAgent, secretsPath } =
      await import('./station/escalations')
    const agent = opts.agent ?? projectAgent('.')
    try {
      allowSecret(configDirOf(), agent, secret)
    } catch (e) {
      console.error(`mirab secrets allow: ${(e as Error).message}`)
      process.exitCode = 2
      return
    }
    console.log(
      `${agent} may now use harar://${secret} (${secretsPath(configDirOf(), agent)}), on the hosts harar allows it: harar hosts list ${secret}`,
    )
  })

secretsCmd
  .command('revoke <secret>')
  .description('take back a secret from an agent, from its next session')
  .option('--agent <name>', 'whose: project:<path> (default: the project here)')
  .action(async (secret: string, opts: { agent?: string }) => {
    const { projectAgent, revokeSecret } = await import('./station/escalations')
    const agent = opts.agent ?? projectAgent('.')
    try {
      revokeSecret(configDirOf(), agent, secret)
    } catch (e) {
      console.error(`mirab secrets revoke: ${(e as Error).message}`)
      process.exitCode = 1
      return
    }
    console.log(`${agent} may no longer use harar://${secret}`)
  })

secretsCmd
  .command('list')
  .description('the secrets an agent may use')
  .option('--agent <name>', 'whose: project:<path> (default: the project here)')
  .action(async (opts: { agent?: string }) => {
    const { projectAgent, secretGrants } = await import('./station/escalations')
    const agent = opts.agent ?? projectAgent('.')
    console.log(
      JSON.stringify(
        { agent, secrets: secretGrants(configDirOf(), agent) },
        null,
        2,
      ),
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
