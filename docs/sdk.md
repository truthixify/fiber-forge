# Fiber Forge SDK

Fiber Forge exposes its supported programmatic API through the ESM-only
`@truthixify/fiber-forge/sdk` subpath. The package root remains CLI-oriented.

The SDK documented here belongs to the `0.4.0-rc.1` release candidate and is not yet published on
npm. Use the packed candidate workflow in the [integration guide](integration.md) for current
verification. Do not install `0.2.9` expecting this export; that released version predates the SDK.
Once `npm view @truthixify/fiber-forge@0.4.0-rc.1 version` succeeds, applications can pin it with
`npm install --save-exact @truthixify/fiber-forge@0.4.0-rc.1`.

```ts
import { createFiberForge, preset } from "@truthixify/fiber-forge/sdk";

const topology = preset("trio");
if (!topology) throw new Error("trio preset is unavailable");

const forge = createFiberForge();
const controller = new AbortController();
try {
  const layout = await forge.up(topology, {
    signal: controller.signal,
    timeoutMs: 10 * 60_000,
    onProgress: (message) => console.log(message),
  });
  const result = await forge.pay(
    layout.net,
    topology.nodes[0].name,
    topology.nodes[2].name,
    42,
  );
  console.log(result);
} finally {
  await forge.down(topology.name, { purge: true });
}
```

The default client uses Docker and stores network layouts under `~/.fiber-forge`. Tests and tools
that need isolated state can pass `createFiberForge({ stateDir })`.

## Public Contract

The SDK exports:

- `createFiberForge`, `FiberForge`, and the high-level lifecycle option/result types;
- `planNetwork`, which validates and plans deterministic names, ports, and addresses without Docker;
- topology parsing, validation, limits, and topology types;
- scenario parsing/running plus typed recipe export, inert bundle inspection, and fresh replay;
- the `duo`, `trio`, `hub`, and opt-in `cch` resolver plus line, ring, and star builders;
- `ForgeError`, `errorDetails`, and the stable `ForgeErrorCode`/`ForgeErrorDetails` types;
- layout, network view, channel, payment, and lifecycle option types; and
- `version`, read from the installed package metadata.

Low-level Docker operations, generated keys, dev-chain funding internals, raw Fiber RPC helpers,
and configuration rendering are implementation details. Importing files under `src/` or `dist/` is
unsupported.

## Operation Contracts

