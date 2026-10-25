# mirab architecture

mirab runs agents on your own hardware. An agent is a folder; it runs whole
(its loop, its tools and every command it picks) inside a VM; it never holds a
credential; and it meets people in channels inside the apps it helps with. Its
identity, its grants and the channels it may join come from
[harar](https://github.com/addiscorp/harar).

Status: agreed with Sami, 24 Oct (section 5 as revised: a whitelist with
escalation for where a VM connects; the station adds only long-lived keys).
Section 7 lists what is built.

## 1. Pieces

| Piece | What it is | Example |
|---|---|---|
| **station** | mirab on one machine: it starts agents in VMs, is that machine's harar broker, and is the only way out of a VM. A laptop runs one for `mirab dev`; a server runs one for good. | the iMac, bugsy, a customer's server |
| **agent** | A folder: instructions, tools, skills, subagents, schedules, channels. Its harar name is its identity. | `gg.addis.agent.ops` |
| **zone** | Where an agent runs: one VM (or container) the station started, registered with harar as a child zone. | `gg.addis.zone.vm-01jbx4k2` |
| **channel** | A bucket of messages between actors, hosted by one app (harar section 3b). The terminal chat in `mirab dev` is one too, hosted by the station. | `gg.addis.channel.ch-01jbx…` |

The host runs only the station. On bugsy, the production host, nothing else
runs outside a VM.

## 2. `npx mirab`

Same shape as Vercel's eve, so its users know it; our own package, no
compatibility claim, and nothing hosted.

**In an empty folder** it makes an agent:

```
agent/
  agent.ts          defineAgent({ name: 'gg.addis.agent.ops', model: 'anthropic/claude-sonnet-5-5' })
  instructions.md
  tools/            one tool per file, defineTool from 'mirab/tools'
  skills/
  subagents/
  schedules/
  channels/         which channels the agent joins
package.json
```

It asks for the agent's harar name and never writes a `.env` (it gitignores
one anyway). Model access is a key or subscription in harar (`mirab login`),
never a gateway.

**In a project** it is `mirab dev`:

1. starts a station if none is running (on a laptop: with your personal harar
   vault, no org primary needed);
2. boots the agent in the strongest sandbox there is: a VM (`vz` on macOS,
   Firecracker on Linux), else a container; it refuses rather than run
   unsandboxed;
3. syncs the project into the VM as you edit it;
4. opens the terminal chat: a channel between you and the agent.

**On a server** `mirab station install` (once, at that machine's console)
makes it a harar broker for the org, and `mirab up` runs the project's agents
for good, with their schedules and channels. There is no deploy: there is
nowhere else to deploy to.

## 3. The whole agent runs in the VM

eve runs the agent's loop and tools in the app process, next to the model key,
and only the commands the model picks in a sandbox. mirab runs all of it in
the VM. The loop is TypeScript on Bun, in the guest image.

So nothing the agent runs, and nothing a tool imports, can read a long-lived
credential: there is none in the VM. Every connection out of the VM goes
through the station (section 5).

## 4. Channels

Channels are a harar primitive (harar `docs/architecture.md`, section 3b):
harar holds who is a member; the hosting app holds the messages; membership
grants nothing else, and a message is untrusted input.

- An agent joins a channel outbound: the station dials the app over a
  WebSocket. Nothing connects into a station.
- To the app, the agent proves who it is with a short-lived harar token from
  its station's broker. The app checks membership against its own primary.
- What an agent may *do* comes only from its harar grants, never from what a
  channel says. A request in a channel that needs more pauses for a person's
  approval, signed on their device.
- The chat in `mirab dev` is the first: a channel the station hosts
  (`src/channel`), its messages kept on the machine, with two members, the
  person (`station.json` `human`) and the agent. The terminal is one client
  of it and the agent loop in the VM another, one JSON line each way on the
  guest pty (`src/channel/wire.ts`). An app's channel takes the station's
  place, with the same messages.
- gild's mention bridge (`src/spawn-bridge.ts`) types a channel's @mentions
  into the agent today, against gild's forge (#2).

## 5. The way out of a VM

Two questions, answered separately: **where** a VM may connect, and **which
secrets** it may hold when it gets there.

### Where: a whitelist per zone, with escalation

The VM has no direct network. Its only way out is the station, which checks
each connection's destination against the zone's whitelist of domains.

```
VM ──HTTPS_PROXY──▶ 127.0.0.1:8790 ──vsock──▶ station ──▶ registry.npmjs.org
     (CONNECT host:443)  (guest agent forward)   1. who: the zone, from the hypervisor
                                                 2. host on the zone's whitelist? else refuse
                                                 3. connect; the TLS stays end to end
                                                 4. audit: zone, host, bytes
```

- **No TLS interception.** The station reads only the domain the connection
  asks for (`CONNECT` host, checked against the TLS server name) and then
  passes bytes. Filtering by IP can't do this: shared CDNs put unrelated
  domains on one address.
- **The tunnel.** The guest agent gets a `forward` mode: it listens on a
  loopback port in the VM and carries each connection to a host vsock port.
  The hypervisor names the VM on the host side, so the station knows which
  zone is calling without trusting anything the VM says.
- **Escalation.** When an agent hits a wall, it asks for the domain
  (`allow registry.npmjs.org for this zone`, with its reason). The request
  goes to harar as an approval (`egress.allow`); a person approves it on their
  device, and the domain joins that zone's whitelist. Until approvals land in
  harar's primary (harar#45), the whitelist is a file the station reads.
- **Defaults.** A new zone's whitelist holds only what its routes need (below).
- **Encrypted ClientHellos are refused.** The VM writes its own hello, so it
  could put a whitelisted name on the outside and any site on the same CDN
  inside, where a CDN that supports it would route. Real ones and GREASE look
  the same, so neither passes; the guest's Bun (1.4) sends neither.
  Every ClientHello is checked, including the second one a server asks for
  with a HelloRetryRequest; after that the station passes bytes without
  looking.
- **Accepted risk.** Without decrypting, the station sees only the name a
  connection asks for. A whitelisted name served by a shared CDN can still be
  used to reach other sites on that CDN where the CDN routes on the HTTP host
  rather than the TLS name. The station still never connects anywhere but a
  whitelisted name's own public addresses.

### Which secrets: three kinds

| Kind | Example | How the VM gets it |
|---|---|---|
| **Long-lived, no narrow form** | an Anthropic API key, a Claude subscription token (`claude setup-token`, a year) | **Never.** The VM calls a station route (`http://127.0.0.1:8790/anthropic`) with a placeholder; the station adds the real one and makes the HTTPS call. |
| **Short-lived and narrow** | a GitHub App token for one repo for an hour; a harar token for an Addis app | **Handed to the VM.** A leak is bounded to that repo or app and that hour. |
| **None** | public package registries | Only the whitelist. |

- Station routes are named (`/anthropic`, later `/openai`), each with one
  upstream and one credential kind; there is no general credential proxy.
- A route's credential comes from harar: on a laptop the personal vault (read
  with the usual Touch ID approval per terminal), on a server a token the
  primary issues for that zone.
