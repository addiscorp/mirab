// One live line for a long step on a terminal: what it's doing, a bar (or a
// spinner while it can't say how far it is), the percentage and the time it
// has taken, redrawn in place. Log lines print above it. Without a terminal it
// stays out of the way: callers keep their plain log lines.
import { clearLine, cursorTo } from 'node:readline'
import type { PullProgress } from './isolation/macos'

const WIDTH = 24
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function elapsed(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The line for `p`, `ms` into its step; `frame` turns the spinner. */
export function renderProgress(p: PullProgress, ms: number, frame: number) {
  const done = p.fraction === undefined ? undefined : Math.min(1, p.fraction)
  const bar =
    done === undefined
      ? `${SPIN[frame % SPIN.length]} ${' '.repeat(WIDTH - 2)}`
      : '█'.repeat(Math.round(done * WIDTH)).padEnd(WIDTH, '░')
  const pct =
    done === undefined
      ? '    '
      : `${String(Math.floor(done * 100)).padStart(3)}%`
  return `  ${p.step} ${bar} ${pct}  ${elapsed(ms)}${p.detail ? `  ${p.detail}` : ''}`
}

export interface ProgressLine {
  log: (line: string) => void
  progress: (p: PullProgress | null) => void
}

/** A log and a progress callback that share `out`; undefined when `out` is
 *  not a terminal. */
export function progressLine(
  out: NodeJS.WriteStream = process.stderr,
  now: () => number = Date.now,
): ProgressLine | undefined {
  if (!out.isTTY) return undefined
  let current: PullProgress | undefined
  let started = 0
  let frame = 0
  let drawn = false
  let lastDraw = -Infinity
  const wipe = () => {
    if (!drawn) return
    clearLine(out, 0)
    cursorTo(out, 0)
    drawn = false
  }
  const draw = () => {
    if (!current) return
    wipe()
    const line = renderProgress(current, now() - started, frame++)
    out.write(line.slice(0, Math.max(20, (out.columns ?? 80) - 1)))
    drawn = true
    lastDraw = now()
  }
  return {
    log(line) {
      wipe()
      out.write(`${line}\n`)
      draw()
    },
    progress(p) {
      if (p === null) {
        // The step's last state stays on screen, with its total time.
        if (current) {
          draw()
          out.write('\n')
          drawn = false
        }
        current = undefined
        return
      }
      const fresh = current?.step !== p.step
      if (fresh) started = now()
      current = p
      // A download reports every chunk: at most 10 redraws a second.
      if (fresh || now() - lastDraw >= 100) draw()
    },
  }
}
