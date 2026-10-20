# Cross-Chain Hub Feasibility

## Decision

Proceed with a disposable, local-only CCH topology. The accepted minimum topology is:

- the existing Fiber Forge CKB dev chain;
- one Fiber user node and one Fiber hub node;
- one `simple_udt` channel whose base units represent wrapped satoshis at a fixed 1:1 test rate;
- one Bitcoin Core regtest node;
- one LND node controlled by the hub and one LND user node;
- one Lightning channel funded from the hub node to the user node; and
- a standalone CCH process connected to the Fiber hub over RPC and to the hub LND over authenticated
  gRPC.

This is a protocol-real local demonstration, not a production bridge. Bitcoin and CKB use their real
regtest/devnet consensus and transaction paths, both payment-channel implementations use real HTLCs,
and CCH couples the two legs with one payment hash. The wrapped asset, its 1:1 rate, initial issuance,
and the hub's liquidity remain trusted test fixtures.

The decision is grounded in Fiber's [CCH design summary](https://github.com/nervosnetwork/fiber/discussions/1243),
the exact `v0.9.0-rc7` [CCH RPC source](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/crates/fiber-lib/src/rpc/cch.rs),
and its [standalone reference flow](https://github.com/nervosnetwork/fiber/tree/bc361aaaa40d1394b83e6a1808869b0b06c48c13/tests/bruno/e2e/cross-chain-hub-separate).

## Pinned Compatibility

| Component | Accepted version | Immutable image | Basis |
| --- | --- | --- | --- |
| Fiber/FNN and CCH | `0.9.0-rc7`, commit `bc361aa` | `nervos/fiber:0.9.0-rc7@sha256:827d2eb4f557811c0f0f81268f993aae73d979eacfe48d36bd41d9041fe36081` | Existing Fiber Forge pin and successful two-way proof |
| CKB | `0.201.0`, commit `b7a95ac` | `nervos/ckb:v0.201.0@sha256:b995cd8b5f35571283d066f011317ef88b6d8e42f10c8b63c4c9ecf7b5cb647e` | Existing Fiber Forge pin and successful two-way proof |
| LND | `0.18.0-beta`, commit `fed7609` | `lightninglabs/lnd:v0.18.0-beta@sha256:dab0f5ae09615066d4c0f29f6f7444ab7e6c8a2548f56ea50288236b542095d4` | Fiber reference dependency and successful two-way proof |
| Bitcoin Core | `27.0.0` | `bitcoin/bitcoin:27.0@sha256:bf3748000b46aa9515f856326abbe61ce9f4f7af2ebf9da38930974323634f30` | Fiber reference dependency and successful regtest proof |

Fiber's exact dependency action pins CKB `0.202.0`, Bitcoin Core `27.0`, and LND `0.18.0-beta` in
[source](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/.github/actions/setup-dependencies/action.yml).
Fiber Forge proved the same Fiber/CCH build against its already-supported CKB `0.201.0`, so this
feature does not require changing the ordinary network compatibility contract.

The LND image is an [official release image](https://github.com/lightningnetwork/lnd/blob/v0.18.0-beta/docs/DOCKER.md).
Its bundled verifier matched `lnd` and `lncli` to the release manifest signed by six LND developers.
The Bitcoin image is explicitly an unofficial testing image. Its build source verifies upstream
Bitcoin Core release binaries, but Fiber Forge accepts it only for disposable regtest use; it is not
a production Bitcoin distribution recommendation.

All four manifest lists contain native `linux/amd64` and `linux/arm64` images. Availability is only a
preflight fact. The complete CCH flow was measured on macOS arm64 with Docker Desktop; Linux amd64
must pass the repository's live workflow before the CCH topology is advertised as supported there.

## Trust And Value Flow

```text
CKB dev deployer
  | mints disposable simple_udt units
  v
Fiber user -- wrapped-BTC HTLC --> Fiber hub node
                                          ^
                                          | authenticated private RPC
                                          v
                                    standalone CCH
                                          ^
                                          | TLS + restricted LND macaroon
                                          v
Lightning user <-- Bitcoin HTLC ---- hub LND
       ^                                  |
       |                                  |
       +------ Bitcoin regtest channel ---+
```

The incoming and outgoing HTLCs use the same SHA-256 payment hash. CCH waits for the incoming leg,
pays the outgoing invoice to obtain the preimage, then settles the incoming leg. Its observable order
states are `Pending`, `IncomingAccepted`, `OutgoingInFlight`, `OutgoingSuccess`, `Success`, and
`Failed`.

The signers and authorities are deliberately separate:

| Authority | Controls | Boundary |
| --- | --- | --- |
| CKB dev deployer key | Devnet funding and `simple_udt` issuance | Public test key, local chain only |
| Fiber user key | User CKB cells and Fiber channel balance | Generated per disposable network |
| Fiber hub key | Hub CKB cells and Fiber channel balance | Generated per disposable network |
| Hub LND wallet key | Hub Bitcoin outputs and Lightning channel balance | Generated inside a disposable volume |
| Lightning user LND key | User Lightning balance | Generated inside a disposable volume |
| Bitcoin regtest wallet | Block rewards and initial LND funding | Disposable local wallet |
| CCH LND macaroon | Invoice and off-chain payment operations on hub LND | Runtime-only mount, never exported |
| CCH Fiber RPC access | Add/settle invoices and send payments through the hub node | Private Docker network only |

Atomic hash-lock coupling does not remove operator trust. The hub chooses the quote, supplies both
liquidity pools, controls the wrapped asset reserve assumption, and can refuse service. No Bitcoin
deposit proof mints the dev UDT, no redemption contract enforces the 1:1 rate, and no mainnet or
testnet funds are involved.

## Required Interfaces

### CCH RPC

The standalone service exposes three JSON-RPC methods:

- `send_btc({ btc_pay_req, currency })` returns a Fiber invoice for a Lightning payee;
- `receive_btc({ fiber_pay_req })` returns a Lightning hold invoice for a Fiber payee; and
- `get_cch_order({ payment_hash })` returns the order and its terminal or non-terminal status.

Automation must poll `get_cch_order`; a successful initial request is not completion. Only `Success`
is a successful terminal state. `Failed`, an RPC error, or a bounded timeout fails the operation.

### Fiber RPC

The hub node needs `payment`, `invoice`, and `pubsub` modules in addition to the normal Fiber Forge
modules. Standalone CCH uses HTTP for commands and the matching WebSocket endpoint for store-change
notifications. The Fiber node's `simple_udt` whitelist and the CCH
`wrapped_btc_type_script` must match byte-for-byte.

### LND

CCH needs TLS-authenticated gRPC access to the hub LND. Disabling macaroons while listening on a
container interface is rejected by LND and is not an accepted workaround. Product orchestration must
bake a least-privilege macaroon containing only invoice read/write and off-chain read/write
permissions. The feasibility run used an ephemeral admin-macaroon copy in an isolated runtime mount
and deleted it at teardown, solely to establish the method inventory. Product orchestration must
mount the baked macaroon as a distinct read-only file.

### Readiness

Readiness is state-based rather than sleep-based:

1. Bitcoin Core answers `getblockchaininfo`, has a loaded regtest wallet, and has mined at least 101
   blocks so its coinbase output is spendable.
2. Both LND nodes report `synced_to_chain: true` at the Bitcoin tip.
3. The hub LND and user LND are peers and their funded channel reports `active: true`.
4. Both Fiber nodes answer `node_info`; the wrapped-asset channel reports `ChannelReady` on both
   sides and its type script matches the configured wrapped asset.
5. The CCH RPC answers and both dependencies remain reachable. An unknown `get_cch_order` hash may
   return `Key not found`; that proves transport readiness, not dependency health by itself.

## Manual Proof

The proof used `@truthixify/fiber-forge@0.4.0-rc.1` from commit
`0561302b466d5c926eb8a4b9602ff00043ab9f77` with warm image caches on 2026-10-20. The exact sanitized
record is [stored with the live evidence](evidence/cch-feasibility-macos-arm64-2026-10-20.json).

The reproducible sequence was:

1. Start a two-node Fiber Forge network, add `pubsub` to the hub RPC modules, and restart that node.
2. Start Bitcoin Core in regtest with RPC and ZMQ reachable only on the private Docker network.
3. Start two authenticated LND nodes, mine 101 blocks, fund the hub LND with 5 regtest BTC, open a
   1,000,000-sat channel from hub to user, mine six confirmations, and wait for `active: true`.
4. Start standalone CCH with the full wrapped type script, Fiber hub URL, hub LND TLS certificate,
   and macaroon mounted from runtime-only storage.
5. Issue 1 whole dev UDT to the Fiber user, open a 200,000-base-unit UDT channel to the hub, mine
   devnet blocks, and wait for `ChannelReady`.
6. Create a 100,000-sat Lightning invoice, call `send_btc`, pay the returned Fiber invoice, and poll
   the order to `Success`.
7. Create a signed 50,000-unit SHA-256 Fiber invoice, call `receive_btc`, pay the returned Lightning
   hold invoice, and poll the order to `Success`.
8. Remove the network and verify that its containers, network, volumes, state directory, copied TLS
   certificate, macaroon, invoices, and preimages are absent.

The exact upstream equivalent can be reproduced from commit `bc361aa` by following the
[standalone CCH README](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/tests/bruno/e2e/cross-chain-hub-separate/README.md).
That suite supplies all 17 RPC assertions and independently exercises the reference stack with CKB
`0.202.0`. Fiber Forge's automated CCH proof must retain the same two directions while using the
pinned product images above.

```sh
git clone https://github.com/nervosnetwork/fiber.git
cd fiber
git checkout bc361aaaa40d1394b83e6a1808869b0b06c48c13

# Install CKB 0.202.0, Bitcoin Core 27.0, LND 0.18.0-beta, jq, Rust, and Node.js.
./tests/deploy/lnd-init/setup-lnd.sh
./tests/nodes/start.sh e2e/cross-chain-hub-separate
cd tests/bruno
npm ci
npm exec -- @usebruno/cli run e2e/cross-chain-hub-separate -r --env test
```

The exact dependency downloads used by upstream CI are in its
[setup action](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/.github/actions/setup-dependencies/action.yml).
The commands intentionally use the upstream CKB `0.202.0` reference; the dated Fiber Forge evidence
separately proves its retained CKB `0.201.0` image.

### Observed Results

| Check | Before | After | Result |
| --- | ---: | ---: | --- |
| Wrapped units paid from Fiber user to hub | hub `0`, user `200,000` | hub `100,000`, user `100,000` | CCH order `Success` |
| Satoshis delivered to Lightning user | user `0` | user `100,000` | Invoice `SETTLED` |
| Satoshis paid from Lightning user to hub | user `100,000` | user `50,000` | Payment `SUCCEEDED`, fee `0` |
| Wrapped units delivered back to Fiber user | user `100,000`, hub `100,000` | user `150,000`, hub `50,000` | CCH order `Success` |

The first invoice existed for 22 seconds from creation through settlement, including manual RPC
steps. The reverse LND HTLC resolved in about 0.21 seconds. At the measured steady-state snapshot,
the seven containers used about 656 MiB in aggregate; CKB accounted for about 439 MiB. Persisted
runtime data was approximately 163 MiB for CKB, 150 MiB for both Fiber nodes, 18 MiB for Bitcoin,
and less than 2 MiB for both LND nodes. CCH's temporary bind mount reached 75 MiB, primarily its
Fiber store.

With images already cached, the operator-inclusive interval from the first CKB container start to
CCH RPC readiness was about 430 seconds. That includes inspection and two intentionally retained
failed LND starts: LND rejected unauthenticated public-interface gRPC and unencrypted
public-interface REST. From the corrected authenticated LND starts through Bitcoin funding,
Lightning channel activation, credential copying, and CCH readiness took about 168 seconds. The CCH
process itself answered RPC in under one second. These are feasibility observations, not performance
targets; automated orchestration must record its own phase timings without the manual pauses.

Only CKB (`127.0.0.1:8114`), the two Fiber RPCs (`127.0.0.1:8300-8301`), and the temporary CCH RPC
(`127.0.0.1:8400`) were mapped to the host. Bitcoin RPC/ZMQ and all LND ports stayed private to the
Docker network. Final residue checks found no matching container, network, volume, state directory,
macaroon, certificate, invoice, or preimage file.

## Implementation Contract

Implementation may proceed in this order:

1. Add lazy, digest-pinned Bitcoin and two-node LND orchestration through `ContainerEngine`, runtime
   credential generation, least-privilege macaroon baking, readiness checks, and full rollback.
2. Add a named CCH topology that extends the persisted layout with versioned backend state, enables
   Fiber `pubsub`, launches standalone CCH, and reports hub/backend health through CLI and GUI.
3. Add typed CCH RPC methods and a high-level two-direction proof that records payment hashes,
   amounts, order transitions, balance deltas, durations, and cleanup without recording invoices,
   preimages, wallet seeds, certificates, or macaroons.
4. Run that proof from the packed artifact on Linux amd64 and macOS arm64. A native manifest alone
   does not establish support.

The ordinary `duo`, `trio`, `hub`, and parametric topologies must not pull or start Bitcoin/LND/CCH.
CCH resources remain local, disposable, loopback/private-network scoped, and excluded from export
bundles. Mainnet, testnet, signet, public RPC exposure, production bridge custody, and arbitrary
external LND credentials remain out of scope.
