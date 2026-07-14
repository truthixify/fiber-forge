# fiber-forge — build spec

> **A forge for local Fiber networks.** A CLI + web GUI that heats a CKB devnet and N Fiber nodes
> into a funded, channels-open network — with a live floor to pay, wire, and inspect it — in under a
> minute. Category 2. Stack: **TypeScript** (CLI + orchestrator + React GUI) over Docker.

## 1. The gap it fills

Standing up even a two-node local Fiber network today is a slog: run a CKB dev chain, mine, fund
addresses, hand-write two `config.yml`s, boot two `fnn` processes, exchange peer addresses, then
drive channel opening over raw JSON-RPC. Core issue #1262 (quick-start scripts) is still open, and
every tutorial front-loads that pain. Lightning had Polar — a hackathon winner that became the
ecosystem's default dev tool; Fiber has an empty slot where it should be. fiber-forge fills it:
`fiber-forge up trio` → three peered nodes, funded channels, and a live graph, from one command.

## 2. Deliverables

1. `fiber-forge` CLI (npm package): create/destroy/inspect local networks from presets or a topology file.
2. Web GUI served by `fiber-forge up`: live network graph, click-to-open channels, click-to-pay,
   per-node detail (balances, channels, logs), connection info for app integration.
3. Topologies: named presets `duo`, `trio` (A—B—C multi-hop), and `hub` (5-node star); parametric
   shapes `line:N` (chain), `ring:N` (loop), and `star:N` (hub + N−1 spokes) for any `N` from 2 to
   10; plus a topology file schema (YAML) for fully custom networks. Several networks run at once,
   each on its own subnet and host ports.
4. Docs: quickstart, topology schema reference, "point your app at a fiber-forge node" guide.

## 3. Scope

**MVP:** CKB-denominated channels; the named presets (`duo`/`trio`/`hub`), parametric `shape:N`
topologies (`line`/`ring`/`star`), and custom YAML; graph GUI with open/pay/close actions and log
streaming; deterministic teardown; works on macOS + Linux (amd64 + arm64).
**Stretch:** UDT asset preset (deploy an xUDT on the devnet, whitelist it in node configs,
open a UDT channel); scenario scripts (`fiber-forge run payments.yml` traffic generator); headless CI
mode (`fiber-forge up --no-ui --json`).
**Non-goals:** testnet/mainnet management (local devnet only); node version matrixing (pinned
image); Windows-native (WSL2 is the supported path).

## 4. Architecture

```
fiber-forge CLI ──► orchestrator (TS lib) ──► Docker Engine API (dockerode)
                    │                      ├── ckb container (dev chain + miner)
                    │                      └── fnn containers ×N (nervos/fiber, pinned)
                    ├──► funding module (devnet genesis key → transfers to node wallets)
                    ├──► fnn RPC clients (per node, via mapped ports)
                    └──► state store  (~/.fiber-forge/<network>/ : topology, ports, data dirs)
GUI (React/vite, served on localhost) ──► fiber-forge daemon HTTP+WS API (wraps orchestrator)
```

- One Docker network per fiber-forge network; fixed container names (`forge-<net>-ckb`,
  `forge-<net>-node-<i>`); host ports allocated from a base (8114 CKB, 8228+i per node RPC).
- CKB dev chain configured for ~1s blocks with the miner enabled, so funding and channel
  transactions confirm nearly instantly.
- Funding: the dev-chain genesis issued cells (well-known dev keys) are the treasury; the
  funding module builds simple transfers (via `@ckb-ccc/core`) to each node's wallet address,
  read from the node after boot.
- Node data dirs are host mounts, so `fiber-forge down --keep` preserves state and `fiber-forge up` resumes.

## 5. Fiber integration points

- Generated `config.yml` per node: RPC listen `0.0.0.0:8227` (mapped out), CKB RPC URL pointing
  at the ckb container, dev-chain network type.
- Wiring: `node_info` (readiness probe + pubkey/address harvest) → `connect_peer` (full-mesh or
  topology-defined) → `open_channel` (capacity from topology; poll `list_channels` until
  `CHANNEL_READY`) → payments via `new_invoice` on receiver + `send_payment` on sender →
  `shutdown_channel` for GUI close. All via the shared verified-method set; consult the OpenRPC
  JSON before touching any other field.

## 6. Functional requirements

