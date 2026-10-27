import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defineAgent, domainProblem } from './define'
import { loadManifest, parseManifest } from './manifest'

const search = {
  description: 'Search the workspace',
  command: 'rg',
  args: ['--json'],
  input: {
    type: 'object',
    properties: { pattern: { type: 'string' } },
    required: ['pattern'],
  },
}

/** An agent folder with a TypeScript tool, a command tool and the rest of the manifest. */
async function project(agent?: string) {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(join(resolve('.tmp'), 'manifest-'))
  await mkdir(join(root, 'agent/tools'), { recursive: true })
  await writeFile(
    join(root, 'agent/agent.ts'),
    agent ??
      `import { defineAgent } from 'mirab'
export default defineAgent({
  name: 'gg.addis.agent.ops',
  model: 'anthropic/claude-sonnet-5-5',
  tools: { search: ${JSON.stringify(search)} },
  packages: ['ripgrep', 'git'],
  domains: ['api.github.com', '*.npmjs.org'],
  channels: ['gg.addis.channel.ops'],
})
`,
  )
  await writeFile(join(root, 'agent/instructions.md'), 'You run ops.\n')
  await writeFile(
    join(root, 'agent/tools/add.ts'),
    "import { defineTool } from 'mirab/tools'\nimport { z } from 'zod'\nexport default defineTool({ description: 'Add two numbers.', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => ({ sum: a + b }) })\n",
  )
  return root
}

