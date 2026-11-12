# Integration guide and evidence

Fiber Forge has five distinct integration surfaces. Use the narrowest one that owns the lifecycle
you need.

| Surface | Owns | Use it when |
| --- | --- | --- |
| CLI | A human or script starts, inspects, and removes local networks. | You need terminal-driven local development. |
| SDK | Your Node.js process owns setup, payment operations, and `finally` cleanup. | Network lifecycle is part of an application or test harness. |
| GitHub Action | A workflow step starts a network; its registered post action owns job-final cleanup. | Later CI steps need live loopback endpoints. |
| Integration example | A small application consumes only the versioned connection document and Fiber JSON-RPC. | You need a concrete endpoint-consumer pattern. |
| Sandbox | A per-user development container owns Docker, expiry, reset, and the private GUI. | A reviewer needs a live network without local setup. |

## Version status

As of 2026-11-12, [`0.4.1`](https://www.npmjs.com/package/@truthixify/fiber-forge/v/0.4.1)
is the latest published npm package. It includes the CLI, public SDK, self-cleaning GitHub Action,
standalone integration example, Codespaces sandbox, strict loopback Docker bindings, recovery and
fault controls, safe export/replay, CCH transfer proofs, routing inspection, and the
[channel-liquidity GUI improvements from PR #3](https://github.com/truthixify/fiber-forge/pull/3).
The GUI additions cover stable asset styling and filters, directional-liquidity payment preflight,
prefilled channel recovery, pair selection, and navigable peer/channel rows.

The implementation promoted in `0.4.1` is pinned at immutable commit
[`9960c0eee7efdce288dbcb6d444e174c24b60e67`](https://github.com/truthixify/fiber-forge/commit/9960c0eee7efdce288dbcb6d444e174c24b60e67).
The release commit changes package metadata and current-version documentation; the runtime
implementation is unchanged from that reviewed default-branch commit. Use the release tag and
commands below when reproducing npm behavior.

Check the exact release without using a moving npm tag:

```sh
npx --yes @truthixify/fiber-forge@0.4.1 --version
```

## Reproduce the release

Node.js 20 or newer and a running Docker daemon are required. This clean-room sequence checks out
the exact release, installs its lockfile, verifies the packed package, then runs the
standalone application against a real three-node network:

```sh
git clone https://github.com/truthixify/fiber-forge.git
cd fiber-forge
git checkout v0.4.1
npm ci
npm run build
npm run test:package
npm run example:local
```

`example:local` packs the release, installs it with production dependencies into a fresh temporary
application, creates an isolated trio through `@truthixify/fiber-forge/sdk`, completes a one-CKB
`first -> third` payment, and purges its exact network and state in `finally`. Its source is under
[`examples/integration-app`](../examples/integration-app/README.md).

## SDK application

Install the exact stable version:

```sh
npm install --save-exact @truthixify/fiber-forge@0.4.1
```

Import only the declared subpath. Keep lifecycle ownership in one scope and always purge in
`finally`:

```js
import { createFiberForge, preset } from "@truthixify/fiber-forge/sdk";

const topology = preset("trio");
if (!topology) throw new Error("trio preset is unavailable");

const forge = createFiberForge();
try {
  const layout = await forge.up(topology);
  const payment = await forge.pay(
    layout.net,
    topology.nodes[0].name,
    topology.nodes[2].name,
    1,
  );
  if (payment.status !== "Success") throw new Error(payment.status);
} finally {
  await forge.down(topology.name, { purge: true });
}
```

The complete supported surface, deadlines, stable errors, and pre-1.0 compatibility rules are in
the [SDK contract](sdk.md). Imports from `src/`, `dist/`, Docker helpers, raw RPC helpers, and saved
`layout.json` are not public contracts.

## GitHub Action

Pin the Action code and npm package independently:

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v7
  - id: forge
    uses: truthixify/fiber-forge@9960c0eee7efdce288dbcb6d444e174c24b60e67
    with:
      package-version: 0.4.1
      topology: trio
  - run: node test/fiber-payment.mjs
    env:
      FIBER_FORGE_CONNECTION: ${{ steps.forge.outputs.connection-json }}
```

`connection-json` is a schema-versioned object:

```json
{
  "schemaVersion": 1,
  "network": "trio",
  "ckbRpc": "http://127.0.0.1:8114",
  "nodes": [
    {
      "name": "example-node",
      "pubkey": "<fiber-public-key>",
      "rpc": "http://127.0.0.1:8300"
    }
  ]
}
```

Treat node order as the topology order and select nodes by `name`; do not derive ports or read
Fiber Forge state files. The standalone consumer validates schema version 1, requires loopback HTTP
URLs, creates an invoice at the receiver, sends it from the first node, and checks the returned
payment status. See the [Action contract](github-action.md) for all inputs, outputs, cancellation
limits, diagnostics, and self-hosted-runner recovery.

## Hosted sandbox

[Open Fiber Forge in GitHub Codespaces](https://codespaces.new/truthixify/fiber-forge?quickstart=1)
to launch a per-user Docker-in-Docker tenant. It automatically starts a funded trio, proves a
multi-hop payment, forwards only GUI port 5178 privately, and purges runtime state after four hours.
The [sandbox guide](sandbox.md) covers reset, cost and quota ownership, isolation, and incident
disable. Creating a Codespace can consume the reviewer's GitHub quota; this repository does not
operate a shared or paid deployment.

## Compatibility and limits

- Supported live hosts are Linux amd64 and macOS arm64 with Docker Desktop. WSL2 and other host
  combinations remain unverified; see the [dated compatibility matrix](compatibility.md).
- All CKB and Fiber RPC publications bind to `127.0.0.1`. They are application-test endpoints, not
  remotely hosted APIs. The GUI is also loopback-only unless GitHub privately forwards it inside an
  authenticated Codespace.
- Every network is a disposable local CKB development chain. Funding cells, generated keys, and the
  bundled UDT have no production value. Testnet and mainnet are outside the supported scope.
- The Action supports Linux runners only. The SDK and CLI require Node.js 20 or newer. Native image
  availability alone does not establish a supported host.
- The Action post hook covers ordinary success, step failure, and normal cancellation, but no code
  can clean a runner after host loss or force cancellation. GitHub-hosted runners are disposable;
  self-hosted operators must apply the documented exact-network recovery command.

## Evidence index

| Claim | Exact evidence |
| --- | --- |
| Released CLI `0.2.9`, Linux amd64 live paths | [durable record](evidence/linux-amd64-2026-10-20.json), [workflow run](https://github.com/truthixify/fiber-forge/actions/runs/39363776395) |
| Released CLI `0.2.9`, macOS arm64 live paths | [durable record](evidence/macos-arm64-2026-10-20.json) |
| Promoted implementation, SDK, packed application, and Node 20/24 consumers | [CI run](https://github.com/truthixify/fiber-forge/actions/runs/43200024726) |
| Action success, deliberate consumer failure, and independent post cleanup | [merge-gate run](https://github.com/truthixify/fiber-forge/actions/runs/43200024822) |
| Linux live network, payment, recovery, UDT, replay, routing, rollback, and cleanup | [merge-gate run](https://github.com/truthixify/fiber-forge/actions/runs/43200024822) |
| Bidirectional CCH transfer proof with cold and warm starts | [merge-gate run](https://github.com/truthixify/fiber-forge/actions/runs/43200024822) |
| Codespaces/devcontainer launch on macOS arm64 | [sandbox record](evidence/sandbox-macos-arm64-2026-10-20.json) |

The `0.4.1` implementation boundary is commit `9960c0eee7efdce288dbcb6d444e174c24b60e67`.
Environment records retain their original package versions so historical claims remain auditable.