- FR-1 `fiber-forge up <preset|file>` produces a network where every declared channel reaches
  `CHANNEL_READY`, or exits non-zero with a per-step error naming the failing node/channel. With no
  argument, `fiber-forge up` opens the GUI on its spawn chooser to pick a topology and Forge it there.
- FR-2 `fiber-forge down <net>` removes containers + network; `--keep` preserves data dirs; `--purge`
  wipes; `--all` (no net) tears down every network at once.
- FR-3 The GUI reflects node/channel/balance state within 2s of change (poll or WS push).
- FR-4 Opening a channel from the GUI requires only source, target, capacity; the orchestrator
  handles funding, acceptance, and readiness.
- FR-5 One-click payment: GUI picks receiver, generates an invoice, pays it from the chosen
  sender, and animates the route (multi-hop visible on `trio`).
- FR-6 `fiber-forge status --json` emits machine-readable network state (ports, pubkeys, channels)
  for scripting and CI.
- FR-7 Per-node log panel streams `docker logs` with level filtering.
- FR-8 Topology file is validated with actionable errors (unknown node ref, capacity below
  channel reserve, duplicate names) before any container starts.

## 7. Topology schema (YAML)

```yaml
name: my-net
nodes:            # 2..10
  - name: alice
  - name: bob
  - name: carol
channels:
  - { from: alice, to: bob,   capacity_ckb: 500 }
  - { from: bob,   to: carol, capacity_ckb: 500 }
funding:
  per_node_ckb: 10000        # on-chain balance transferred at boot
```

## 8. Build order

1. **Spike: single node up.** Hand-write compose for ckb-dev + one fnn v0.8.1; prove funding →
   `node_info` returns. Everything hard is discovered here (image platforms, config quirks).
2. Orchestrator lib: network lifecycle (create/destroy), config generation, port allocation,
   readiness probes. Test: `duo` comes up and tears down cleanly, twice in a row.
3. Funding module + peer wiring + channel opening state machine. Test: `duo` reaches
   `CHANNEL_READY`; FR-1 error paths (kill a container mid-open) covered.
4. CLI surface (`up/down/status`) + topology parser/validator (FR-8 unit tests).
5. Forge daemon API (HTTP+WS) + GUI: graph view, node cards, open-channel modal, pay flow,
   log panel. Test: FR-3/4/5 against a live `trio`.
6. Presets, `--json`, docs, README GIFs. E2E script: `fiber-forge up trio` → multi-hop payment
   asserts `Success` → `fiber-forge down` — this script is also CI.
7. Stretch items only after the E2E is green and recorded.

## 9. Acceptance criteria

- AC-1 On a clean machine with Docker: `npx @truthixify/fiber-forge up trio` → GUI open →
  multi-hop payment succeeds, in under 90 seconds total.
- AC-2 The E2E script passes in CI (Linux runner) headlessly.
- AC-3 Kill any single fnn container: GUI shows the node unhealthy within 2s; `fiber-forge up`
  after `down --keep` restores the network with channel state intact.
- AC-4 Topology validation rejects the documented error classes with named messages.
- AC-5 `make ci` green: lint, unit (parser, port allocator, orchestrator with mocked Docker),
  E2E behind a flag.

## 10. Demo script (~75s)

Blank terminal → `fiber-forge up trio` → containers pull/boot on screen → GUI opens showing three
nodes, channels animating to ready → drag-open a new channel alice→carol → one-click pay along
the 2-hop route, route animates, balances shift → `fiber-forge status --json` piped to `jq` ("and it's
scriptable") → closing line: "yesterday this was an afternoon of YAML; the next hackathon's
participants get it in one command."

## 11. Risks and mitigations

- **Image/platform gaps** (arm64 Mac vs amd64 image): detect at startup, use `--platform`
  emulation fallback, document; worst case build-from-source Dockerfile included.
- **Funding/confirmation flakiness:** dev chain tuned to ~1s blocks; funding module waits on
  actual cell availability, not time.
- **Channel-open edge states:** state machine treats anything not `CHANNEL_READY` within a
  timeout as a named failure with the node's last log lines attached (feeds FR-1).
- **Demo risk:** images pre-pulled; recorded video fallback per submission rules.

## 12. Roadmap (post-hackathon)

Adopt v0.9 images behind a version flag · UDT/multi-asset presets by default · scenario
marketplace (shareable topology+traffic bundles) · headless CI mode as a GitHub Action ·
upstream the compose harness as the answer to fiber#1262 (DAO-grant scope).
