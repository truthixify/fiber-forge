# fiber-forge

fiber-forge sets up a local Fiber payment-channel network with a single command. It starts a CKB
development chain and several Fiber nodes, funds them, connects them as peers, and opens the channels
between them. It then serves a web GUI where you can send payments, open and close channels, and
inspect each node. A working network is ready in under a minute.

[![Unit CI](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml)
[![Live E2E](https://github.com/truthixify/fiber-forge/actions/workflows/e2e.yml/badge.svg)](https://github.com/truthixify/fiber-forge/actions/workflows/e2e.yml)
[![npm](https://img.shields.io/npm/v/@truthixify/fiber-forge)](https://www.npmjs.com/package/@truthixify/fiber-forge)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/truthixify/fiber-forge?quickstart=1)

It was built for the "Gone in 60ms" Fiber Network Infrastructure Hackathon (Category 2). Lightning
developers use Polar for this kind of local testing; fiber-forge aims to be the equivalent for Fiber.

## Getting started

You need two things installed:

- **Docker, and it must be running.** fiber-forge runs each node in its own container. Linux amd64
  with Docker Engine and macOS arm64 with Docker Desktop are backed by complete live verification;
  WSL2 remains unverified. The first time you run `up`, fiber-forge downloads the `nervos/ckb` and
  `nervos/fiber` images, so that run takes a little longer. See the
  [host compatibility matrix](docs/compatibility.md) for exact versions, evidence, and limitations.
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

To try a real funded network without preparing Docker or Node.js locally, open the repository in a
private GitHub Codespace. Its checked-in sandbox starts a fixed three-node network, proves a
multi-hop payment, and exposes only the GUI through GitHub's authenticated private port forwarding.
It expires and purges its runtime state after four hours. See the [sandbox guide](docs/sandbox.md)
for the walkthrough, quota implications, controls, and exact reproducibility boundary.

## The GUI

Running `up` opens a web GUI, which is the main way to work with a network. It talks to a local
daemon over HTTP and a WebSocket, so it reflects the real state of the nodes and channels within a
second of any change.

- The graph is the network: each node — named after a scientist or philosopher, with a new set each
  time — and the channels between them, showing live balances and channel states.
- Click a node to open its panel. It shows the node's on-chain and UDT balances, its channels, and
  its streaming logs, which you can filter by level. The panel can stop, start, or restart that
  node with confirmation and reports the actual RPC, peer, and channel state afterward. The minimap
  in the bottom-left corner is clickable too — click a node there to jump to it.
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
fiber-forge node inspect trio feynman --json
fiber-forge node stop trio feynman  # retain the node's container and data
fiber-forge node start trio feynman # wait for RPC and report channel recovery
fiber-forge node restart trio feynman
fiber-forge fault apply trio peer-partition feynman --json
fiber-forge fault status trio --json
fiber-forge fault reset trio peer-partition feynman --json
fiber-forge fault reset-all trio --json
fiber-forge gui trio                # (re)open the GUI for a network
fiber-forge down trio               # remove one network (--keep CKB volume, --purge everything)
fiber-forge down --all              # remove every network at once

# move value (node names come from `up` or `status`)
fiber-forge pay trio feynman galileo 42          # multi-hop payment
fiber-forge invoice trio lorentz 100             # create an invoice
fiber-forge channel open trio feynman galileo 1000
fiber-forge channel ls trio
fiber-forge channel close trio feynman <id>
fiber-forge channel force-close trio feynman <id> --confirm <id> --json
fiber-forge channel settlement trio feynman <id> --json
fiber-forge logs trio feynman --level warn       # a node's logs (or 'ckb')

# dev-UDT asset channels (simple_udt, included in the devnet genesis)
fiber-forge udt issue trio feynman 10000
fiber-forge channel open trio feynman galileo 5000 --udt
fiber-forge pay trio feynman galileo 100 --udt

# traffic and scripting
fiber-forge run my-net ./examples/payments.yml   # checked actions and assertions
fiber-forge run my-net ./examples/outage-recovery.yml --json > report.json
fiber-forge export my-net --scenario ./examples/outage-recovery.yml --report report.json --output outage.ffbundle
fiber-forge bundle inspect outage.ffbundle --json # validates without Docker access
fiber-forge replay outage.ffbundle --network outage-replay --json # always purges the replay network
fiber-forge status trio --json | jq              # every data command accepts --json

# optional local Bitcoin/LND backend (used only by CCH workflows)
fiber-forge lightning up trio
fiber-forge lightning status trio --json
fiber-forge lightning down trio

# complete Fiber / CCH / Lightning topology
fiber-forge up cch
fiber-forge cch status cch --json
fiber-forge down cch --purge
```

Failures from `--json` commands are emitted as one parseable object with a stable `error.code`, the
affected resource when known, and a suggested next action. See
[Lifecycle errors](docs/lifecycle-errors.md) for the schema and code table.

Scenarios are versioned declarative test specifications with bounded polling, typed node/channel/
payment/balance assertions, sanitized JSON reports, and CI exit codes. The checked examples pair with
`examples/topology.yml`; see [Checked scenarios](docs/scenarios.md) for the complete schema.

The accepted [export and replay bundle contract](docs/export-bundles.md) limits shareable artifacts
to validated recipes and bounded diagnostics. Raw node keys, databases, and Docker volumes are
excluded; exact channel-state restoration is explicitly unsupported. A checked
[`failure.ffbundle`](docs/examples/export-v1/failure.ffbundle) reproduces the documented relay
outage without carrying source-machine state.

## Library API

Automation that needs more than the CLI can import the supported ESM API from
`@truthixify/fiber-forge/sdk`:

```ts
import { createFiberForge, preset } from "@truthixify/fiber-forge/sdk";

const forge = createFiberForge();
const topology = preset("trio");
if (!topology) throw new Error("trio preset is unavailable");

try {
  const layout = await forge.up(topology);
  console.log(await forge.inspect(layout.net));
} finally {
  await forge.down(topology.name, { purge: true });
}
```

The SDK exposes high-level network lifecycle and topology operations. Docker internals, generated
keys, raw RPC helpers, and source-file imports are not public API. See [the SDK contract](docs/sdk.md)
for the complete surface and compatibility policy. The [integration guide](docs/integration.md)
connects the CLI, SDK, GitHub Action, standalone example, sandbox, release status, and current
verification evidence without assuming repository internals.

## Topologies

Use a **preset** — `duo` (2 nodes), `trio` (3 nodes in an A—B—C line), `hub` (a 5-node star), or
the opt-in [`cch` cross-network topology](docs/cch-topology.md) — or
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

For the pinned Fiber image, restarting the same stopped relay container preserves its identity and
channels. `fiber-forge node start` and `node restart` wait for the real RPC, verify the saved public
key, and classify observed peer/channel recovery as `ready` or `action-required`. Peer reconnection
can still require reconnecting the original opener, so a process restart is never presented as
transparent channel recovery. The live test applies that bounded fallback when required and proves
a subsequent payment over the original channel IDs. See [Node recovery](docs/recovery.md).

Controlled faults cover abrupt node termination, CKB-preserving peer isolation, CKB dependency
loss, and pausing Fiber Forge's on-demand dev-chain mining. Requested state is persisted and every
fault has an inspectable reset path; teardown also removes a still-active fault. See
[Controlled fault injection](docs/fault-injection.md).

The code that talks to the nodes and the chain is split into small modules — `topology`, `keys`,
`rpc`, `engine`, `config`, `ckb`, `lightning`, `orchestrator`, `scenario`, `presets`, `cli`, and
`daemon` — each tested against a fake, so `make ci` never needs Docker. The optional
[Lightning backend](docs/lightning-backend.md) uses private Bitcoin/LND services and is loaded only
when explicitly requested.

## Development

```sh
make setup    # install the toolchain and dependencies
make test     # unit tests (the live Docker end-to-end test is behind FORGE_E2E=1)
make ci       # formatting, types, tests, build, and packed-artifact smoke — the CI gate
make sdk-test # build, typecheck, and execute a consumer through the package export
make package-test # install the tarball with production dependencies and smoke the CLI + SDK
make e2e       # packed-artifact smoke + live Docker proofs + local evidence
```

Run `make ci` before every push. Unit CI and live Docker verification are separate gates; every live
run publishes a bounded summary and sanitized diagnostics for 14 days. See
[Live verification](docs/verification.md) for the evidence schema and trigger/release policy.
Pushing a `v*` tag publishes to npm only after the same live workflow passes. The local live command
also checks the Docker daemon architecture and both image manifest lists before pulling.

## Roadmap

- **Richer assets** — xUDT with RCE rules, a stablecoin preset, and multiple named assets per node.
- **Resilience** — stuck HTLC simulation and force-close/on-chain settlement visibility.
- **Routing** — multi-path payments, per-hop fee and route inspection, and a view of the gossip graph.
- **Scenarios** — a curated library of portable failure and recovery recipes.
- **Cross-chain** — the local-only [CCH compatibility and trust boundary](docs/cch-feasibility.md)
  is proven in both directions, and the [disposable Lightning backend](docs/lightning-backend.md) is
  automated. The [integrated CCH topology](docs/cch-topology.md) now provisions and reports the full
  boundary; the packed-artifact two-direction CI proof remains the next step.
- **Reproducibility** — signed bundle provenance and broader cross-host replay evidence.

Force-close is an explicit local-dev operation with full-ID confirmation and terminal settlement
checks. See [Force-close and settlement](docs/force-close.md) for the RPC/state mapping and timeout
behavior.

## License

MIT.
