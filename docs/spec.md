> Shared conventions for this initiative (stack defaults, repo skeleton, Fiber ground
> rules, money-safety, submission checklist) live in this repo's `CLAUDE.md` and
> `docs/fiber-integration.md`.

# fiber-forge — build spec

> One-click local Fiber networks: a CLI + web GUI that spins up a CKB devnet and N Fiber nodes,
> opens channels visually, and gives any developer a working payment-channel playground in under
> a minute. Category 2. Stack: **TypeScript** (CLI + orchestrator + React GUI), Docker underneath.

## 1. Goal and gap

Standing up even a two-node local Fiber network today means: run a CKB dev chain, mine, fund
addresses, write two `config.yml`s, boot two `fnn` processes, exchange peer addresses, and drive
channel opening over raw JSON-RPC. Core issue #1262 (install/quick-start scripts) is still open;
every tutorial front-loads this pain. Lightning's answer was Polar — which won a hackathon and
became the ecosystem's standard dev tool. Fiber has nothing in this slot. fiber-forge is that
tool: `forge up trio` → three connected nodes with funded channels and a live graph GUI.

## 2. Deliverables

1. `forge` CLI (npm package): create/destroy/inspect local networks from presets or a topology file.
2. Web GUI served by `forge up`: live network graph, click-to-open channels, click-to-pay,
   per-node detail (balances, channels, logs), connection info for app integration.
3. Topology presets: `duo`, `trio` (A—B—C multi-hop), `hub` (1×4 hub-and-spoke); topology file
   schema (YAML) for custom networks.
4. Docs: quickstart, topology schema reference, "point your app at a forge node" guide.

## 3. Scope

**MVP:** CKB-denominated channels; the three presets + custom YAML; graph GUI with open/pay/close
actions and log streaming; deterministic teardown; works on macOS + Linux (amd64 + arm64).
**Stretch:** UDT asset preset (deploy an xUDT on the devnet, whitelist it in node configs,
open a UDT channel); scenario scripts (`forge run payments.yml` traffic generator); headless CI
mode (`forge up --no-ui --json`).
**Non-goals:** testnet/mainnet management (local devnet only); node version matrixing (pinned
image); Windows-native (WSL2 is the supported path).

## 4. Architecture

```
forge CLI ──► orchestrator (TS lib) ──► Docker Engine API (dockerode)
                    │                      ├── ckb container (dev chain + miner)
                    │                      └── fnn containers ×N (nervos/fiber, pinned)
                    ├──► funding module (devnet genesis key → transfers to node wallets)
                    ├──► fnn RPC clients (per node, via mapped ports)
                    └──► state store  (~/.fiber-forge/<network>/ : topology, ports, data dirs)
GUI (React/vite, served on localhost) ──► forge daemon HTTP+WS API (wraps orchestrator)
```

- One Docker network per forge network; fixed container names (`forge-<net>-ckb`,
  `forge-<net>-node-<i>`); host ports allocated from a base (8114 CKB, 8228+i per node RPC).
- CKB dev chain configured for ~1s blocks with the miner enabled, so funding and channel
  transactions confirm nearly instantly.
- Funding: the dev-chain genesis issued cells (well-known dev keys) are the treasury; the
  funding module builds simple transfers (via `@ckb-ccc/core`) to each node's wallet address,
  read from the node after boot.
- Node data dirs are host mounts, so `forge down --keep` preserves state and `forge up` resumes.

## 5. Fiber integration points

- Generated `config.yml` per node: RPC listen `0.0.0.0:8227` (mapped out), CKB RPC URL pointing
  at the ckb container, dev-chain network type.
- Wiring: `node_info` (readiness probe + pubkey/address harvest) → `connect_peer` (full-mesh or
  topology-defined) → `open_channel` (capacity from topology; poll `list_channels` until
  `CHANNEL_READY`) → payments via `new_invoice` on receiver + `send_payment` on sender →
  `shutdown_channel` for GUI close. All via the shared verified-method set; consult the OpenRPC
  JSON before touching any other field.

## 6. Functional requirements

- FR-1 `forge up <preset|file>` produces a network where every declared channel reaches
  `CHANNEL_READY`, or exits non-zero with a per-step error naming the failing node/channel.
- FR-2 `forge down` removes containers + network; `--keep` preserves data dirs; `--purge` wipes.
- FR-3 The GUI reflects node/channel/balance state within 2s of change (poll or WS push).
- FR-4 Opening a channel from the GUI requires only source, target, capacity; the orchestrator
  handles funding, acceptance, and readiness.
- FR-5 One-click payment: GUI picks receiver, generates an invoice, pays it from the chosen
  sender, and animates the route (multi-hop visible on `trio`).
- FR-6 `forge status --json` emits machine-readable network state (ports, pubkeys, channels)
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
6. Presets, `--json`, docs, README GIFs. E2E script: `forge up trio` → multi-hop payment
   asserts `Success` → `forge down` — this script is also CI.
7. Stretch items only after the E2E is green and recorded.

## 9. Acceptance criteria

- AC-1 On a clean machine with Docker: `npx fiber-forge up trio` → GUI open → multi-hop payment
  succeeds, in under 90 seconds total.
- AC-2 The E2E script passes in CI (Linux runner) headlessly.
- AC-3 Kill any single fnn container: GUI shows the node unhealthy within 2s; `forge up`
  after `down --keep` restores the network with channel state intact.
- AC-4 Topology validation rejects the documented error classes with named messages.
- AC-5 `make ci` green: lint, unit (parser, port allocator, orchestrator with mocked Docker),
  E2E behind a flag.

## 10. Demo script (~75s)

Blank terminal → `forge up trio` → containers pull/boot on screen → GUI opens showing three
nodes, channels animating to ready → drag-open a new channel alice→carol → one-click pay along
the 2-hop route, route animates, balances shift → `forge status --json` piped to `jq` ("and it's
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
