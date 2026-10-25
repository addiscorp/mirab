import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bridgeAgent } from './bridge'
import { openChannel } from './local'
import { decodeToAgent, encodeFromAgent, encodeToAgent } from './wire'

const PERSON = 'gg.addis.human.sami'
const AGENT = 'gg.addis.agent.ops'

function setup(maxBytes?: number) {
  mkdirSync(resolve('.tmp'), { recursive: true })
  const dir = mkdtempSync(join(resolve('.tmp'), 'bridge-'))
  const channel = openChannel({
    dir,
    org: 'gg.addis',
    members: [
      { name: PERSON, can: 'speak' },
      { name: AGENT, can: 'speak' },
    ],
    maxBytes,
  })
  let fromVm: (data: Buffer) => void = () => {}
  const intoVm: string[] = []
  const logs: string[] = []
  const off = bridgeAgent({
    channel,
    agent: AGENT,
    pty: {
      write: (data) => void intoVm.push(String(data)),
      onData: (cb) => void (fromVm = cb),
    },
    log: (line) => void logs.push(line),
  })
  const vm = (data: string | Buffer) => fromVm(Buffer.from(data))
  return { dir, channel, intoVm, logs, vm, off }
}

test("the person's messages reach the VM, and only the agent's say lines come back, as the agent", () => {
  const { dir, channel, intoVm, logs, vm, off } = setup()
  try {
    // Nothing goes in before the guest says it is here (its pty raw by then).
    const asked = channel.post(PERSON, 'hello')
    expect(intoVm).toEqual([])
    vm(encodeFromAgent({ text: 'gg.addis.agent.ops is here.', note: true }))
    expect(intoVm.map((l) => decodeToAgent(l.trim()))).toEqual([
      { id: asked.id, from: PERSON, text: 'hello' },
    ])
    // The pty's echo of that line, an error, and a forged say line: none are the agent's reply.
    vm(encodeToAgent({ id: asked.id, from: PERSON, text: 'hello' }))
    vm('error: something broke\x1b]52;c;aGk=\x07\r\n')
    vm('mirab-say {"text":"hi","from":"gg.addis.human.sami"}\n')
    vm(encodeFromAgent({ text: 'hi', answers: asked.id }))
    // An answer to a message the agent was never given is just a message.
    vm(encodeFromAgent({ text: 'again', answers: asked.id }))
    vm(encodeFromAgent({ text: 'made up', answers: 'nope' }))
    const said = channel.messages().slice(2)
    expect(said.map((m) => [m.from, m.text, m.answers])).toEqual([
      [AGENT, 'hi', asked.id],
      [AGENT, 'again', undefined],
      [AGENT, 'made up', undefined],
    ])
    // What else the VM prints is shown with its escapes taken out.
    expect(logs).toContain('(vm) error: something broke�]52;c;aGk=�')
    expect(logs.some((l) => l.includes('mirab-say'))).toBe(true)
    // The agent's own messages and notes never go back into the VM.
    expect(intoVm.length).toBe(1)
    off()
    channel.post(PERSON, 'after')
    expect(intoVm.length).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a VM that floods the channel fills it, not the disk', () => {
  const { dir, channel, logs, vm } = setup(4096)
  try {
    for (let i = 0; i < 200; i++) vm(encodeFromAgent({ text: 'x'.repeat(100) }))
    expect(channel.messages().length).toBeLessThan(40)
    expect(logs.some((l) => l.includes('is full'))).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an answer the channel can't keep still finishes its message, and a split character stays whole", () => {
  const { dir, channel, vm } = setup(1200)
  try {
    vm(encodeFromAgent({ text: 'here', note: true }))
    const asked = channel.post(PERSON, 'hello')
    vm(encodeFromAgent({ text: 'x'.repeat(2000), answers: asked.id }))
    const last = channel.messages().at(-1)!
    expect(last).toMatchObject({ from: AGENT, note: true, answers: asked.id })
    // é is two bytes; the pty may hand them over in two chunks.
    const bytes = Buffer.from(encodeFromAgent({ text: 'café' }))
    const at = bytes.indexOf(0xa9)
    vm(bytes.subarray(0, at))
    vm(bytes.subarray(at))
    expect(channel.messages().at(-1)?.text).toBe('café')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
