import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { approvePending, pendingReach, withinApproval } from './approved'
import type { Manifest } from './manifest'

const manifest = (domains: string[], packages: string[]) =>
  ({
    name: 'gg.addis.agent.ops',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: '',
    tools: {},
    domains,
    packages,
    channels: [],
  }) as unknown as Manifest

test("whatever changed the agent's definition, what it newly asks to reach waits for the person", () => {
  mkdirSync(resolve('.tmp'), { recursive: true })
  const configDir = mkdtempSync(join(resolve('.tmp'), 'approved-'))
  const project = join(configDir, 'project')
  const logs: string[] = []
  const log = (l: string) => void logs.push(l)
  try {
    // The person starting it the first time: what it asks for is approved.
    const first = withinApproval(
      configDir,
      project,
      manifest(['api.example.com'], ['jq']),
      log,
    )
    expect(first.domains).toEqual(['api.example.com'])
    expect(logs.join('\n')).toContain('first run here')
    // Later its code asks for more (in the VM, an import, package.json: it
    // doesn't matter how): the new reach is left out, and said.
    const wider = withinApproval(
      configDir,
      project,
      manifest(['api.example.com', 'evil.example.com'], ['jq', 'nmap']),
      log,
    )
    expect(wider.domains).toEqual(['api.example.com'])
    expect(wider.packages).toEqual(['jq'])
    expect(logs.at(-1)).toContain('domains evil.example.com and packages nmap')
    expect(pendingReach(configDir, project)?.domains).toContain(
      'evil.example.com',
    )
    // Narrowing needs nothing.
    expect(
      withinApproval(configDir, project, manifest([], []), log).domains,
    ).toEqual([])
    // The person's yes, outside the VM: then it's in effect.
    expect(approvePending(configDir, project)?.packages).toEqual(['jq', 'nmap'])
    expect(pendingReach(configDir, project)).toBeUndefined()
    expect(approvePending(configDir, project)).toBeUndefined()
    const after = withinApproval(
      configDir,
      project,
      manifest(['api.example.com', 'evil.example.com'], ['jq', 'nmap']),
      log,
    )
    expect(after.domains).toEqual(['api.example.com', 'evil.example.com'])
    // Another project's approval is its own.
    expect(
      withinApproval(
        configDir,
        join(configDir, 'other'),
        manifest(['x.example.com'], []),
        log,
      ).domains,
    ).toEqual(['x.example.com'])
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})
