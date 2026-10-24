import { expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { agentNameProblem, defineAgent } from './define'
import { spawnSync } from 'node:child_process'
import {
  AGENT_FOLDERS,
  DEFAULT_MODEL,
  agentFiles,
  initAgent,
  initProblem,
} from './init'

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
    'gg.app.agent.ops', // app and channel are reserved too (harar section 3b)
    'gg.channel.agent.ops',
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
    const made = await initAgent({
      directory: dir,
      name: ' gg.addis.agent.ops ',
      git: false,
    })
    expect(made.written).toContain('agent/agent.ts')
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
    // An existing .gitignore is kept; it only gains the lines it lacks.
    const ignored = join(root, 'ignored')
    await mkdir(ignored)
    await writeFile(join(ignored, '.gitignore'), 'keep me\n.env\n')
    await initAgent({
      directory: ignored,
      name: 'gg.addis.agent.ops',
      git: false,
    })
    expect(readFileSync(join(ignored, '.gitignore'), 'utf8')).toBe(
      'keep me\n.env\nnode_modules/\n.env.*\n',
    )
    // A refusal writes nothing: a clash found up front leaves the folder as it was.
    const clash = join(root, 'clash')
    await mkdir(clash)
    await writeFile(join(clash, '.gitkeep-me'), '')
    await mkdir(join(clash, '.hidden'))
    const before = readdirSync(clash).sort()
    await expect(
      initAgent({
        directory: clash,
        name: 'gg.addis.agent.ops',
        model: "x'; evil()//",
        git: false,
      }),
    ).rejects.toThrow('provider/model')
    expect(readdirSync(clash).sort()).toEqual(before)
    // A file that isn't a folder is refused plainly.
    await writeFile(join(root, 'afile'), '')
    expect(initProblem(join(root, 'afile'))).toContain("isn't a folder")
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
    // An option alone, or a mistyped command, never makes an agent.
    expect((await cli(empty, ['--config-dir', join(root, 'cfg')])).code).toBe(0)
    const typo = await cli(empty, ['spwn'])
    expect(typo.code).not.toBe(0)
    expect(readdirSync(empty)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the files init writes are an agent defineAgent accepts', () => {
  const files = agentFiles('gg.addis.agent.ops')
  const source = files['agent/agent.ts']
  const name = source.match(/name: '([^']+)'/)![1]
  const model = source.match(/model: '([^']+)'/)![1]
  expect(defineAgent({ name, model })).toEqual({
    name: 'gg.addis.agent.ops',
    model: DEFAULT_MODEL,
  })
  expect(JSON.parse(files['package.json']).dependencies.mirab).toBe(
    'github:addiscorp/mirab',
  )
})

test('git: a new repository, but never one inside another', async () => {
  const root = await scratch()
  // The scratch folder sits inside this checkout: stop git looking above it.
  const ceiling = process.env.GIT_CEILING_DIRECTORIES
  process.env.GIT_CEILING_DIRECTORIES = root
  try {
    const alone = join(root, 'alone')
    const made = await initAgent({
      directory: alone,
      name: 'gg.addis.agent.ops',
    })
    expect(existsSync(join(alone, '.git'))).toBe(true)
    expect(made.notes).toEqual([])
    // Inside that repository, a second agent folder gets no repository of its own.
    const inner = join(alone, 'tools-agent')
    const nested = await initAgent({
      directory: inner,
      name: 'gg.addis.agent.helper',
    })
    expect(existsSync(join(inner, '.git'))).toBe(false)
    expect(nested.notes[0]).toContain('inside a git repository')
    expect(
      spawnSync('git', ['-C', alone, 'status', '--porcelain']).status,
    ).toBe(0)
  } finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
    else process.env.GIT_CEILING_DIRECTORIES = ceiling
    await rm(root, { recursive: true, force: true })
  }
})
