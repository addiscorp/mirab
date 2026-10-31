import { expect, test } from 'bun:test'
import { elapsed, progressLine, renderProgress } from './progress-line'

/** A terminal that records what is written, and a clock the test moves. */
function terminal(isTTY = true) {
  const writes: string[] = []
  const out = {
    isTTY,
    columns: 120,
    write: (s: string) => (writes.push(s), true),
  } as unknown as NodeJS.WriteStream
  let t = 0
  return {
    out,
    writes,
    now: () => t,
    advance: (ms: number) => (t += ms),
    // What the screen shows: escape codes out, \r and line clears applied.
    screen: () =>
      writes
        .join('')
        .replace(/\x1b\[2K/g, '\u0000')
        .replace(/\x1b\[\d*G/g, '')
        .split('\n')
        .map((l) => l.split('\u0000').pop()!.split('\r').pop()!),
  }
}

test('no terminal: no live line, callers keep their plain lines', () => {
  expect(progressLine(terminal(false).out)).toBeUndefined()
})

test('a step draws a bar, its percentage and its time, in place; log lines print above it', () => {
  const t = terminal()
  const live = progressLine(t.out, t.now)!
  live.log('installing macOS 27.2')
  live.progress({ step: 'installing', detail: 'preparing' })
  t.advance(65_000)
  live.progress({ step: 'installing', fraction: 0.5 })
  live.log('a line in between')
  t.advance(30_000)
  live.progress({ step: 'installing', fraction: 1 })
  live.progress(null)
  live.log('provisioning needs an administrator')
  expect(t.screen()).toEqual([
    'installing macOS 27.2',
    'a line in between',
    `  installing ${'█'.repeat(24)} 100%  1:35`,
    'provisioning needs an administrator',
    '',
  ])
})

test('while the step cannot say how far it is, a spinner turns and the clock still runs', () => {
  const line = renderProgress(
    { step: 'installing', detail: 'preparing' },
    42_000,
    3,
  )
  expect(line).toContain('⠸')
  expect(line).not.toContain('%')
  expect(line).toContain('0:42')
  expect(line).toContain('preparing')
  expect(
    renderProgress({ step: 'downloading', fraction: 0.25 }, 0, 0),
  ).toContain(`${'█'.repeat(6)}${'░'.repeat(18)}  25%`)
})

test('a download reporting every chunk is redrawn at most 10 times a second', () => {
  const t = terminal()
  const live = progressLine(t.out, t.now)!
  for (let i = 0; i <= 1000; i++) {
    live.progress({ step: 'downloading', fraction: i / 1000 })
    t.advance(1) // 1000 chunks in one second
  }
  const draws = t.writes.filter((w) => w.includes('downloading')).length
  expect(draws).toBeGreaterThanOrEqual(10)
  expect(draws).toBeLessThanOrEqual(12)
})

test('elapsed reads as minutes:seconds', () => {
  expect(elapsed(0)).toBe('0:00')
  expect(elapsed(263_400)).toBe('4:23')
})
