// Sandboxes inside the guest, live: the x86_64 guest kernel
// (guest-agent/kernel-x86_64.config) has Landlock and seccomp, so a program in
// the VM can restrict itself (gelada, Docker's default profile, systemd's
// SystemCallFilter=). Needs a VM guest image described in
// $TEST_VM_CONFIG_DIR/isolation.json; the arm64 vz kernel has neither yet.
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadHostConfig, startVm } from './index'
import type { Isolation } from './session'

const testConfig = process.arch === 'x64' ? process.env.TEST_VM_CONFIG_DIR : ''

async function sh(iso: Isolation, cmd: string) {
  const lines: string[] = []
  const code = await iso.exec(['sh', '-c', cmd], {
    cwd: '/',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    onLine: async (l) => void lines.push(l),
  })
  return { code, out: lines.join('\n') }
}

/** A python3 script in the guest, passed in base64 so no shell quoting applies. */
const python = (iso: Isolation, script: string) =>
  sh(
    iso,
    `echo ${Buffer.from(script).toString('base64')} | base64 -d | python3 - 2>&1`,
  )

// x86_64 syscall numbers and constants (linux/landlock.h, linux/seccomp.h,
// linux/filter.h), through ctypes: the rootfs has python3 and no compiler.
const PRELUDE = `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
def check(r, what):
    if r < 0:
        e = ctypes.get_errno(); print(f"{what}: {os.strerror(e)}"); sys.exit(2)
    return r
PR_SET_NO_NEW_PRIVS = 38
check(libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no_new_privs")
`

// Landlock: a ruleset that handles reading files and allows nothing, then
// restrict_self; afterwards open() is refused with EACCES.
const LANDLOCK = `${PRELUDE}
class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]
abi = check(libc.syscall(444, None, ctypes.c_size_t(0), ctypes.c_uint32(1)), "landlock ABI")
print(f"landlock abi {abi}")
open("/etc/hostname").close()
attr = RulesetAttr(1 << 2)  # LANDLOCK_ACCESS_FS_READ_FILE
fd = check(libc.syscall(444, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)), ctypes.c_uint32(0)), "create_ruleset")
check(libc.syscall(446, ctypes.c_int(fd), ctypes.c_uint32(0)), "restrict_self")
try:
    open("/etc/hostname").close(); print("read allowed after restrict_self"); sys.exit(3)
except PermissionError:
    print("read denied by landlock")
`

// seccomp: a filter that makes getppid (110) fail with EPERM, allowing all
// else; /proc/self/status then reports filter mode.
const SECCOMP = `${PRELUDE}
class SockFilter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_uint16), ("jt", ctypes.c_uint8), ("jf", ctypes.c_uint8), ("k", ctypes.c_uint32)]
class SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]
BPF_LD_W_ABS, BPF_JEQ_K, BPF_RET_K = 0x20, 0x15, 0x06
AUDIT_ARCH_X86_64, KILL, ALLOW, ERRNO_EPERM = 0xC000003E, 0x00000000, 0x7FFF0000, 0x00050001
prog = (SockFilter * 7)(
    SockFilter(BPF_LD_W_ABS, 0, 0, 4),            # seccomp_data.arch
    SockFilter(BPF_JEQ_K, 1, 0, AUDIT_ARCH_X86_64),
    SockFilter(BPF_RET_K, 0, 0, KILL),
    SockFilter(BPF_LD_W_ABS, 0, 0, 0),            # seccomp_data.nr
    SockFilter(BPF_JEQ_K, 0, 1, 110),             # getppid
    SockFilter(BPF_RET_K, 0, 0, ERRNO_EPERM),
    SockFilter(BPF_RET_K, 0, 0, ALLOW),
)
fprog = SockFprog(len(prog), prog)
check(libc.syscall(110), "getppid before")
PR_SET_SECCOMP, SECCOMP_MODE_FILTER = 22, 2
check(libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(fprog), 0, 0), "seccomp filter")
r = libc.syscall(110)
e = ctypes.get_errno()
print(f"getppid after filter: {r} {os.strerror(e)}")
for l in open("/proc/self/status"):
    if l.startswith("Seccomp"): print(l.strip())
sys.exit(0 if r < 0 and e == 1 else 4)
`

describe.skipIf(!testConfig)('guest kernel sandboxes, live', () => {
  test('Landlock and seccomp filters work in the guest', async () => {
    const host = await loadHostConfig(testConfig!)
    await mkdir(resolve('.tmp'), { recursive: true })
    const base = await mkdtemp(join(resolve('.tmp'), 'guest-sandbox-'))
    const iso = await startVm(
      { ...host.vm!, egress: 'block' },
      null,
      join(base, 'vm'),
      undefined,
      undefined,
      { listen: [] },
    )
    try {
      // The LSM list, as any stock kernel shows it.
      const lsm = await sh(
        iso,
        'mount -t securityfs securityfs /sys/kernel/security 2>/dev/null; cat /sys/kernel/security/lsm',
      )
      expect(lsm.out).toContain('landlock')
      const status = await sh(iso, 'grep ^Seccomp: /proc/self/status')
      expect(status.out).toMatch(/^Seccomp:\s+0$/m)

      const landlock = await python(iso, LANDLOCK)
      expect(landlock.out).toContain('read denied by landlock')
      expect(landlock.code).toBe(0)

      const seccomp = await python(iso, SECCOMP)
      expect(seccomp.out).toContain(
        'getppid after filter: -1 Operation not permitted',
      )
      expect(seccomp.out).toMatch(/^Seccomp:\s+2$/m)
      expect(seccomp.out).toMatch(/^Seccomp_filters:\s+1$/m)
      expect(seccomp.code).toBe(0)
    } finally {
      await iso.close()
      await rm(base, { recursive: true, force: true })
    }
  }, 300_000)
})
