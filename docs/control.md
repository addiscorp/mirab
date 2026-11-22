# `mirab control`: the machine interface

`mirab control` lets a program run agents. It reads one JSON object per line
on stdin and writes one per line on stdout. The Rust client (`crates/mirab`,
`mirab` on crates.io) is built on it; any language can speak it.

## One definition

`src/control/protocol.ts` is the only definition. `bun
scripts/control-schema.ts` generates `protocol/control.v1.json` (JSON Schema)
and `crates/mirab/src/protocol.rs` from it, and `--check`, in CI, fails if
either differs or if the crate's version isn't `package.json`'s.

A change an existing client couldn't read bumps `CONTROL_PROTOCOL`. A new
optional field doesn't.

## Frames

```json
{"id":1,"op":"hello","params":{"protocol":1}}
{"id":1,"ok":true,"result":{"protocol":1,"version":"0.2.2"}}
{"id":2,"ok":false,"error":{"code":"no_session","message":"no session s_x"}}
{"event":"held","session":"s_ab12","request":{"id":"r_…","hash":"…"}}
```

`hello` comes first. Requests may overlap, and answers may come back in any
order. A frame with `event` is something mirab says unprompted.

| Operations | |
|---|---|
| `hello`, `availability` | Protocol check; whether VMs can run here, with a typed reason |
| `manifest` | The agent in a project, read in a VM, and what waits for approval |
| `start`, `stop`, `sessions`, `send` | Agent sessions, as `mirab dev` runs them |
| `requests`, `decide` | What the gateway holds, and a person's answer |
| `file_put`, `file_get`, `file_list` | Files in a session's guest |
| `spawn`, `spawned`, `spawn_send`, `spawn_stop` | Terminal agents as sub-agents, always in a VM |

## What it keeps

- **No secret passes through.** The station gets keys from harar. A held
  request names them by placeholder and secret name.
- **Approvals stay where they were.** A first `start` records the project's
  reach, as a first `mirab dev` does. Widening it is `mirab manifest approve`,
  in a person's terminal, and has no operation here.
- **A yes binds to bytes.** `decide` with `yes` needs the hash of the request
  the person was shown.
- **Only its own.** A client sees and controls the sessions it started, never
  another program's on the same machine.
- **Nothing outlives the client.** When stdin closes, for any reason, every VM
  it started is stopped and what the agents changed comes back as usual.
- **What comes from a VM is untrusted:** message text, log lines, and the
  bytes of a held request.

## A compiled mirab

`bun build --compile src/mirab.ts` gives one binary that starts agents, with
no Bun or source beside it. `crates/mirab/tests/live.rs` boots a VM from it
(`TEST_MIRAB_BINARY`). It still needs `mirab-vz` (macOS) or Firecracker
(Linux), a kernel and a rootfs, named in `isolation.json`.
