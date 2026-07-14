# fiber-forge

> One-click local Fiber networks: spin up a CKB devnet and N Fiber nodes, and open channels from a visual GUI — a working payment-channel playground in under a minute.

[![CI](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml)

Built for the **"Gone in 60ms" Fiber Network Infrastructure Hackathon** — Category 2.

## Status

**Working end to end.** `fiber-forge up trio` boots a CKB dev chain and three Fiber nodes, funds them,
connects them, and opens channels to `CHANNEL_READY` in well under a minute; multi-hop payments,
invoices, and live channel open/close are all verified against real nodes. The CLI is complete and
colorful; the web GUI serves a live network graph. Nodes are named after philosophers, scientists,
and historical figures — every network gets a fresh cast.

## Install

Requires a running Docker daemon (the tool pulls `nervos/ckb` and `nervos/fiber` on first run).

```sh
npx @truthixify/fiber-forge up trio        # run without installing
# — or —
npm install -g @truthixify/fiber-forge     # then use the `fiber-forge` command directly
```

The examples below use the global `fiber-forge` command. With `npx`, prefix each one with
`npx @truthixify/fiber-forge` instead. From a cloned repo, `node bin/fiber-forge.mjs <args>` runs the
same CLI with no build step.

## Usage

```sh
# lifecycle
fiber-forge up trio                 # boot 3 nodes + 2 channels → CHANNEL_READY
fiber-forge up                      # no preset → pick a topology in the GUI, then Forge it
fiber-forge ls                      # list all networks
fiber-forge status trio             # nodes + channels with live state
fiber-forge gui trio                # serve the live graph at http://127.0.0.1:5178
fiber-forge down trio               # tear down one (--keep data volume, --purge everything)
fiber-forge down --all              # tear down every network at once

# payments & channels (use the node names from `up`/`status`)
fiber-forge pay trio feynman galileo 42     # multi-hop payment
fiber-forge invoice trio lorentz 100        # create an invoice
fiber-forge channel open trio feynman galileo 1000
fiber-forge channel ls trio                 # channels with balances
fiber-forge channel close trio feynman <id>
fiber-forge logs trio feynman --level warn  # node logs (or 'ckb'), filtered by level

# scenario scripts — a little traffic generator (see examples/payments.yml)
fiber-forge run trio ./examples/payments.yml

# UDT asset channels (dev simple_udt, baked into the devnet genesis)
fiber-forge udt issue trio feynman 10000    # mint 10000 UDT to a node
fiber-forge channel open trio feynman galileo 5000 --udt
fiber-forge pay trio feynman galileo 100 --udt

# a custom network from your own topology file (see examples/topology.yml for the format)
fiber-forge up ./examples/topology.yml
fiber-forge status trio --json | jq
```

Presets: `duo` (2 nodes), `trio` (3), `hub` (5-node star), or **`shape:N`** for any count —
`line:N` (chain), `ring:N` (loop), `star:N` (hub + N-1 spokes), with N from 2 to 10. A topology
file declares `nodes`, `channels` (`from`/`to`/`capacity_ckb`), and `funding.per_node_ckb`. Every
data command takes `--json`.

Networks are independent: `fiber-forge up` auto-picks a free subnet and free host ports, so several can
run at once (`trio` **and** `line:5`, …) without clashing. `--ckb-port` / `--rpc-base` pin them.

## How it works

`up` plans a deterministic layout (container names, static IPs on a private subnet, host ports),
then: creates the docker network → boots the CKB dev chain (contracts baked into genesis) →
starts each fnn node with a generated, fnn-encrypted CKB key → waits for RPC → funds every node
from the genesis deployer via `@ckb-ccc/core` (with the devnet secp256k1 cell dep) → connects
peers → opens each channel → drives blocks until `CHANNEL_READY`. Nodes are also configured to
whitelist the devnet UDT, so `--udt` channels and payments work. The layout is persisted so the
GUI daemon can render a network's live state; it pushes updates over a WebSocket (`/ws`) and falls
back to polling. Module map: `topology` · `keys` · `rpc` · `engine` · `config` · `ckb` ·
`orchestrator` · `scenario` · `presets` · `cli` · `daemon`.

## Quickstart (development)

All tasks run through `make`:

```sh
make setup   # install toolchain / dependencies
make build
make test     # unit tests (the live Docker E2E is gated behind FORGE_E2E=1)
make ci      # fmt-check + lint + test + build (exactly what CI runs)

FORGE_E2E=1 npx vitest run test/e2e.test.ts   # the live forge-up-to-CHANNEL_READY test
```

Run `make ci` before every push.

## Roadmap

fiber-forge already spins up multi-node networks and drives CKB and UDT payments end to end. Where
it's headed next:

- **Richer assets** — xUDT with RCE rules, an RUSD / stablecoin preset, and multiple named assets
  per node, not just the dev `simple_udt`.
- **Resilience demos** — kill and restart nodes from the GUI, simulate stuck HTLCs, and visualize
  force-close and on-chain settlement (the watchtower story).
- **Routing lab** — multi-path payments, per-hop fee and route inspection, and a live view of the
  gossip graph and probing.
- **Scenario library** — named, shareable topology + traffic bundles with expected-outcome
  assertions, so a scenario doubles as a reproducible regression test.
- **Cross-chain** — `cch` (Fiber ↔ Lightning) hub demos and BTC bridging visualizations.
- **Reproducibility** — snapshot a network and its channel state to hand someone a bug or demo
  they can replay, plus support for remote / shared devnets.
- **Distribution** — a reusable GitHub Action for headless CI, and a `--version` flag to pin the
  fnn image as new releases land.

## License

MIT.
