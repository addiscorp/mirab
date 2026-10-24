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
> `mirab init`, `mirab dev` and the station are in; channels come next.

## Make an agent

```sh
mkdir ops && cd ops
bun run <mirab checkout>/src/mirab.ts          # asks for the agent's harar name
# or: mirab init ops --name gg.addis.agent.ops
```

It writes `agent/agent.ts`, `agent/instructions.md`, and `tools/`, `skills/`,
`subagents/`, `schedules/` and `channels/` folders. It never writes a `.env`:
model access comes from harar.

## Run it

```sh
mirab dev            # in the project: a chat with the agent, in its own VM
mirab manifest       # what mirab reads about the agent, as JSON
```

The VM has no network of its own. Its only way out is the station on this
machine, which lets it reach the domains in `agent.ts` (`domains`) and adds
the model key, read from harar, on the way out. Nothing in the VM holds the
key. `~/.config/mirab/station.json` says where harar is and which secret is
the key:

```json
{
  "harar": { "socket": "/var/run/harar.sock" },
  "models": {
    "anthropic": { "key": "personal/anthropic/API_KEY" },
    "claude": { "token": "personal/claude/OAUTH_TOKEN" }
  }
}
```

For now `mirab dev` starts from the project as it is: restart it to pick up
edits (a VM boots in well under a second). What the agent writes in its VM
stays there. The agent's files run only in its VM, never on this machine:
the manifest is read there and checked here. The VM can spend the model key
on its route (that is what the route is for), but never read it.

mirab runs on [Bun](https://bun.sh), and so do the agents it makes (their
`agent/` files are TypeScript, run as is). Until mirab is on npm, run it from
a checkout as above rather than with `npx`.

## Claude Code on your own subscription

`mirab spawn --vm claude` runs Claude Code in a VM on your Claude
subscription, and the VM never holds your token. Make a token once with
`claude setup-token`, keep it in harar
(`harar put personal/claude/OAUTH_TOKEN`), and name it under `models.claude`
in `station.json`. In the VM, Claude Code has a placeholder token and the
station as its API. The station swaps in your token on the way to
`api.anthropic.com/v1/messages`, and nothing else leaves: Claude Code's
telemetry and updates are off, and anything else it tries goes through the
station's whitelist and audit log. One person's token, on their own machine.

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
