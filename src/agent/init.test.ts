import { expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { agentNameProblem, defineAgent } from './define'
import { AGENT_FOLDERS, initAgent, initProblem } from './init'

async function scratch() {
  await mkdir(resolve('.tmp'), { recursive: true })
  return mkdtemp(join(resolve('.tmp'), 'init-'))
}

async function cli(cwd: string, args: string[]) {
  const proc = Bun.spawn(
    [process.execPath, 'run', resolve('src/mirab.ts'), ...args],
    {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, out, err }
}

test("agent names follow harar's rules", () => {
  for (const good of [
    'gg.addis.agent.ops',
    'com.acme.eu.agent.support-1',
    'gg.addis.agent.agent',
  ])
    expect(agentNameProblem(good)).toBeNull()
  for (const bad of [
    'ops',
    'gg.agent.ops', // one-label org
    'gg.addis.service.site', // not an agent
    'gg.addis.agent.ops.extra',
    'gg.addis.agent.Ops',
    'gg.addis.agent.-ops',
    'gg.addis.agent.',
    'gg.human.addis.agent.ops', // a reserved word as an org label
    `gg.addis.agent.${'a'.repeat(64)}`,
    `${'a.'.repeat(130)}agent.ops`,
  ])
    expect(agentNameProblem(bad), bad).not.toBeNull()
  expect(() =>
    defineAgent({ name: 'ops', model: 'anthropic/claude-sonnet-5-5' }),
  ).toThrow()
  expect(() =>
    defineAgent({ name: 'gg.addis.agent.ops', model: 'sonnet' }),
  ).toThrow()
})

test('init makes an eve-shaped agent with no .env, and never overwrites', async () => {
  const root = await scratch()
  try {
    const dir = join(root, 'ops')
    await initAgent({ directory: dir, name: 'gg.addis.agent.ops', git: false })
    expect(readFileSync(join(dir, 'agent/agent.ts'), 'utf8')).toContain(
      "name: 'gg.addis.agent.ops'",
    )
    for (const folder of AGENT_FOLDERS)
      expect(existsSync(join(dir, 'agent', folder))).toBe(true)
    expect(existsSync(join(dir, 'agent/instructions.md'))).toBe(true)
    expect(readdirSync(dir).some((f) => f.startsWith('.env'))).toBe(false)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.env')
    expect(
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name,
    ).toBe('ops')
    // A second run refuses: the folder has an agent now.
    await expect(
      initAgent({ directory: dir, name: 'gg.addis.agent.ops', git: false }),
    ).rejects.toThrow('already has an agent/')
    // A folder with other work in it is refused; dotfiles alone are fine.
    const busy = join(root, 'busy')
    await mkdir(busy)
    await writeFile(join(busy, 'notes.txt'), 'mine')
    expect(initProblem(busy)).toContain("isn't empty")
    const dotted = join(root, 'dotted')
    await mkdir(join(dotted, '.git'), { recursive: true })
    expect(initProblem(dotted)).toBeNull()
    // A file that appears between the check and the write is never replaced.
    const racy = join(root, 'racy')
    await mkdir(racy)
    await writeFile(join(racy, '.gitignore'), 'keep me\n')
    await expect(
      initAgent({ directory: racy, name: 'gg.addis.agent.ops', git: false }),
    ).rejects.toThrow()
    expect(readFileSync(join(racy, '.gitignore'), 'utf8')).toBe('keep me\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the CLI: init with --name, a bare mirab without a terminal, and a typo that makes nothing', async () => {
  const root = await scratch()
  try {
    const made = await cli(root, [
      'init',
      'ops',
      '--name',
      'gg.addis.agent.ops',
      '--no-git',
    ])
    expect(made.code).toBe(0)
    expect(existsSync(join(root, 'ops/agent/agent.ts'))).toBe(true)
    const bad = await cli(root, [
      'init',
      'x',
      '--name',
      'gg.addis.service.x',
      '--no-git',
    ])
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('<org>.agent.<name>')
    expect(existsSync(join(root, 'x'))).toBe(false)
    const empty = join(root, 'empty')
    await mkdir(empty)
    const bare = await cli(empty, [])
    expect(bare.code).toBe(1)
    expect(bare.err).toContain('--name')
    const typo = await cli(empty, ['spwn'])
    expect(typo.code).not.toBe(0)
    expect(readdirSync(empty)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