| Operation | Input and result | Bound and cleanup behavior |
| --- | --- | --- |
| `planNetwork(topology, layout?)` | A `Topology`; returns a deterministic `NetworkLayout` without I/O. | Synchronous. It does not reserve ports or inspect Docker, so `up` can resolve conflicts differently when ports/subnets are omitted. |
| `up(topology, options?)` | Returns the created `NetworkLayout` after every declared channel is ready and routing gossip is visible. | Ten-minute overall default (`DEFAULT_PROVISION_TIMEOUT_MS`), configurable with `timeoutMs`; accepts `signal`. Abort/timeout is cooperative, and rollback completes before rejection. |
| `runScenario(net, scenario, options?)` | Accepts parsed `Scenario` or JSON/YAML source and returns a `ScenarioReport`. | The parser bounds actions and waits; `signal` interrupts waits/polling and rejects with `OPERATION_ABORTED`. |
| `exportBundle(net, options)` | Writes a new recipe or diagnostic `.ffbundle`; returns its path, level, size, artifact count, and semantic digest. | Refuses overwrite. It canonicalizes topology/scenario/report data, omits descriptions, excludes all keys/databases/volumes, and bounds/redacts diagnostics. Legacy layouts require their original topology source. |
| `inspectBundle(path)` | Returns verified manifest, recipe summary, and compatibility without exposing artifact contents. | Read-only: no Docker call, image pull, extraction, adjacent file, or scenario execution. The complete archive is validated first. |
| `replayBundle(path, options)` | Provisions `options.network`, runs the recipe, compares portable outcomes, and returns `ReplayBundleResult`. | Requires an absent caller-selected target, exact package/image pins, a supported host, and a bounded timeout. Success, mismatch, cancellation, and post-provision failure all purge the target before return/rejection. |
| `inspect(net)` / `list()` | Return `NetworkView` or `NetworkSummary[]`. | Best-effort inspection: unreachable nodes/chains are represented as stopped, zero, or omitted live data instead of making the whole view unavailable. RPC calls have a ten-second request bound. |
| `cchStatus(net)` | Returns the versioned Fiber/CCH/Lightning boundary status for an integrated CCH topology. | Reports `unsupported` for an ordinary Fiber network without pulling or starting any CCH dependency. CCH readiness is derived from the operator RPC, private Lightning backend, both Fiber nodes, and the exact wrapped channel. |
| `proveCchTransfers(net, options?)` | Executes Fiber-to-Lightning and Lightning-to-Fiber transfers and returns a secret-safe `CchTransferProofReport`. | Local `cch` topologies only. The overall terminal-settlement timeout defaults to two minutes and accepts `signal`; success requires CCH `Success`, matching payment hashes, terminal Fiber/Lightning state, and exact balance deltas in both directions. |
| `inspectNode(net, node)` | Returns a `NodeLifecycleReport` without mutation. | Reads actual Docker state. A running node is checked for RPC identity, peers, and channels; stopped or externally removed containers remain explicit states. |
| `stopNode` / `startNode` / `restartNode` | Return a shared `NodeLifecycleReport`; start/restart accept `NodeLifecycleOptions`. | Operations on the same node are serialized. Stop retains the exact container and mounted state. Start/restart wait up to 60 seconds for RPC and identity, then observe automatic peer/channel recovery for up to 10 seconds. Repeats return `changed: false` when already in the requested state. |
| `applyFault` / `faultStatus` / `resetFault` / `resetAllFaults` | Apply, inspect, or reset a portable `FaultKind`; return `FaultReport` values. | Fault transitions are serialized per network and atomically persisted. Node kill and network isolation require matching engine capabilities. Reset waits for the relevant RPC and reports incomplete channel recovery honestly. |
| `mineBlocks(net, count?)` | Returns a `MineReport` with the prior and resulting tip. | Generates 1-1000 blocks through the managed dev-chain control path and rejects with `MINING_PAUSED` while that fault is active. |
| `createInvoice`, `pay`, `payInvoice` | Return an invoice or `PaymentReport`. Unclassified Fiber routing/transport failures reject with `PAYMENT_FAILED`. | RPC calls are bounded to ten seconds; route discovery retries for up to 30 seconds and payment settlement is observed for up to 60 seconds. These methods do not create or remove a network. |
| `openChannelBetween` / `closeChannel` / `channels` | Mutate or inspect channels. | Channel readiness is bounded to 120 seconds. Opens for the same network are serialized. A failed open leaves the existing network running for inspection or retry. |
| `forceCloseChannel` / `inspectChannelSettlement` | Force-close disposable local value or reconstruct its Fiber/CKB settlement state. | Force-close requires `confirmChannelId` to exactly match the target. Timeouts return a diagnostic report rather than dropping transaction identifiers. Success requires terminal Fiber flags and a committed CKB closing transaction. |
| `issueUdt` / `fund` | Return the submitted transaction hash. | Operate only against the disposable local dev chain; they never access testnet or mainnet. |
| `down(net, options?)` / `downAll(options?)` | Resolve after requested resources are removed; `downAll` returns attempted network names. | Teardown is intentionally not abortable. It continues after individual failures, then throws a structured aggregate error so cleanup can be retried safely. |
| `logs(net, node, tail?, level?)` | Returns recent plain-text container logs. | Local Docker access only; no streaming or remote transport contract. |

