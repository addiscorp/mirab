import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promptMirab } from './invocation'

test('prompts use plain mirab for this source or binary, preserving an explicit command when shadowed', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(resolve('.tmp/invocation-'))
  try {
    const source = join(root, 'mirab.ts'),
      dir = join(root, 'bin')
    await writeFile(source, '#!/usr/bin/env bun\n')
    await chmod(source, 0o755)
    await mkdir(dir)
    await symlink(source, join(dir, 'mirab'))
    expect(promptMirab([process.execPath, 'run', source], dir)).toBe('mirab')
    expect(promptMirab([source], dir)).toBe('mirab')
    const other = join(root, 'other')
    await mkdir(other)
    await writeFile(join(other, 'mirab'), '#!/bin/sh\nexit 0\n')
    await chmod(join(other, 'mirab'), 0o755)
    expect(
      promptMirab([process.execPath, 'run', source], other + ':' + dir),
    ).not.toBe('mirab')
    expect(promptMirab([source], '')).toBe(`'${source}'`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
