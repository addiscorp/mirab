# mirab architecture

mirab runs agents on your own hardware. An agent is a folder; it runs whole
(its loop, its tools and every command it picks) inside a VM; it never holds a
credential; and it meets people in channels inside the apps it helps with. Its
identity, its grants and the channels it may join come from
[harar](https://github.com/addiscorp/harar).

Status: sections 1–4 are agreed (Sami, 24 Oct). Section 5 is a proposal for
review. Section 7 lists what is built.

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

So nothing the agent runs, and nothing a tool imports, can read a credential:
there is none in the VM. Every call out of the VM goes through the station
(section 5).

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
- gild's mention bridge (`src/spawn-bridge.ts`) is where this starts: it types
  a channel's @mentions into the agent today, against gild's forge (#2).

## 5. The station's outbound proxy (proposal)

The VM has no network unless a policy allows it. Calls the agent makes to
outside services (a model provider, GitHub, an Addis app) go to the station
instead, which decides, adds the credential and makes the call.

```
VM                                    station (host)                     outside
agent ──HTTP──▶ 127.0.0.1:8790 ──vsock──▶ outbound proxy ──HTTPS──▶ api.anthropic.com
   (placeholder key)   (guest agent forward)   1. who: the zone (from the hypervisor)
                                               2. may it? harar decides (zone, host, path)
                                               3. swap the placeholder for the real key
                                               4. audit: zone, host, path, status; never the key
```

- **No TLS interception.** The agent speaks plain HTTP to its own end of the
  tunnel, on loopback inside the VM, and the station makes the HTTPS call. SDKs
  already take a base URL (`ANTHROPIC_BASE_URL`, `baseURL`), so the agent is
  configured with `http://127.0.0.1:8790/anthropic` and a placeholder key.
- **The tunnel.** The guest agent gets a `forward` mode: it listens on a
  loopback port in the VM and carries each connection to a host vsock port.
  The hypervisor names the VM on the host side, so the station knows which
  zone is calling without trusting anything the VM says. (`vz` already relays
  guest-to-host vsock ports for the hook relay; Firecracker does the same over
  its vsock socket.)
- **Routes, not a general proxy.** The station serves named routes
  (`/anthropic`, `/openai`, `/github`), each with one upstream host and one
  credential kind. Anything else is refused. A route's credential comes from
  harar: on a laptop the personal vault, on a station a token the primary
  issues for that zone.
- **Subscriptions too.** Claude Code and Codex accept a base URL and a token,
  so a CLI agent in a VM can use a subscription the same way: the station adds
  the real token, and `gild vm login`'s copying of a token into the VM is gone
  for good.
- **Audit.** One line per call (zone, route, method, path, status, bytes),
  into harar's audit trail once the primary records decisions (harar M4).

## 6. Security, in one place

- Nothing listens for the outside world on a station; channels and tunnels
  dial out.
- No credential ever enters a VM. The station adds them per call, per route.
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
| `mirab init`, the agent runtime in the VM, `mirab dev` | Next |
| The outbound proxy (section 5) | Next, after review |
| Station as a harar broker, `station install`, `up` | Phase 2 (needs harar's approvals and broker protocol) |
| Channels to apps | Phase 3 (needs harar's apps and channels) |

## 8. Open questions

1. The proxy's route list for v1: Anthropic and GitHub only, or OpenAI too?
2. Where a laptop's model key lives: a harar personal-vault entry
   (`anthropic/api-key`) read with the usual Touch ID approval per terminal,
   or a subscription token from `claude setup-token` stored the same way.
