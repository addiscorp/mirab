import { expect, test } from 'bun:test'
import { devZone, manifestFromGuest } from './dev'
import { MANIFEST_LINE } from './agent/guest'

const manifest = {
  name: 'gg.addis.agent.ops',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: '',
  tools: {},
  packages: [],
  domains: ['api.github.com'],
  channels: [],
}

test("the host reads the VM's manifest only through the schema", () => {
  expect(
    manifestFromGuest(['noise', MANIFEST_LINE + JSON.stringify(manifest)]),
  ).toEqual(manifest)
  expect(() =>
    manifestFromGuest(['error: Cannot find package', 'at agent.ts']),
  ).toThrow("didn't load in its VM: error: Cannot find package")
  expect(() => manifestFromGuest([MANIFEST_LINE + '{'])).toThrow("isn't JSON")
  // What the VM says is untrusted: a field mirab has no rule for, or a bad domain, is refused.
  expect(() =>
    manifestFromGuest([
      MANIFEST_LINE + JSON.stringify({ ...manifest, routes: { x: 1 } }),
    ]),
  ).toThrow('the agent in its VM')
  expect(() =>
    manifestFromGuest([
      MANIFEST_LINE + JSON.stringify({ ...manifest, domains: ['10.0.0.1'] }),
    ]),
  ).toThrow('domain')
})

test("a dev zone is in the agent's org, new each time", () => {
  const zone = devZone('gg.addis.agent.ops')
  expect(zone).toMatch(/^gg\.addis\.zone\.dev-[0-9a-f]{12}$/)
  expect(devZone('gg.addis.agent.ops')).not.toBe(zone)
  expect(() => devZone('ops')).toThrow("isn't an agent name")
})
