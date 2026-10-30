// What one host lends to runner VMs: memory and vCPUs, set by the host's
// owner (the rest stays with the host). A VM holds a lease for as long as it
// runs. Leases are granted strictly in the order they were asked for: a big
// VM at the front waits for room, and smaller ones behind it wait too, so a
// big job (a macOS guest, a large Linux pool) is never starved by a stream of
// small ones.

export interface Need {
  memoryMiB: number
  vcpus: number
}

export interface Lease extends Need {
  release(): void
}

export interface BudgetSnapshot {
  memoryMiB: number
  vcpus: number
  usedMemoryMiB: number
  usedVcpus: number
  /** Leases held, by whoever asked. */
  leases: (Need & { by: string })[]
  /** Waiting for room, front first. */
  queue: (Need & { by: string })[]
}

type Waiter = Need & {
  by: string
  grant: (lease: Lease) => void
  fail: (e: Error) => void
}

export class HostBudget {
  private used: Need = { memoryMiB: 0, vcpus: 0 }
  private held = new Set<Need & { by: string }>()
  private queue: Waiter[] = []

  constructor(readonly total: Need) {}

  /** True when a VM this size can ever run here. */
  fits(need: Need): boolean {
    return (
      need.memoryMiB <= this.total.memoryMiB && need.vcpus <= this.total.vcpus
    )
  }

  /** Waits for room (in turn) and returns the lease; rejects if `signal`
   *  aborts first, or if the VM is bigger than the whole budget. */
  acquire(need: Need, by: string, signal?: AbortSignal): Promise<Lease> {
    if (!this.fits(need))
      return Promise.reject(
        new Error(
          `${by} needs ${need.memoryMiB} MiB and ${need.vcpus} vCPUs; this host lends VMs ${this.total.memoryMiB} MiB and ${this.total.vcpus} vCPUs in all`,
        ),
      )
    if (signal?.aborted) return Promise.reject(new Error('stopped'))
    return new Promise<Lease>((grant, fail) => {
      const waiter: Waiter = { ...need, by, grant, fail }
      const onAbort = () => {
        const i = this.queue.indexOf(waiter)
        if (i < 0) return
        this.queue.splice(i, 1)
        fail(new Error('stopped'))
        // The front may have been the one blocking the rest.
        this.pump()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiter.grant = (lease) => {
        signal?.removeEventListener('abort', onAbort)
        grant(lease)
      }
      this.queue.push(waiter)
      this.pump()
    })
  }

  snapshot(): BudgetSnapshot {
    const strip = ({ memoryMiB, vcpus, by }: Need & { by: string }) => ({
      memoryMiB,
      vcpus,
      by,
    })
    return {
      ...this.total,
      usedMemoryMiB: this.used.memoryMiB,
      usedVcpus: this.used.vcpus,
      leases: [...this.held].map(strip),
      queue: this.queue.map(strip),
    }
  }

  private pump() {
    while (this.queue.length) {
      const front = this.queue[0]!
      if (
        this.used.memoryMiB + front.memoryMiB > this.total.memoryMiB ||
        this.used.vcpus + front.vcpus > this.total.vcpus
      )
        return
      this.queue.shift()
      this.used.memoryMiB += front.memoryMiB
      this.used.vcpus += front.vcpus
      const record = {
        memoryMiB: front.memoryMiB,
        vcpus: front.vcpus,
        by: front.by,
      }
      this.held.add(record)
      let released = false
      front.grant({
        memoryMiB: front.memoryMiB,
        vcpus: front.vcpus,
        release: () => {
          if (released) return
          released = true
          this.held.delete(record)
          this.used.memoryMiB -= front.memoryMiB
          this.used.vcpus -= front.vcpus
          this.pump()
        },
      })
    }
  }
}
