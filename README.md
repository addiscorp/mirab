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

## Install

```sh
curl -fsSL https://mirab.addis.gg/install.sh | sh
```

It installs mirab into `~/.mirab` (the release in `~/.mirab/releases/`, the
`mirab` command in `~/.mirab/bin`), checked against the SHA-256 in the
release's manifest, with no sudo. It brings its own Bun, and on Linux its own
Firecracker. The VM image is downloaded on first use. Builds: macOS (Apple
silicon and Intel) and Linux x86_64. `sh -s -- --canary` installs the newest
build of `main`.

## Make an agent

```sh
mkdir ops && cd ops
mirab                                           # asks for the agent's harar name
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
the model key, sent by harar for that host only, on the way out. Nothing in the VM holds the
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

Like any key, harar decides where these go, and records each time:

```sh
harar hosts allow personal/anthropic/API_KEY api.anthropic.com
harar hosts allow personal/claude/OAUTH_TOKEN api.anthropic.com
```

While `mirab dev` runs, what you save reaches the agent's VM, and the agent
picks up edits to `agent/` before its next turn, keeping the conversation.
When the session ends, what the agent changed comes back to your project. If
you both changed the same file, yours stays and the agent's is saved aside,
never merged and never silently dropped. Your `.git` is never touched. What
the agent changes about itself (anything under `agent/` and every `.env*`)
never lands on its own: it's held aside and named when the session ends, for
you to look at and copy over if you want it.

That alone can't stop an agent widening itself (its code may import from
elsewhere), so what it may reach is approved per project, not taken from its
code: the first `mirab dev` records the manifest's `domains` and `packages`,
and if its code later asks for more, by any route, the new ones are left out
of the session and named. If the change was yours, approve it here:

```sh
mirab manifest           # what the agent asks for (read in its VM), and what's waiting
mirab manifest approve   # yes to what's waiting
```

What the agent's calls may do is rixse's to decide. A host a key goes to lets
reads (GET, HEAD) through and holds everything else for you, unless the
agent's `gateway` section says otherwise:

```ts
export default defineAgent({
  name: 'gg.addis.agent.ops',
  model: 'anthropic/claude-sonnet-5-5',
  gateway: {
    rules: [
      // apply: goes through; request: held for you; forbidden: never.
      { host: 'github.com', method: 'POST', path: '/acme/repo.git/git-receive-pack', effect: 'apply' },
      { host: 'api.stripe.com', method: 'DELETE', effect: 'forbidden' },
    ],
    // Optional: a separate key used only for sends you approve, so a read key can't write.
    secrets: { 'api.stripe.com': { agent: 'prod/shop/READ', approved: 'prod/shop/WRITE' } },
  },
})
```

The section is approved as a whole, like the rest: the first `mirab dev`
records it, and any change after that, even one that looks narrower, waits
for `mirab manifest approve`, which shows every rule. Until then the approved
one stays in force.

The chat is a channel the station hosts, between you and the agent, and it
stays on this machine (`~/.mirab/sessions/channels`, readable only by
you). `mirab dev` prints its id when it starts. In it you are `station.json`'s
`human` (your harar name, like `gg.addis.human.sami`), or your login in the
agent's org until you set one. Later the same chat can live in an app.

The agent's files run only in its VM, never on this machine: the manifest is
read there and checked here. The VM can spend the model key
on its route (that is what the route is for), but never read it.

mirab runs on [Bun](https://bun.sh), and so do the agents it makes (their
`agent/` files are TypeScript, run as is).

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

## When an agent asks for more

A host that isn't in an agent's `domains` is refused, and the station
records the ask on this machine. You decide in your own terminal, never in
the agent's VM:

```sh
mirab escalations              # what agents asked for
mirab allow api.stripe.com     # yes: the running station lets it through at once
mirab dismiss api.stripe.com   # no
mirab revoke api.stripe.com --agent project:$PWD   # take a yes back (a project is its folder)
```

Quote wildcards so the shell leaves them alone: `mirab allow '*.example.com'`.

A yes goes into that agent's allow file in `~/.config/mirab/allow/`. To
keep it, add the host to `domains` in `agent/agent.ts`, so it lives in git.

## Packages

An agent's `packages` (apt names, in `agent.ts`) are installed on mirab's
Ubuntu base image the first time it runs, then cached:

```sh
mirab image build     # build the agent's image now (mirab dev does it on first use)
mirab image update    # boot it, and upgrade it if apt has anything newer
mirab image list      # the images cached on this machine
mirab image prune     # remove ones on an older base, unused 30 days, or left by a stopped build
```

Building and updating happen in a mirab VM whose only way out is the station, with only
Ubuntu's mirrors on its whitelist, over HTTPS. An update keeps the image
before it, for rollback. The same on macOS and Linux.

## Keys for any service

Your project's `.env` holds only references (`harar import .env` writes
them): `STRIPE_KEY=harar://prod/shop/STRIPE_KEY`. harar says where each secret may
go, and records each time it does:

```sh
harar hosts allow prod/shop/STRIPE_KEY api.stripe.com
harar hosts allow personal/github/TOKEN github.com
harar hosts allow personal/github/TOKEN api.github.com
```

At a primary, that's a role's `send` permission
(`harar policy role set <role> --send "prod/shop/STRIPE_KEY api.stripe.com"`),
approved like any widening. A secret harar lets go nowhere isn't given to the VM.

A `.env` comes with whatever repo you cloned, so a reference alone gives an
agent nothing: you let each project use each secret once, here, never in its
VM. A project is its folder on this machine, never the name its agent gives.
`mirab dev` and `mirab spawn --vm` print the exact line when one is missing;
in the project's folder it's just:

```sh
mirab secrets allow prod/shop/STRIPE_KEY
mirab secrets list
mirab secrets revoke prod/shop/STRIPE_KEY
```

In the VM, `STRIPE_KEY` is a placeholder, new every session. Programs run
unchanged (`curl`, `git`, `gh`, SDKs), with the station as their proxy. The
VM trusts the station's own certificate authority (its key stays in
`~/.config/mirab/station-ca`). For those hosts only, the station opens the
request, swaps the placeholder in its headers for the real value from harar,
and sends it on over its own TLS, checking the host's real certificate. A
placeholder sent to any other host is refused. Bodies and URLs are never
rewritten, and every other host stays a sealed tunnel. The model never sees a
key, because the agent never has one.

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
