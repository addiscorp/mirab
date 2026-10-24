# mirab

Agents in VMs on your own machine.

An agent is a folder: its instructions, tools and skills. mirab runs the
whole agent (its loop, its tools and every command it picks) inside a VM on
your hardware, and the agent never holds a credential: model calls and other
outside requests leave through the station on the host, which adds the key
from [harar](https://github.com/addiscorp/harar) on the way out. Agents meet
people in channels, inside the apps they help with.

> **Status: early.** This is mirab's agent system, moved over with its
> history: VMs through Apple's Virtualization framework (`vz`) and
> Firecracker, containers, `mirab spawn`, and the Claude and Codex adapters.
> `mirab init`, the station and channels come next.

## Try it

```sh
bun install
bun run src/mirab.ts --help
```

Run it from source for now: a compiled `bun run build` binary can't start
agents yet, because it needs the PTY module and Firecracker beside it, which
mirab's packaging will put there.

## License

[Apache-2.0](LICENSE)
