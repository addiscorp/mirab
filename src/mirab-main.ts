import { spawnSync } from 'node:child_process'
import { Command } from 'commander'
import pkg from '../package.json'
import { profileCommands } from './agent-profiles'
import {
  MULTIPASS_VM,
  multipassMissing,
  usesMultipass,
} from './isolation/multipass'
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
  .description('agents in a VM: vz or Multipass on macOS, Firecracker on Linux')

vmCmd
  .command('status')
  .description('the mirab VM: whether it exists and is running')
  .action(async () => {
    if (!usesMultipass()) {
      console.log('On Linux, mirab spawn --vm uses Firecracker; see docs/VM.md')
      return
    }
    const missing = multipassMissing()
    if (missing) return console.log(missing)
    const r = spawnSync(
      'multipass',
      ['info', MULTIPASS_VM, '--format', 'json'],
      { encoding: 'utf8' },
    )
    if (r.status !== 0)
      return console.log(
        'No mirab VM yet. The first mirab spawn --vm makes it.',
      )
    const info = JSON.parse(r.stdout).info?.[MULTIPASS_VM]
    console.log(
      `mirab VM: ${info?.state}${info?.ipv4?.length ? ` (${info.ipv4[0]})` : ''}, Ubuntu ${info?.release ?? ''}`.trim(),
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
