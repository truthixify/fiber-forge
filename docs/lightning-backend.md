# Lightning Backend

Fiber Forge can attach a disposable Bitcoin regtest node and two authenticated LND nodes to an
existing managed Fiber network. This is the Lightning-side foundation for the local CCH topology.
It is opt-in: ordinary `up` commands neither pull nor start these images.

## Usage

Start a normal Fiber network first, then start or inspect its backend:

```sh
fiber-forge up duo --no-gui
fiber-forge lightning up duo
fiber-forge lightning status duo --json
fiber-forge lightning down duo
```

`fiber-forge down duo` also removes the backend containers and all four backend data volumes. The
backend has no host-published ports; Bitcoin RPC/ZMQ and LND peer/gRPC traffic remain inside the
managed Docker network.

## Pinned Services

The optional images are separate from the core CKB/Fiber image set in `package.json`, so core image
preflight and pull paths cannot load them accidentally.

| Service | Immutable image | Role |
| --- | --- | --- |
| Bitcoin Core 27.0 | `bitcoin/bitcoin:27.0@sha256:bf3748000b46aa9515f856326abbe61ce9f4f7af2ebf9da38930974323634f30` | Disposable regtest chain, wallet, mining, RPC, and ZMQ |
| LND 0.18.0-beta | `lightninglabs/lnd:v0.18.0-beta@sha256:dab0f5ae09615066d4c0f29f6f7444ab7e6c8a2548f56ea50288236b542095d4` | Separate hub and user Lightning nodes |

LND is the project's official release image. Its bundled verifier matched the release manifest
signed by six LND developers during feasibility review. The Bitcoin image is an unofficial testing
image whose build verifies upstream release binaries; Fiber Forge permits it only for disposable
regtest. See [Cross-Chain Hub Feasibility](cch-feasibility.md) for the full license, provenance,
platform, and trust review.

## Lifecycle

Startup is state-driven and bounded by one deadline:

1. Remove stale backend containers and volumes without touching the existing Fiber network.
2. Start Bitcoin Core, wait for `getblockchaininfo`, create a descriptor wallet, and mine 101 blocks
   so a regtest coinbase output is spendable.
3. Start the hub and user LND nodes and wait until both report `synced_to_chain` at the Bitcoin tip.
4. Bake a dedicated CCH macaroon with only invoice read/write and off-chain read/write permissions.
5. Fund the hub LND wallet with 5 regtest BTC, mine confirmations, and wait for both nodes to sync.
6. Open a 1,000,000-sat channel from hub to user, mine six confirmations, and require both endpoints
   to report the channel active.

Readiness never depends on a fixed startup sleep. Short delays occur only between bounded RPC polls.
An abort, timeout, image failure, RPC failure, or channel failure removes every backend container and
volume before the operation rejects. The shared Fiber network stays intact.

## Credentials And Status

Bitcoin Core creates its authentication cookie inside its data volume. Both LND nodes mount that
volume read-only, so no Bitcoin RPC password appears in a container command, process environment,
console message, or persisted plan. LND generates wallet keys, TLS material, and macaroons inside
its disposable volumes. The restricted CCH macaroon and a copy of the public TLS certificate are
staged in a separate credential volume; the admin macaroon and TLS private key remain in the hub
wallet volume. Credentials are never copied to the host or included in an export bundle. The later
CCH container mounts only the credential volume read-only.

JSON status is deliberately narrow:

```json
{
  "schemaVersion": 1,
  "kind": "lightning-backend",
  "net": "duo",
  "state": "ready",
  "bitcoin": { "container": "running", "blockHeight": 113 },
  "hub": {
    "container": "running",
    "syncedToChain": true,
    "blockHeight": 113,
    "activeChannels": 1,
    "localBalanceSats": 1000000
  },
  "user": {
    "container": "running",
    "syncedToChain": true,
    "blockHeight": 113,
    "activeChannels": 1,
    "localBalanceSats": 0
  },
  "channel": {
    "active": true,
    "capacitySats": 1000000,
    "hubLocalSats": 1000000,
    "userLocalSats": 0
  },
  "dataVolumesPresent": true
}
```

It omits wallet seeds, TLS keys, macaroons, RPC cookies, peer public keys, channel points, invoices,
and payment preimages. `degraded` means some resource exists but the complete chain/sync/channel
invariant is not currently true. `absent` means all three containers and all four volumes are gone.

## Verification

Unit tests use the same `ContainerEngine` boundary to cover every container-start failure, command
failure redaction, cancellation, partial-state reporting, and complete rollback. The real lifecycle
test runs the pinned images and verifies clean start, RPC-derived readiness, active liquidity, and
zero residue:

```sh
FORGE_LIGHTNING_E2E=1 npx vitest run test/lightning-e2e.test.ts
```

This backend alone does not claim a cross-network payment. The CCH service and two-direction payment
proof are separate layers documented by the CCH workflow and live evidence.