- mirab's own runtime uses an API key (`anthropic/api-key`); Claude Code in a
  VM uses a subscription token (`anthropic/claude-code`), since that token is
  meant for Claude Code itself.
- Audit: one line per call or connection (zone, route or host, status, bytes),
  never a credential.
- Keys for any service (a project's `.env` names `harar://` references): harar
  says where each may go (`hosts`, from a `send` permission or a per-user
  vault's `harar hosts allow`), the station opens only those hosts, and for
  each request asks harar to `send` the key for that one host, which harar
  decides again and records with the host. The VM only ever holds a
  placeholder.

## 5a. The agent manifest

mirab reads one thing about an agent: its **manifest**, plain data that
mirab's schema checks. There are two ways to write one, and both produce the
same manifest, so there is one definition of what an agent is.

```
agent/agent.ts  ─┐
                 ├──▶  manifest (JSON)  ──▶  mirab dev · mirab up
flake.nix       ─┘
```

| Field | What it is |
|---|---|
| `name` | The agent's harar name, `<org>.agent.<name>` |
| `model` | `provider/model`, reached through the station's route |
| `instructions` | The system prompt, from a file |
| `tools` | TypeScript tools (`defineTool`, run by the agent loop) or command tools (below) |
| `packages` | What its VM image holds besides the base |
| `domains` | Its zone's whitelist (section 5) |
| `channels` | The channels it joins (section 4) |

- **TypeScript:** `agent/agent.ts` exports `defineAgent({...})`, as today, with
  tools in `agent/tools/`.
- **Nix:** a flake output, read with `nix eval .#agents.<name> --json`:

  ```nix
  agents.ops = {
    name = "gg.addis.agent.ops";
    model = "anthropic/claude-sonnet-5-5";
    instructions = builtins.readFile ./instructions.md;
    packages = [ "ripgrep" "git" ];
    domains = [ "api.github.com" ];
    tools.search = {
      description = "Search the workspace";
      command = "rg";
      input = { type = "object"; properties.pattern.type = "string"; };
    };
  };
  ```

  The flake is only a way to write the manifest (no Node needed); the
  `packages` are the same apt names as in TypeScript, installed into the
  agent's image (section 5b). For people without Nix installed, mirab can
  evaluate the flake inside its build VM.

**Command tools** make an agent possible without any JavaScript: a tool is an
executable in the VM (Python, a shell script, a Go binary) with a JSON Schema
for its input. It gets the model's input as JSON on stdin, checked against the
schema first, and answers with JSON on stdout. The agent loop itself stays
TypeScript on Bun, inside the guest image, so someone writing a Nix agent never
installs Node.

**Packages and domains are what an agent asks for when it hits a wall**, and
in a manifest they are lines in git: an escalation is a diff a person approves
(harar approvals), and the station's whitelist for the zone is the manifest's
`domains`.

## 5b. Guest images

**The kernel is mirab's own.** Upstream Linux, unpatched, built from mirab's
minimal config (virtio, vsock, ext4, virtio-fs; no modules), its source pinned
by the SHA-256 kernel.org publishes. It is part of each mirab release, the
same for every VM, and changes only when mirab does; an agent never chooses
kernel features.

**The userspace is declarative Ubuntu.** Ubuntu 24.04, from
`guest-agent/rootfs.Dockerfile`, with mirab's init as process 1 (no systemd)
and Bun and Claude Code pinned by SHA-256.

- **Built once per agent, then cached.** The manifest's `packages` are an apt
  list installed on the release's base image, at their latest versions; the
  image is cached under the hash of the base and the list. Every session boots
  an APFS clone of it, so nothing is rebuilt to start an agent.
- **Updated by booting it.** An update check boots the cached image, runs
  `apt-get update` and a dry-run upgrade, and when something would change,
  upgrades in that VM and keeps its disk as the agent's new image (the old one
  stays, for rollback). Its only way out is the station, with the Ubuntu
  mirrors on the whitelist (HTTPS), and apt checks every package's signature.
- **Config from the manifest** (environment, files, the station's
  certificate) is applied by mirab's init at boot.
- **While a VM runs**, apt can install more through the station; a package
  outside the manifest is an escalation.
- **The coordinator** runs the same Ubuntu with systemd; the mirab release that
  brings it adds the kernel options systemd needs (cgroups) to the one kernel.
- Images are built in the build VM (Colima today) or in CI: macOS can't build
  Linux images itself.

**Later, mirab v2:** a NixOS-based guest ("mirab os"), for a fully pinned,
composable userspace with live `switch` and rollback.

## 6. Security, in one place

- Nothing listens for the outside world on a station; channels and tunnels
  dial out.
- No long-lived credential ever enters a VM. The station adds those per call,
  per route; a VM holds only short-lived, narrow tokens.
- A VM reaches only the domains on its zone's whitelist, and new ones need a
  person's approval.
- The VM's own network is off unless a policy allows it, and it never reaches
  the LAN, the host or another VM (`docs/VM.md`).
- An agent's powers are its harar grants. Channels carry messages, never
  power.
- Isolation refuses rather than downgrades, and says which level ran
  (`src/isolation/policy.ts`).

## 7. What is built

| Piece | State |
|---|---|
| VMs: `vz` (Apple silicon and Intel), Firecracker, containers, host user | Built (from gild); Intel `vz` proven on the iMac (#4) |
| Guest agent (Rust, vsock) and guest image | Built (from gild) |
| `mirab spawn` with the Claude and Codex adapters | Built (from gild); `--as`/`--channel` wait for #2 |
| `mirab init` | Built (#9) |
| The agent runtime (load a folder, run turns with tools) | Built (#11); started inside the VM with `mirab dev` |
| The agent manifest, command tools (section 5a) | Built (#19) |
| `mirab dev` | Built (#21) |
| The way out of a VM: whitelist, routes, keys for any service (section 5) | Built (#13, #15, #23, #25) |
| Per-agent images from `packages`, cached, updated by booting (section 5b) | Built (#28) |
| The Nix front end for the manifest (section 5a) | After that |
| Escalation: refused hosts asked for, allowed outside the VM (`mirab escalations`, `allow`) | Built (#33); as harar approvals for a station on an org primary, next |
| Station as a harar broker, `station install`, `up` | Phase 2 (needs harar's approvals and broker protocol) |
| Channels to apps | Phase 3 (needs harar's apps and channels) |

## 8. Decided, and open

- Decided (Sami, 24 Oct): one agent manifest, written in TypeScript or Nix;
  command tools (section 5a).
- Decided (Sami, 24 Oct): the kernel is mirab's own, one per release; the
  userspace is declarative Ubuntu, each agent's image built once from its
  `packages` (latest versions), cached, and updated by booting it and running
  apt (section 5b). A NixOS guest ("mirab os") is for mirab v2.
- Decided (Sami, 24 Oct): a whitelist of domains per zone, with escalation;
  the station adds only long-lived keys that have no narrow form.
- v1: the Anthropic route and the whitelist; GitHub through short-lived GitHub
  App tokens. OpenAI follows.
- Open: whether a laptop keeps both an API key (mirab's runtime) and a
  subscription token (Claude Code in a VM) in the personal vault, or only one.
  Both is the recommendation.
