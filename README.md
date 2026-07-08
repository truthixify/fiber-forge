# fiber-forge

> One-click local Fiber networks: spin up a CKB devnet and N Fiber nodes, and open channels from a visual GUI — a working payment-channel playground in under a minute.

[![CI](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml)

Built for the **"Gone in 60ms" Fiber Network Infrastructure Hackathon** — Category 2.

## Status

**Working end to end.** `forge up trio` boots a CKB dev chain and three Fiber nodes, funds them,
connects them, and opens channels to `CHANNEL_READY` in well under a minute; multi-hop payments,
invoices, and live channel open/close are all verified against real nodes. The CLI is complete and
colorful; the web GUI serves a live network graph. Nodes are named after philosophers, scientists,
and historical figures — every network gets a fresh cast.

## Usage

Requires a running Docker daemon (the tool pulls `nervos/ckb` and `nervos/fiber` on first run).

```sh
npm install

# lifecycle
node bin/forge.mjs up trio                 # boot 3 nodes + 2 channels → CHANNEL_READY
node bin/forge.mjs ls                       # list all networks
node bin/forge.mjs status trio              # nodes + channels with live state
node bin/forge.mjs gui trio                 # serve the live graph at http://127.0.0.1:5178
node bin/forge.mjs down trio                # tear down (--keep data volume, --purge everything)

# payments & channels (use the node names from `up`/`status`)
node bin/forge.mjs pay trio feynman galileo 42     # multi-hop payment
node bin/forge.mjs invoice trio lorentz 100        # create an invoice
node bin/forge.mjs channel open trio feynman galileo 1000
node bin/forge.mjs channel ls trio                 # channels with balances
node bin/forge.mjs channel close trio feynman <id>
node bin/forge.mjs logs trio feynman --level warn  # node logs (or 'ckb'), filtered by level

# scenario scripts — a little traffic generator (see examples/payments.yml)
node bin/forge.mjs run trio ./examples/payments.yml

# UDT asset channels (dev simple_udt, baked into the devnet genesis)
node bin/forge.mjs udt issue trio feynman 10000    # mint 10000 UDT to a node
node bin/forge.mjs channel open trio feynman galileo 5000 --udt
node bin/forge.mjs pay trio feynman galileo 100 --udt

# a custom network, and machine-readable output
node bin/forge.mjs up ./my-topology.yml
node bin/forge.mjs status trio --json | jq
```

Presets: `duo` (2 nodes), `trio` (3), `hub` (5-node star), or **`shape:N`** for any count —
`line:N` (chain), `ring:N` (loop), `star:N` (hub + N-1 spokes), with N from 2 to 10. A topology
file declares `nodes`, `channels` (`from`/`to`/`capacity_ckb`), and `funding.per_node_ckb`. Every
data command takes `--json`.

Networks are independent: `forge up` auto-picks a free subnet and free host ports, so several can
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

## Docs

- [`docs/spec.md`](docs/spec.md) — the authoritative specification. Read it first.
- [`docs/fiber-integration.md`](docs/fiber-integration.md) — the shared Fiber (FNN) RPC reference.

## License

MIT — see [`LICENSE`](LICENSE).