const expected = {
  name: 'gg.addis.agent.ops',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'You run ops.\n',
  tools: {
    search,
    add: {
      description: 'Add two numbers.',
      file: 'tools/add.ts',
      input: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
  },
  packages: ['ripgrep', 'git'],
  domains: ['api.github.com', '*.npmjs.org'],
  channels: ['gg.addis.channel.ops'],
  gateway: {},
}

test('an agent folder becomes one manifest: plain JSON that checks again as it is', async () => {
  const root = await project()
  try {
    const { manifest, typescript } = await loadManifest(root)
    expect(manifest).toEqual(expected)
    expect(Object.keys(typescript)).toEqual(['add'])
    // What `mirab manifest` prints, and a Nix flake would give, parses back unchanged.
    const json = JSON.parse(JSON.stringify(manifest))
    expect(parseManifest(json, 'json')).toEqual(expected)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// The agent's code runs in its own VM, never on this machine: a live test.
const vmConfig = process.env.TEST_VM_CONFIG_DIR
test.skipIf(!vmConfig)(
  'mirab manifest prints the manifest as JSON, read in a VM',
  async () => {
    const root = await project()
    try {
      const run = spawnSync(
        'bun',
        [resolve('src/mirab.ts'), '--config-dir', vmConfig!, 'manifest', root],
        { encoding: 'utf8' },
      )
      expect(run.status).toBe(0)
      // Never approved here: looking approves nothing; what it asks for waits.
      expect(JSON.parse(run.stdout)).toEqual({
        ...expected,
        domains: [],
        packages: [],
        pending: {
          domains: [...expected.domains].sort(),
          packages: [...expected.packages].sort(),
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)

test('mirab manifest approve with nothing waiting says so', async () => {
  const root = await project()
  try {
    const run = spawnSync(
      'bun',
      [
        resolve('src/mirab.ts'),
        '--config-dir',
        root,
        'manifest',
        'approve',
        root,
      ],
      { encoding: 'utf8' },
    )
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('nothing is waiting')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an agent with nothing but a name and model has empty lists, not missing ones', async () => {
  const root = await project(
    "import { defineAgent } from 'mirab'\nexport default defineAgent({ name: 'gg.addis.agent.bare', model: 'anthropic/claude-sonnet-5-5' })\n",
  )
  try {
    const { manifest } = await loadManifest(root)
    expect(manifest.packages).toEqual([])
    expect(manifest.domains).toEqual([])
    expect(manifest.channels).toEqual([])
    expect(Object.keys(manifest.tools)).toEqual(['add'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a command tool and a tool file with one name is refused', async () => {
  const root = await project(
    `import { defineAgent } from 'mirab'\nexport default defineAgent({ name: 'gg.addis.agent.clash', model: 'anthropic/x', tools: { add: ${JSON.stringify(search)} } })\n`,
  )
  try {
    await expect(loadManifest(root)).rejects.toThrow('one name, one tool')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const base = { name: 'gg.addis.agent.ops', model: 'anthropic/x' }

test('the whitelist takes names the station can match, never an address or a bare suffix', () => {
  for (const ok of ['api.github.com', '*.github.com', 'registry.npmjs.org'])
    expect(domainProblem(ok)).toBeNull()
  for (const bad of [
    'com',
    '*.com',
    '*',
    '*.*.github.com',
    'API.github.com',
    'github.com.',
    '1.2.3.4',
    '127.0.0x1',
    '1.0x7f',
    '[::1]',
    'api.github.com:443',
    'https://api.github.com',
    'a..com',
  ])
    expect([bad, domainProblem(bad)]).not.toEqual([bad, null])
  expect(() => defineAgent({ ...base, domains: ['*.com'] })).toThrow('domain')
})

test('channels are harar channel names; packages are names', () => {
  expect(() =>
    defineAgent({ ...base, channels: ['gg.addis.channel.ops'] }),
  ).not.toThrow()
  for (const bad of ['gg.addis.agent.ops', 'ops', 'gg.channel.ops'])
    expect(() => defineAgent({ ...base, channels: [bad] })).toThrow('channel')
  expect(() => defineAgent({ ...base, packages: ['rip grep'] })).toThrow(
    'package',
  )
  expect(() => defineAgent({ ...base, packages: ['-rf'] })).toThrow('package')
})

test("a command tool needs a description and an object schema mirab can check, and nothing it doesn't know", () => {
  const tool = (t: object) => () =>
    defineAgent({ ...base, tools: { t: { ...search, ...t } as any } })
  expect(tool({})).not.toThrow()
  expect(tool({ description: ' ' })).toThrow('description')
  expect(tool({ input: { type: 'string' } })).toThrow('a JSON Schema with type')
  expect(
    tool({
      input: {
        type: 'object',
        properties: { a: { $ref: 'https://example.com/s.json' } },
      },
    }),
  ).toThrow("can't be checked")
  expect(tool({ env: { TOKEN: 'x' } })).toThrow()
  expect(() =>
    defineAgent({ ...base, tools: { 'bad name': search } as any }),
  ).toThrow("a tool's name")
})

test('a tool named __proto__ is refused, never silently dropped', async () => {
  // As plain data (a Nix flake's JSON), __proto__ is a key; zod would drop it.
  const data = JSON.parse(
    JSON.stringify({ ...expected, tools: {} }).replace(
      '"tools":{}',
      `"tools":{"__proto__":${JSON.stringify(search)}}`,
    ),
  )
  expect(Object.keys(data.tools)).toEqual(['__proto__'])
  expect(() => parseManifest(data, 'json')).toThrow('__proto__')
  const root = await project()
  try {
    await writeFile(
      join(root, 'agent/tools/__proto__.ts'),
      "import { defineTool } from 'mirab/tools'\nimport { z } from 'zod'\nexport default defineTool({ description: 'x', inputSchema: z.object({}), execute: () => 1 })\n",
    )
    await expect(loadManifest(root)).rejects.toThrow('__proto__')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a manifest with a field mirab has no rule for is refused', () => {
  expect(() =>
    parseManifest({ ...expected, env: { TOKEN: 'x' } }, 'flake.nix'),
  ).toThrow('flake.nix')
  const { channels: _, ...missing } = expected
  expect(() => parseManifest(missing, 'flake.nix')).toThrow('channels')
})

test('a TypeScript tool whose input is not a z.object says so', async () => {
  const root = await project()
  try {
    await writeFile(
      join(root, 'agent/tools/add.ts'),
      "import { defineTool } from 'mirab/tools'\nimport { z } from 'zod'\nexport default defineTool({ description: 'x', inputSchema: z.object({ a: z.string() }).transform((v) => v.a), execute: () => 1 })\n",
    )
    await expect(loadManifest(root)).rejects.toThrow(
      'inputSchema is a z.object',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a project's own node_modules/mirab never stands in for mirab", async () => {
  const root = await project(
    "import { defineAgent } from 'mirab'\nexport default defineAgent({ name: 'gg.addis.agent.ops', model: 'anthropic/claude-sonnet-5-5' })\n",
  )
  try {
    // Its own package, so 'mirab' isn't the repo's self-reference.
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'proj', type: 'module' }),
    )
    await mkdir(join(root, 'node_modules/mirab'), { recursive: true })
    await writeFile(
      join(root, 'node_modules/mirab/package.json'),
      JSON.stringify({ name: 'mirab', type: 'module', main: 'index.js' }),
    )
    await writeFile(
      join(root, 'node_modules/mirab/index.js'),
      "export const defineAgent = () => ({ name: 'gg.evil.agent.x', model: 'anthropic/x' })\n",
    )
    expect((await loadManifest(root)).manifest.name).toBe('gg.addis.agent.ops')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an agent's gateway section: rixse's rules and keys, checked for shape", () => {
  const base = {
    name: 'gg.addis.agent.ops',
    model: 'anthropic/claude-sonnet-5-5',
  }
  const gateway = {
    rules: [
      {
        host: 'github.com',
        method: 'POST',
        path: '/acme/repo.git/git-receive-pack',
        effect: 'apply' as const,
      },
      { host: '*.stripe.com', effect: 'request' as const },
    ],
    secrets: {
      'api.stripe.com': {
        agent: 'prod/shop/READ',
        approved: 'prod/shop/WRITE',
      },
    },
  }
  expect(defineAgent({ ...base, gateway }).gateway).toEqual(gateway)
  for (const bad of [
    { rules: [{ host: 'github.com', effect: 'allow' }] },
    { rules: [{ host: '127.0.0.1', effect: 'apply' }] },
    { rules: [{ host: 'github.com', path: 'repo', effect: 'apply' }] },
    { rules: [{ host: 'github.com', effect: 'apply', why: 'x' }] },
    { secrets: { 'api.stripe.com': { agent: 'prod/../admin' } } },
    // What a terminal can't show as itself: it could hide a rule being approved.
    { rules: [{ host: 'github.com', path: '/x\r       ', effect: 'apply' }] },
    { rules: [{ host: 'github.com', path: '/x\u202e', effect: 'apply' }] },
    { secrets: { 'api.stripe.com': { agent: 'prod/shop/READ\u001b[2K' } } },
    { routes: {} },
  ])
    expect(() => defineAgent({ ...base, gateway: bad } as never)).toThrow()
})