`onProgress` is synchronous and informational. Messages may improve in minor releases and must not
be parsed as structured state. If the callback throws or aborts the supplied signal, provisioning
fails and the same rollback contract applies. An abort cannot interrupt a Docker or HTTP call that
is already in flight, but it is checked before and after each provisioning phase and during every
polling delay.

Always put teardown in `finally`. Abort and timeout already roll back an incomplete `up`, while the
`finally` handles failures in application code after a successful start.

`NodeLifecycleReport.recovery` is `ready` only when every declared neighbor is connected and has a
`ChannelReady` channel from the operated node. `action-required` is a truthful post-operation
observation, not a failed process start; use `nextAction` and inspect the network before reconnecting
or reopening anything. `restartNode` never replaces the container, key, or node database.

Faults are local test controls, not production network policy. `peer-partition` moves one Fiber node
to a CKB-only managed bridge; it does not install firewall rules. `mining-pause` gates Fiber Forge's
on-demand miner because the bundled Dummy-PoW chain does not mine in the background. See
[Controlled fault injection](fault-injection.md).

## Errors

Lifecycle failures reject with `ForgeError`. Automation can safely branch on `code` and serialize
`errorDetails(error)` without depending on error-message text:

```ts
import { errorDetails, type ForgeErrorCode } from "@truthixify/fiber-forge/sdk";

try {
  await forge.up(topology);
} catch (error) {
  const details = errorDetails(error);
  const code: ForgeErrorCode = details.code;
  console.error(JSON.stringify(details));
  if (code === "OPERATION_TIMEOUT") {
    // Increase timeoutMs or inspect the resource named by details.resource.
  }
}
```

Unknown exceptions are normalized to `UNEXPECTED`. The complete code list and JSON shape are in
[Lifecycle errors](lifecycle-errors.md).

## Dependency Injection

Applications should depend on the public interface, or a `Pick` of the operations they use, and
construct the Docker-backed client only at the composition root:

```ts
import {
  createFiberForge,
  type FiberForge,
} from "@truthixify/fiber-forge/sdk";

type PaymentNetwork = Pick<FiberForge, "up" | "pay" | "down">;

export async function verifyPayment(forge: PaymentNetwork) {
  // Application workflow; tests can inject a small in-memory implementation.
}

await verifyPayment(createFiberForge());
```

Custom Docker engines and raw RPC transports are deliberately not public injection points. They
would couple applications to orchestration internals and imply a general remote-node SDK, which
Fiber Forge does not provide.

## Stability Levels

**Stable:** the `./sdk` export path; topology/scenario parsing; topology builders; `planNetwork`;
`createFiberForge`; the `FiberForge` lifecycle and bundle methods; documented option/result types;
and structured error codes.

**Experimental:** overriding `ckbImage` or `fnnImage`, UDT issuance/channel behavior, and the exact
human-readable progress messages. These are typed for current consumers but can change in a minor
pre-1.0 release.

**CLI-only or internal:** GUI/daemon HTTP routes, raw CKB/Fiber RPC wrappers, Docker resource
primitives, generated key handling, container config rendering, and direct `src/` or `dist/` imports.

## Compatibility

Documented exports follow the package's semantic version. While Fiber Forge remains below `1.0`, an
incompatible SDK change may occur in a minor release but not a patch release. Persisted network
state under `stateDir` is an internal recovery record, not an interchange format: patch releases
must continue to read state from the same minor line, while a minor release may migrate or reject it
with an actionable error. Applications should use SDK results rather than reading `layout.json`.

CI compares the generated `sdk.d.ts` with a reviewed declaration snapshot and rejects internal
Docker, chain, and RPC types in that declaration. Any public signature change therefore requires an
intentional contract update.

The SDK supports Node.js 20 or newer and ESM imports. Network operations retain the CLI's local-only
scope: they manage disposable CKB and Fiber development networks and bind host RPC access to
loopback.
