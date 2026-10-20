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
- the `duo`, `trio`, and `hub` resolver plus line, ring, and star builders;
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
| `inspect(net)` / `list()` | Return `NetworkView` or `NetworkSummary[]`. | Best-effort inspection: unreachable nodes/chains are represented as stopped, zero, or omitted live data instead of making the whole view unavailable. RPC calls have a ten-second request bound. |
| `createInvoice`, `pay`, `payInvoice` | Return an invoice or `PaymentReport`. | RPC calls are bounded to ten seconds; route discovery retries for up to 30 seconds and payment settlement is observed for up to 60 seconds. These methods do not create or remove a network. |
| `openChannelBetween` / `closeChannel` / `channels` | Mutate or inspect channels. | Channel readiness is bounded to 120 seconds. Opens for the same network are serialized. A failed open leaves the existing network running for inspection or retry. |
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

**Stable:** the `./sdk` export path; topology parsing/builders; `planNetwork`; `createFiberForge`;
the `FiberForge` lifecycle methods; documented option/result types; and structured error codes.

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
