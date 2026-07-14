# fiber-forge

fiber-forge sets up a local Fiber payment-channel network with a single command. It starts a CKB
development chain and several Fiber nodes, funds them, connects them as peers, and opens the channels
between them. It then serves a web GUI where you can send payments, open and close channels, and
inspect each node. A working network is ready in under a minute.

[![CI](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@truthixify/fiber-forge)](https://www.npmjs.com/package/@truthixify/fiber-forge)

It was built for the "Gone in 60ms" Fiber Network Infrastructure Hackathon (Category 2). Lightning
developers use Polar for this kind of local testing; fiber-forge aims to be the equivalent for Fiber.

## Getting started

You need two things installed:

- **Docker, and it must be running.** fiber-forge runs each node in its own container, so the Docker
  daemon has to be up before you start — Docker Desktop on macOS or Windows, or the Docker engine on
  Linux. The first time you run `up`, fiber-forge downloads the `nervos/ckb` and `nervos/fiber`
  images for you; that happens once and makes the first run take a little longer.
- **Node.js 20 or newer**, so you can run the CLI with `npx`.

Then run:

```sh
npx @truthixify/fiber-forge up trio
```

This creates a network of three nodes with two funded channels and opens the GUI in your browser. If
you would rather install the command globally, run `npm i -g @truthixify/fiber-forge` and use
`fiber-forge` directly, without the `npx @truthixify/` prefix in the examples below.

To pick a topology in the GUI instead of naming one on the command line, run `fiber-forge up` with no
arguments. It opens the GUI on the network-creation screen, where you choose a shape and start it.

When you are finished, `fiber-forge down trio` removes one network, and `fiber-forge down --all`
removes all of them.

## The GUI

Running `up` opens a web GUI, which is the main way to work with a network. It talks to a local
daemon over HTTP and a WebSocket, so it reflects the real state of the nodes and channels within a
second of any change.

- The graph is the network: each node — named after a scientist or philosopher, with a new set each
  time — and the channels between them, showing live balances and channel states.
- Click a node to open its panel. It shows the node's on-chain and UDT balances, its channels, and
  its streaming logs, which you can filter by level. The minimap in the bottom-left corner is
  clickable too — click a node there to jump to it.
- Click a channel to see its capacity and the balance on each side. The **Send payment across**
  button starts a payment along that channel, with the asset (CKB or UDT) already set to match it.
- The **Pay** button sends a payment between any two nodes and animates the route it takes.
- The **Spawn** button opens the creation wizard. As you select a preset, the preview redraws to show
  that topology; you can adjust the node count and then create the network without leaving the browser.
- The creation screen also lists the networks you already have. Click one to reopen it and pick up
  where you left off.

Each action shows the equivalent CLI command as you perform it, so you can reproduce anything from
the terminal.

## Commands

```sh
# create and remove networks
fiber-forge up trio                 # 3 nodes, 2 funded channels, then open the GUI
fiber-forge up                      # choose and create a network in the GUI
fiber-forge up ./examples/topology.yml   # create from your own topology file
fiber-forge ls                      # list every network on disk
fiber-forge status trio             # show nodes and channels with live state
fiber-forge gui trio                # (re)open the GUI for a network
fiber-forge down trio               # remove one network (--keep data, --purge everything)
fiber-forge down --all              # remove every network at once

# move value (node names come from `up` or `status`)
fiber-forge pay trio feynman galileo 42          # multi-hop payment
fiber-forge invoice trio lorentz 100             # create an invoice
fiber-forge channel open trio feynman galileo 1000
fiber-forge channel ls trio
fiber-forge channel close trio feynman <id>
fiber-forge logs trio feynman --level warn       # a node's logs (or 'ckb')

# dev-UDT asset channels (simple_udt, included in the devnet genesis)
fiber-forge udt issue trio feynman 10000
fiber-forge channel open trio feynman galileo 5000 --udt
fiber-forge pay trio feynman galileo 100 --udt

# traffic and scripting
fiber-forge run trio ./examples/payments.yml     # run a scenario of scripted traffic
fiber-forge status trio --json | jq              # every data command accepts --json
```

## Topologies

Use a **preset** — `duo` (2 nodes), `trio` (3 nodes in an A—B—C line), or `hub` (a 5-node star) — or
a **parametric shape** for any node count: `line:N` (a chain), `ring:N` (a loop), or `star:N` (a hub
with N−1 spokes), where N is 2 to 10. For a specific layout, pass `up` a **topology file**:

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

Run it with `fiber-forge up ./my-net.yml`. `examples/topology.yml` is an annotated version. Each
network gets its own subnet and host ports, so several can run at the same time (for example `trio`
and `line:5`); use `--ckb-port` and `--rpc-base` if you need to fix the ports.

## How it works

`up` plans a layout — container names, static IPs on a private subnet, and host ports — and then
builds it in order: it creates the Docker network, boots the CKB dev chain (with the contracts in its
genesis and roughly one-second blocks), starts each `fnn` node with a generated and fnn-encrypted CKB
key, waits for each node's RPC, funds every node from the genesis deployer using `@ckb-ccc/core`,
connects the peers, opens each channel, and drives blocks until every channel reaches
`CHANNEL_READY`. The nodes are configured to accept the devnet UDT, so `--udt` channels and payments
work as well. The layout is saved under `~/.fiber-forge/<net>/`, and the daemon renders it live,
pushing updates over a WebSocket and falling back to polling.

The code that talks to the nodes and the chain is split into small modules — `topology`, `keys`,
`rpc`, `engine`, `config`, `ckb`, `orchestrator`, `scenario`, `presets`, `cli`, and `daemon` — each
tested against a fake, so `make ci` never needs Docker.

## Development

```sh
make setup    # install the toolchain and dependencies
make test     # unit tests (the live Docker end-to-end test is behind FORGE_E2E=1)
make ci       # fmt-check, lint, test, and build — the same steps CI runs

FORGE_E2E=1 npx vitest run test/e2e.test.ts   # run a real network up to CHANNEL_READY
```

Run `make ci` before every push. Pushing a `v*` tag publishes to npm through
`.github/workflows/publish.yml`.

## Roadmap

- **Richer assets** — xUDT with RCE rules, a stablecoin preset, and multiple named assets per node.
- **Resilience** — stop and restart nodes from the GUI, simulate stuck HTLCs, and show force-close
  and on-chain settlement.
- **Routing** — multi-path payments, per-hop fee and route inspection, and a view of the gossip graph.
- **Scenarios** — shareable topology and traffic bundles with expected-outcome assertions.
- **Cross-chain** — `cch` (Fiber ↔ Lightning) hub demos and BTC bridging.
- **Reproducibility** — snapshot a network and its channel state so someone can replay a bug or demo.

## License

MIT.
