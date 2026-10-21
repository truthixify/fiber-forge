# Routing and Gossip Inspection

Fiber Forge can inspect the gossip graph held by any managed Fiber node and can ask Fiber to build
and execute an explicit route. The graph, inferred connectivity, attempted route, and successful
route are deliberately separate concepts.

All commands in this document operate only on a disposable local Fiber Forge network.

## Commands

```sh
# Query one node's graph. Output is capped even if a larger limit is requested.
fiber-forge route graph trio --node alice --limit 80 --json

# Ask Fiber to build and price alice -> bob -> carol without sending value.
fiber-forge route inspect trio alice carol 41 --via bob --json

# Execute the exact router returned by Fiber and wait for terminal payment state.
fiber-forge route pay trio alice carol 41 --via bob --json

# The same explicit path for the bundled development UDT.
fiber-forge route inspect trio alice carol 100 --via bob --udt --json
```

`--via` is an ordered comma-separated list of intermediate managed-node names. The sender and
receiver are added automatically. An explicit path is limited to eight hops, cannot repeat a node,
and is rejected before payment when Fiber cannot build the requested router.

In the GUI, open **Routes** to inspect the selected network's live gossip graph. Channel detail
shows capacity, asset, both directional announcements, enabled state, outbound liquidity, fee rate,
and age. The route form may prefill intermediates from graph connectivity, but labels that value as
inferred. **Inspect** calls Fiber's router builder; **Send** builds and executes an explicit route.

## Pinned Fiber RPC Inventory

The implementation is verified against `nervos/fiber:0.9.0-rc7` and Fiber source commit
`bc361aaaa40d1394b83e6a1808869b0b06c48c13`.

| RPC | Data used by Fiber Forge | Interpretation |
| --- | --- | --- |
| `graph_nodes` | Public key, announced name, version, addresses, features, chain hash, auto-accept minimum, timestamp | One node's local gossip view, not a global authoritative registry. |
| `graph_channels` | Outpoint, endpoints, capacity, chain hash, UDT script, creation time, and two optional directional updates | Each direction independently carries enabled state, advertised outbound liquidity, fee rate, minimum TLC, expiry delta, and timestamp. A missing direction stays explicitly missing. |
| `build_router` | `router_hops` containing target, channel outpoint, amount received, and incoming TLC expiry | Fiber chooses channels and computes amounts/fees while honoring the supplied ordered hop requirements. These hops are actual Fiber output. |
| `send_payment_with_router` | Payment hash and terminal status after executing the returned router | Fiber Forge reports the submitted router as attempted and calls it successful only after Fiber returns terminal `Success`. |
| `get_payment` | Status, fee, timestamps, and failure data | In this release, route attempts are serialized only in debug builds. The pinned release image therefore cannot truthfully expose the path chosen by ordinary automatic `send_payment`. |

The reviewed upstream definitions are the
[`graph` RPC](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/crates/fiber-lib/src/rpc/graph.rs),
[`graph` JSON types](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/crates/fiber-json-types/src/graph.rs),
[`payment` RPC](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/crates/fiber-lib/src/rpc/payment.rs), and
[`payment` JSON types](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/crates/fiber-json-types/src/payment.rs).

Fiber Forge does not reconstruct or claim the automatically selected route. Its ordinary payment
preview remains labeled **inferred**. Exact route inspection uses `build_router`, and exact route
execution uses the resulting hops with `send_payment_with_router`.

## Output Semantics

The graph result has `kind: "fiber-routing-graph"` and names its source as
`fiber.graph_nodes+fiber.graph_channels`. Numeric RPC quantities are normalized to decimal strings
so large capacities, fees, timestamps, and expiries do not lose precision in JSON. Managed layout
names are conveniences and retain a `nameSource`; they are not gossip claims.

Directional freshness follows the pinned Fiber policy:

- `fresh`: no more than 14 days old;
- `stale`: older than Fiber's 14-day soft-stale threshold;
- `future`: more than 60 seconds ahead of the observer; and
- `unknown`: no valid directional timestamp was available.

Fiber hard-prunes broadcast messages after 28 days on its daily prune pass. Fiber Forge surfaces
the observed timestamp and age but does not alter, refresh, or replace Fiber gossip.

An inspection result has `kind: "fiber-route-inspection"`. Its `attemptedRoute` is the exact output
of `fiber.build_router`; `finalSuccessfulRoute` is always `null` because inspection sends nothing.
An execution result has `kind: "fiber-routed-payment"`. It keeps the same distinction:

- `attemptedRoute` records the exact router submitted to Fiber;
- `finalSuccessfulRoute` is populated only when the terminal status is `Success`; and
- a failed terminal status never becomes a successful-route claim.

`totalFeeBaseUnits` is derived only from Fiber's returned first-hop and final-hop amounts. Graph
connectivity candidates use `source: "inferred-graph-connectivity"`, are never presented as actual
payment hops, and are never ranked or selected by a separate Fiber Forge routing engine.

## Bounds and Failure Isolation

| Boundary | Limit |
| --- | --- |
| Default graph result | 100 nodes and 100 channels |
| Maximum returned graph page | 250 nodes and 250 channels |
| GUI graph request | 80 nodes and 80 channels |
| GUI drawing | First 40 normalized nodes and 80 normalized channels |
| Warnings | 64 per graph or route result |
| Explicit route | 8 hops |
| Inferred connectivity helper | 8 candidates of at most 8 hops |

Fiber Forge asks for one extra graph record to make truncation visible, then returns only the cap.
The GUI loads graph data only when opened or refreshed; it does not add graph RPCs to the ordinary
one-second status stream. Graph and route endpoints are separate from `/api/state`, so an
unsupported RPC or future response shape produces `ROUTING_UNAVAILABLE` or bounded warnings without
breaking normal network inspection.

Malformed required node/channel records are skipped. Missing direction announcements and invalid
optional values remain explicit as `null`, `unknown`, or warnings. Unknown fields are ignored. A
malformed `build_router` result is never passed to `send_payment_with_router`.

## SDK

```ts
const graph = await forge.inspectRoutingGraph("trio", {
  observer: "alice",
  limit: 80,
});

const inspection = await forge.inspectRoute("trio", "alice", "carol", 41, {
  via: ["bob"],
});

const payment = await forge.payWithRoute(
  "trio",
  "alice",
  "carol",
  41,
  { via: ["bob"] },
  "explicit route proof",
);
if (payment.status !== "Success" || !payment.finalSuccessfulRoute) {
  throw new Error(`route did not settle: ${payment.status}`);
}
```

The live Docker suite queries a trio node's propagated graph, inspects the two-hop route, executes
it through `send_payment_with_router`, compares its Fiber channel outpoints and targets, waits for
`Success`, and confirms channel balances move.
