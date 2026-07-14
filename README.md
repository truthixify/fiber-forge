# fiber-forge

**Local Fiber networks, forged on demand.** One command heats up a CKB dev chain and a cluster of
Fiber nodes — funded, peered, channels open to `CHANNEL_READY` — then drops you onto a live visual
floor where you pay, open channels, and watch value move across hops. Cold machine to hot network in
under a minute.

[![CI](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@truthixify/fiber-forge)](https://www.npmjs.com/package/@truthixify/fiber-forge)

Built for the **"Gone in 60ms" Fiber Network Infrastructure Hackathon** (Category 2). Fiber has no
Polar; this is that tool.

## Light it up

You need exactly two things on the machine:

- **Docker, running.** fiber-forge builds every node as a container, so the Docker daemon must be up
  before you run anything — Docker Desktop on macOS/Windows, or the engine on Linux. (First run pulls
  `nervos/ckb` + `nervos/fiber`, once.)
- **Node.js 20+**, to launch the CLI with `npx`.

Then, from a cold start:

```sh
npx @truthixify/fiber-forge up trio
```

That forges a 3-node network with two funded channels and opens the GUI in your browser. Want it on
your PATH instead? `npm i -g @truthixify/fiber-forge`, then use the bare `fiber-forge` command and
drop the `npx @truthixify/` prefix everywhere below.

No shape in mind? `npx @truthixify/fiber-forge up` (no preset) opens the GUI straight on the **forge
screen** — pick a topology there, watch the preview, and hit **FORGE**.

When you're done: `... down trio` tears one network down, `... down --all` clears them all.

## The floor — the GUI

`up` opens a live web GUI, and it's the whole point. It talks to a local daemon over HTTP + a
WebSocket, so the graph reflects real node and channel state within a second of any change.

- **The graph is the network.** Nodes (a fresh cast of scientists and philosophers each time) wired
  by their channels, with live balances and per-channel state.
- **Click a node** → its panel slides in: on-chain + UDT balance, its channels, and streaming
  `docker logs` you can filter by level. The **minimap** (bottom-left) is clickable too — tap a dot
  to jump to that node.
- **Click a channel** → capacity and each side's balance; **SEND PAYMENT ACROSS** pre-loads a payment
  along it, with the asset (CKB or UDT) already matched to that channel.
- **⚡ PAY** routes a payment between any two nodes and animates the hops it takes.
- **SPAWN** opens the wizard — pick a preset and the topology preview redraws as you click, dial the
  node count, then forge it into a real, running network without leaving the browser.
- **The forge screen lists your existing networks** — click one to resume exactly where you left off.

Every action prints its CLI equivalent as you go, so anything you can click, you can script.

## Commands

```sh
# forge & tear down
fiber-forge up trio                 # 3 nodes + 2 channels → CHANNEL_READY, GUI opens
fiber-forge up                      # no preset → choose + forge in the GUI
fiber-forge up ./examples/topology.yml   # your own topology file
fiber-forge ls                      # every network on disk
fiber-forge status trio             # nodes + channels, live
fiber-forge gui trio                # (re)serve the GUI for a network
fiber-forge down trio               # remove one   (--keep data · --purge everything)
fiber-forge down --all              # remove every network at once

# move value  (node names come from `up` / `status`)
fiber-forge pay trio feynman galileo 42          # multi-hop payment
fiber-forge invoice trio lorentz 100             # create an invoice
fiber-forge channel open trio feynman galileo 1000
fiber-forge channel ls trio
fiber-forge channel close trio feynman <id>
fiber-forge logs trio feynman --level warn       # node logs (or 'ckb')

# dev-UDT asset channels (simple_udt, baked into the devnet genesis)
fiber-forge udt issue trio feynman 10000
fiber-forge channel open trio feynman galileo 5000 --udt
fiber-forge pay trio feynman galileo 100 --udt

# traffic + scripting
fiber-forge run trio ./examples/payments.yml     # scenario traffic generator
fiber-forge status trio --json | jq              # every data command takes --json
```

## Topologies

Reach for a **preset** — `duo` (2), `trio` (3, an A—B—C multi-hop line), `hub` (5-node star) — or a
**parametric shape** for any count: `line:N` (chain), `ring:N` (loop), `star:N` (hub + N−1 spokes),
`N` from 2 to 10. For an exact custom layout, hand `up` a **topology file**:

```yaml
name: my-net
nodes:
  - { name: alice }
  - { name: bob }
  - { name: carol }
channels:
  - { from: alice, to: bob,   capacity_ckb: 1000 }
  - { from: bob,   to: carol, capacity_ckb: 1000 }
funding:
  per_node_ckb: 100000
```

`fiber-forge up ./my-net.yml` — see `examples/topology.yml` for the annotated version. Networks are
independent (each grabs a free subnet + host ports), so `trio` **and** `line:5` can run side by side;
`--ckb-port` / `--rpc-base` pin them if you need fixed ports.

## Under the hood

`up` plans a deterministic layout (container names, static IPs on a private subnet, host ports), then
forges it in order: create the Docker network → boot the CKB dev chain (contracts baked into genesis,
~1s blocks) → start each `fnn` node with a generated, fnn-encrypted CKB key → wait for RPC → fund
every node from the genesis deployer (`@ckb-ccc/core`) → connect peers → open each channel → drive
blocks until `CHANNEL_READY`. Nodes whitelist the devnet UDT, so `--udt` channels and payments work
too. The layout persists under `~/.fiber-forge/<net>/`, and the daemon renders it live (WebSocket
push, polling fallback).

The node ↔ chain surface is isolated behind small modules — `topology · keys · rpc · engine · config
· ckb · orchestrator · scenario · presets · cli · daemon` — each unit-tested against a fake so
`make ci` never needs Docker.

## Develop

```sh
make setup    # install toolchain / deps
make test     # unit tests (the live Docker E2E is gated behind FORGE_E2E=1)
make ci       # fmt-check + lint + test + build — exactly what CI runs

FORGE_E2E=1 npx vitest run test/e2e.test.ts   # live up-to-CHANNEL_READY against real Docker
```

Run `make ci` before every push. A tag push (`v*`) publishes to npm via `.github/workflows/publish.yml`.

## Where it's headed

- **Richer assets** — xUDT with RCE rules, a stablecoin preset, multiple named assets per node.
- **Resilience** — kill/restart nodes from the GUI, stuck-HTLC simulation, force-close + on-chain
  settlement visualized.
- **Routing lab** — multi-path payments, per-hop fee/route inspection, a live view of the gossip graph.
- **Scenario library** — shareable topology + traffic bundles with expected-outcome assertions.
- **Cross-chain** — `cch` (Fiber ↔ Lightning) hub demos and BTC bridging.
- **Reproducibility** — snapshot a network + channel state to hand someone a replayable bug or demo.

## License

MIT.
