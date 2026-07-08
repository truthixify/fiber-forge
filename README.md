# fiber-forge

> One-click local Fiber networks: spin up a CKB devnet and N Fiber nodes, and open channels from a visual GUI — a working payment-channel playground in under a minute.

[![CI](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml)

Built for the **"Gone in 60ms" Fiber Network Infrastructure Hackathon** — Category 2.

## Status

**Working.** `forge up trio` boots a CKB dev chain and three Fiber nodes, funds them, connects
them, and opens channels to `CHANNEL_READY` in well under a minute — verified live end to end
(see the `e2e` test). The CLI (`up` / `down` / `status` / `gui`) and the web GUI are functional.

## Usage

Requires a running Docker daemon (the tool pulls `nervos/ckb` and `nervos/fiber` on first run).

```sh
npm install
node bin/forge.mjs up trio          # 3 nodes, 2 channels → CHANNEL_READY
node bin/forge.mjs gui trio         # serve the live graph at http://127.0.0.1:5178
node bin/forge.mjs status trio      # container states
node bin/forge.mjs down trio --purge

# a custom network from a topology YAML:
node bin/forge.mjs up ./my-topology.yml
```

Presets: `duo` (2 nodes), `trio` (3), `hub` (5-node star), or **`shape:N`** for any count —
`line:N` (chain), `ring:N` (loop), `star:N` (hub + N-1 spokes), with N from 2 to 10. A topology
file declares `nodes`, `channels` (`from`/`to`/`capacity_ckb`), and `funding.per_node_ckb`.

Networks are independent: `forge up` auto-picks a free subnet and free host ports, so several can
run at once (`trio` **and** `line:5`, …) without clashing. `--ckb-port` / `--rpc-base` pin them.

## How it works

`up` plans a deterministic layout (container names, static IPs on a private subnet, host ports),
then: creates the docker network → boots the CKB dev chain (contracts baked into genesis) →
starts each fnn node with a generated, fnn-encrypted CKB key → waits for RPC → funds every node
from the genesis deployer via `@ckb-ccc/core` (with the devnet secp256k1 cell dep) → connects
peers → opens each channel → drives blocks until `CHANNEL_READY`. The layout is persisted so the
GUI daemon can render a network's live state. Module map: `topology` · `keys` · `rpc` · `engine`
· `config` · `ckb` · `orchestrator` · `presets` · `cli` · `daemon`.

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
- [`CLAUDE.md`](CLAUDE.md) — the working agreement.

## License

MIT — see [`LICENSE`](LICENSE).
