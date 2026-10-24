import { homedir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import pkg from '../package.json'
import { profileCommands } from './agent-profiles'
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
