import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { shellQuote } from './spawn-adapters/types'

export function mirabInvocation(): string[] {
  return import.meta.url.includes('$bunfs')
    ? [process.execPath]
    : [process.execPath, 'run', new URL('./mirab.ts', import.meta.url).pathname]
}

/** Prefer plain mirab only when PATH selects this exact mirab. */
export function promptMirab(command: string[], path = process.env.PATH ?? '') {
  const target = command.length === 1 ? command[0] : command.at(-1)!
  for (const dir of path.split(delimiter)) {
    const candidate = resolve(
      dir || '.',
      process.platform === 'win32' ? 'mirab.cmd' : 'mirab',
    )
    let real: string
    try {
      accessSync(candidate, constants.X_OK)
      real = realpathSync(candidate)
    } catch {
      continue
    }
    try {
      if (realpathSync(target) === real) return 'mirab'
    } catch {
      /* A broken launcher still shadows ours. */
    }
    break
  }
  return command.map(shellQuote).join(' ')
}
