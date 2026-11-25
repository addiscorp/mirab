/** The agent loop and everything it needs, as one file for the guest's Bun.
 *  A macro, so a compiled mirab carries it: its own source isn't on disk. */
export function guestLoopSource(): string {
  const result = Bun.spawnSync([
    process.execPath,
    'build',
    new URL('./agent/guest.ts', import.meta.url).pathname,
    '--target=bun',
    '--minify',
  ])
  if (result.exitCode !== 0)
    throw new Error(`the agent loop didn't build: ${result.stderr.toString()}`)
  return result.stdout.toString()
}
