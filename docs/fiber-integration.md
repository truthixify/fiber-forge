# Fiber integration reference (shared)

The Fiber Network Node (FNN) facts every project in this initiative builds against. This file is
identical across the repos by design; each repo keeps its own copy so it stays self-contained.

## Node & transport
- FNN JSON-RPC default endpoint: `http://127.0.0.1:8227`.
- Pin to **v0.8.1 stable** (`nervos/fiber` Docker image / release binaries) for the build; note the
  pin in the README. Do not chase v0.9 release candidates mid-build.
- The OpenRPC JSON generator shipped in v0.8 — **before using any method or field not listed below,
  verify its exact wire shape against that OpenRPC document. Never guess wire shapes.**

## Verified method set (build against these)
`connect_peer`, `open_channel`, `list_channels`, `shutdown_channel`, `new_invoice`,
`parse_invoice`, `get_invoice`, `cancel_invoice`, `settle_invoice`, `send_payment` (has `dry_run`),
`get_payment`, `node_info`, `graph_nodes`, `graph_channels`.

## Money-safety rules (non-negotiable)
- **Invoice states:** `Open / Received / Paid / Expired / Cancelled`. Only `Paid` is final —
  never treat `Received` as settled.
- **Payment states:** `Created / Inflight / Success / Failed`. Never report an in-flight payment
  as failed; a poll timeout maps to *pending*, and later reconciliation resolves it.
- **Channel readiness:** a channel is usable at state `CHANNEL_READY`; treat anything else as
  not-yet-usable.

## Amounts & assets
- Amounts are `0x`-prefixed hex strings on the wire (u128 base units).
- Testnet RUSD UDT type script:
  - `code_hash` `0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a`
  - `hash_type` `type`
  - `args` `0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b`
  - 8 decimals.
- The mainnet stablecoin is in flux (USDI discontinued). Demo in testnet RUSD; denominate configs
  by UDT script, never by symbol.

## Testing discipline
Any component that talks to a node takes the RPC transport as an injectable interface, so the
whole logic layer runs against recorded fixtures / a mock in unit tests. Live-node paths sit
behind an explicit flag and are exercised in E2E, not unit, tests.
