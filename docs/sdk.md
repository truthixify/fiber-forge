# Fiber Forge SDK

Fiber Forge exposes its supported programmatic API through the ESM-only
`@truthixify/fiber-forge/sdk` subpath. The package root remains CLI-oriented.

```ts
import { createFiberForge, preset } from "@truthixify/fiber-forge/sdk";

const topology = preset("trio");
if (!topology) throw new Error("trio preset is unavailable");

const forge = createFiberForge();
try {
  const layout = await forge.up(topology);
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

- `createFiberForge` and the `FiberForge` high-level lifecycle interface;
- topology parsing, validation, limits, and topology types;
- the `duo`, `trio`, and `hub` resolver plus line, ring, and star builders;
- layout, network view, channel, payment, and lifecycle option types; and
- `version`, read from the installed package metadata.

Low-level Docker operations, generated keys, dev-chain funding internals, raw Fiber RPC helpers,
and configuration rendering are implementation details. Importing files under `src/` or `dist/` is
unsupported.

## Compatibility

Documented exports follow the package's semantic version. While Fiber Forge remains below `1.0`, an
incompatible SDK change may occur in a minor release but not a patch release. Persisted network
state and topology compatibility are separate contracts and will be documented when versioning is
introduced for those formats.

The SDK supports Node.js 20 or newer and ESM imports. Network operations retain the CLI's local-only
scope: they manage disposable CKB and Fiber development networks and bind host RPC access to
loopback.
