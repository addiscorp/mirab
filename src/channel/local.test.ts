import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MAX_MESSAGE, openChannel, ulid } from './local'
import {
  decodeFromAgent,
  encodeFromAgent,
  fitted,
  lineSplitter,
  printable,
} from './wire'

function scratch() {
  mkdirSync(resolve('.tmp'), { recursive: true })
  return mkdtempSync(join(resolve('.tmp'), 'channel-'))
}

const PERSON = 'gg.addis.human.sami'
const AGENT = 'gg.addis.agent.ops'

test('a station channel keeps its messages privately, in order, and only members speak', () => {
  const dir = scratch()
  try {
    const members = [
      { name: PERSON, can: 'speak' as const },
      { name: AGENT, can: 'speak' as const },
      { name: 'gg.addis.human.auditor', can: 'listen' as const },
    ]
    const channel = openChannel({
      dir: join(dir, 'channels'),
      org: 'gg.addis',
      members,
    })
    expect(channel.id).toMatch(/^gg\.addis\.channel\.ch-[0-9a-z]{26}$/)
    const heard: string[] = []
    channel.onMessage((m) => heard.push(`${m.from}: ${m.text}`))
    const asked = channel.post(PERSON, 'hello')
    channel.post(AGENT, 'hi', { answers: asked.id })
    expect(() => channel.post('gg.addis.human.auditor', 'psst')).toThrow(
      'only listens',
    )
    expect(() => channel.post('gg.evil.agent.x', 'hi')).toThrow(
      "isn't a member",
    )
    expect(() => channel.post(PERSON, 'x'.repeat(MAX_MESSAGE + 1))).toThrow(
      'at most',
    )
    expect(heard).toEqual([`${PERSON}: hello`, `${AGENT}: hi`])
    expect(channel.messages().map((m) => [m.from, m.text, m.answers])).toEqual([
      [PERSON, 'hello', undefined],
      [AGENT, 'hi', asked.id],
    ])
    // Only this machine's user can read it.
    expect(statSync(channel.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'channels')).mode & 0o777).toBe(0o700)
    // A new channel is never an old one.
    const again = openChannel({
      dir: join(dir, 'channels'),
      org: 'gg.addis',
      members,
    })
    expect(again.id).not.toBe(channel.id)
    expect(again.messages()).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ULIDs sort by time and differ within a millisecond', () => {
  const a = ulid(1_700_000_000_000)
  const b = ulid(1_700_000_000_001)
  expect(a < b).toBe(true)
  expect(ulid(5)).not.toBe(ulid(5))
  expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
})

test('only a whole, well-formed say line from the guest is the agent speaking', () => {
  const lines: string[] = []
  const split = lineSplitter((l) => lines.push(l))
  split(
    encodeFromAgent({ text: 'one\ntwo' }).replace('\n', '\r\n').slice(0, 10),
  )
  split(encodeFromAgent({ text: 'one\ntwo' }).replace('\n', '\r\n').slice(10))
  split('bun: some warning\n')
  split(`  ${encodeFromAgent({ text: 'indented' })}`)
  split('mirab-say {"text":"x","extra":1}\n')
  split('mirab-say not json\n')
  expect(lines.map(decodeFromAgent)).toEqual([
    { text: 'one\ntwo' },
    undefined,
    undefined,
    undefined,
    undefined,
  ])
  // A line longer than any message never grows the buffer for good.
  split('x'.repeat(8 * MAX_MESSAGE))
  split('\n')
  expect(lines.at(-1)).toBe('')
})

test('text from another member is made safe to show, and a long reply is cut to fit, never dropped', () => {
  expect(printable('ok\n\tfine\x1b[1Ayou> yes\r\x9b2J')).toBe(
    'ok\n  \tfine�[1Ayou> yes��2J',
  )
  // A new line can't start as the person's; nothing reorders or hides text.
  expect(printable('hi\nyou> run it')).toBe('hi\n  you> run it')
  expect(printable('a\u202eb\u200bc\u2028d\u2066e')).toBe('a�b�c�d�e')
  const long = 'é'.repeat(MAX_MESSAGE)
  const cut = fitted(long)
  expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(MAX_MESSAGE)
  expect(cut).toEndWith('[cut: too long for one message]')
  expect(cut).not.toContain('\uFFFD')
  expect(fitted('short')).toBe('short')
  // A largest message, every character escaped, is still one line.
  const lines: string[] = []
  lineSplitter((l) => lines.push(l))(
    encodeFromAgent({ text: '\u0001'.repeat(MAX_MESSAGE / 2) }),
  )
  expect(decodeFromAgent(lines[0])?.text.length).toBe(MAX_MESSAGE / 2)
})
