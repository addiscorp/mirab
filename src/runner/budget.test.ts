import { describe, expect, test } from 'bun:test'
import { HostBudget } from './budget'

const gb = (n: number, vcpus = 1) => ({ memoryMiB: n * 1024, vcpus })

describe('HostBudget', () => {
  test('lends up to the total, then the next waits for a release', async () => {
    const b = new HostBudget(gb(4, 4))
    const one = await b.acquire(gb(2), 'one')
    const two = await b.acquire(gb(2), 'two')
    let third = false
    const p = b.acquire(gb(1), 'three').then((l) => ((third = true), l))
    await Bun.sleep(5)
    expect(third).toBe(false)
    expect(b.snapshot().queue.map((q) => q.by)).toEqual(['three'])
    one.release()
    await p
    expect(third).toBe(true)
    two.release()
  })

  test('first come, first served: a big VM at the front holds back small ones behind it', async () => {
    const b = new HostBudget(gb(5, 8))
    const linux = await b.acquire(gb(3), 'linux')
    const order: string[] = []
    const mac = b.acquire(gb(5), 'macos').then((l) => (order.push('macos'), l))
    const small = b
      .acquire(gb(1), 'small')
      .then((l) => (order.push('small'), l))
    await Bun.sleep(5)
    // 2 GiB is free and `small` would fit, but `macos` asked first.
    expect(order).toEqual([])
    linux.release()
    ;(await mac).release()
    ;(await small).release()
    expect(order).toEqual(['macos', 'small'])
    expect(b.snapshot().usedMemoryMiB).toBe(0)
  })

  test('vCPUs count too', async () => {
    const b = new HostBudget({ memoryMiB: 16384, vcpus: 4 })
    const a = await b.acquire({ memoryMiB: 1024, vcpus: 3 }, 'a')
    let got = false
    const p = b
      .acquire({ memoryMiB: 1024, vcpus: 2 }, 'b')
      .then(() => (got = true))
    await Bun.sleep(5)
    expect(got).toBe(false)
    a.release()
    await p
  })

  test('a waiter that stops leaves the queue, and the one behind it moves up', async () => {
    const b = new HostBudget(gb(4, 4))
    const held = await b.acquire(gb(3), 'held')
    const ctl = new AbortController()
    const big = b.acquire(gb(4), 'big', ctl.signal)
    const small = b.acquire(gb(1), 'small')
    ctl.abort()
    await expect(big).rejects.toThrow(/stopped/)
    ;(await small).release()
    held.release()
  })

  test('a VM bigger than the whole budget is refused at once, and a release counts once', async () => {
    const b = new HostBudget(gb(4))
    await expect(b.acquire(gb(5), 'huge')).rejects.toThrow(/lends VMs 4096 MiB/)
    const l = await b.acquire(gb(2), 'x')
    l.release()
    l.release()
    expect(b.snapshot().usedMemoryMiB).toBe(0)
  })
})
