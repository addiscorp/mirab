import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { openChannel } from './channel/local'
import { devZone, manifestFromGuest, personMember, terminalChat } from './dev'
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

test('the terminal is a client of the chat: lines are said as the person, the agent is shown, and the end waits for answers', async () => {
  mkdirSync(resolve('.tmp'), { recursive: true })
  const dir = mkdtempSync(join(resolve('.tmp'), 'terminal-'))
  const person = 'gg.addis.human.sami'
  const agent = 'gg.addis.agent.ops'
  try {
    const channel = openChannel({
      dir,
      org: 'gg.addis',
      members: [
        { name: person, can: 'speak' },
        { name: agent, can: 'speak' },
      ],
    })
    // The agent answers each message a little later, as a VM would.
    channel.onMessage((m) => {
      if (m.from === person)
        setTimeout(
          () => channel.post(agent, `re: ${m.text}`, { answers: m.id }),
          30,
        )
    })
    const input = new PassThrough()
    const out = new PassThrough()
    let shown = ''
    out.on('data', (c) => (shown += c))
    const chat = terminalChat(
      {
        channel,
        person,
        agent,
        say: (text) => channel.post(person, text),
        pty: { onExit: () => {} },
      },
      input,
      out,
    )
    channel.post(agent, 'gg.addis.agent.ops is here.', { note: true })
    input.write('one\n\ntwo\n')
    input.end()
    // Input ended before the answers came: the chat waits for them.
    expect(await chat.done).toBe(0)
    expect(shown).toContain('(gg.addis.agent.ops is here.)')
    expect(shown).toContain('ops> re: one')
    expect(shown).toContain('ops> re: two')
    expect(
      channel
        .messages()
        .filter((m) => m.from === person)
        .map((m) => m.text),
    ).toEqual(['one', 'two'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the person is station.json's human, or this login, unvouched for", () => {
  const station = { harar: { socket: '/x' }, models: {} }
  expect(
    personMember({ ...station, human: 'gg.addis.human.sami' }, 'gg.addis'),
  ).toEqual({ name: 'gg.addis.human.sami', can: 'speak' })
  expect(personMember(station, 'gg.addis', 'Sami.Fouad')).toEqual({
    name: 'gg.addis.human.sami-fouad',
    can: 'speak',
    unverified: true,
  })
})
