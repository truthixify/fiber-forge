# xUDT And RCE Compatibility

**Decision date:** 2026-10-20

**Pinned Fiber release:** `v0.9.0-rc7` (`bc361aaaa40d1394b83e6a1808869b0b06c48c13`)

**Scope:** disposable CKB devnet and local Fiber networks only

## Decision

Fiber Forge should use the bundled extension-free xUDT as the next separately scoped multi-asset
capability. It must not claim RCE policy support yet.

The pinned Fiber release accepts more than one UDT whitelist entry and successfully opens and pays
through a channel using the bundled xUDT binary when its type args contain only the owner lock hash.
That is a plain xUDT: the binary can execute extensions, but this asset instance configures none.

An RCE-enabled xUDT needs rule cells, cell dependencies, and a correctly encoded proof witness for
every on-chain transaction that executes the type script. Fiber's whitelist carries dependencies,
but the public channel lifecycle does not expose a general witness/proof provider for funding,
cooperative close, force close, and settlement transactions. Off-chain payments also do not execute
the CKB type script. Shipping an RCE toggle on this evidence would therefore overstate both policy
enforcement and settlement safety.

## Exact Compatibility Record

| Component | Accepted local contract |
| --- | --- |
| CKB | `nervos/ckb:v0.201.0`; Dummy-PoW devnet with both UDT binaries in genesis |
| Fiber | `nervos/fiber:0.9.0-rc7`; source commit `bc361aaaa40d1394b83e6a1808869b0b06c48c13` |
| `simple_udt` | 1,696-byte RISC-V ELF; SHA-256 `b1a962cb43d88e777d9df0aa4e67270ee758d9abdd18b1c56b106a5eed149af9`; CKB data hash `0xe1e354d6d643ad42724d40967e334984534e0367405c5ae42a9d7d63d77df419`; genesis cellbase index `0x8`; `data1` |
| `xudt_rce` | 33,696-byte RISC-V ELF; SHA-256 `e9b92e5783f692f6ee99ca20eeda5f3da282e0f4010eb4fbd3db4e3058239349`; CKB data hash `0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95`; genesis cellbase index `0x9`; `data2` |

Both packaged binaries are byte-for-byte identical to the files under the pinned Fiber tag. Genesis
transaction hashes are derived from the active chain rather than treated as portable constants.

Fiber's `ckb.udt_whitelist` is a list. Each entry contains a local name, a code hash/hash type/args
regular expression, an optional auto-accept amount, and one or more dependencies expressed as a
concrete cell dep or type-ID script. `node_info.udt_cfg_infos` exposes the resolved list. The
`open_channel`, `new_invoice`, and payment contracts identify an asset by its complete CKB type
script, not by the whitelist name.

The local xUDT proof used these type args:

```text
0x32e555f3ff8e135cece1351a6a2971518392c1e30375c1e006ad0ce8eac07947
```

They are only the dev issuer's 32-byte owner lock hash. No flags, extension `ScriptVec`, RCE rule
reference, or RCE witness data were present.

## Local Deployment And Whitelist Requirements

The accepted plain-xUDT setup has four distinct requirements:

1. The exact RISC-V binary must exist in an on-chain code cell. Fiber Forge currently bakes it into
   the dev genesis cellbase; a future deploy transaction is also valid if its committed out point is
   recorded instead.
2. The asset type script uses the binary's CKB data hash, `data2`, and the dev issuer's lock-script
   hash as its 32-byte args. Issuance uses xUDT owner mode, stores the unsigned 128-bit amount in the
   first 16 little-endian data bytes, and includes the code cell as a dependency.
3. Every Fiber peer that may open, accept, route, or settle the asset must start with a matching
   whitelist entry. The entry must include the same script matcher and code cell dep. Config is not
   hot reloaded; changing the list requires a controlled node restart and identity check.
4. Issuance is not ready merely because CKB accepted the transaction. The recipient cell must be
   committed and visible to the node's CKB indexer before channel negotiation starts. Readiness must
   poll the exact asset balance or another indexed-cell signal under a deadline.

`auto_accept_amount` is expressed in asset base units and controls inbound channel acceptance; it is
not issuance, a decimal definition, or a balance. A production implementation must resolve and
persist every code/rule dependency rather than searching for it again after restart.

## Manual Local Proof

The durable result is recorded in
[`docs/evidence/xudt-macos-arm64-2026-10-20.json`](evidence/xudt-macos-arm64-2026-10-20.json).
The proof ran from commit `f1eb3eb7f7a515c050b315805112aa8a0a410c4e` on Docker Desktop for
macOS arm64:

1. A fresh two-node Fiber Forge network started with the existing CKB channel and simple UDT
   whitelist unchanged.
2. Both stopped nodes received a second whitelist entry for the genesis xUDT code cell, then
   restarted with their original identities and advertised both assets through `node_info`.
3. The dev issuer minted `1,000,000,000` plain-xUDT base units to the funding node using owner mode.
4. A public `500,000,000`-base-unit xUDT channel progressed through
   `AwaitingTxSignatures`, `AwaitingChannelReady`, and `ChannelReady` on both peers.
5. A `100,000,000`-base-unit invoice payment reached Fiber `Success`. Channel-local balances moved
   by exactly `-100,000,000` and `+100,000,000`.
6. Purge removed both Fiber containers, the CKB container, Docker network, CKB volume, and saved
   network directory.

This proves the plain xUDT channel/payment capability against the pinned local stack. It does not
prove RCE enforcement, arbitrary external xUDTs, testnet/mainnet deployment compatibility, or safe
settlement after a policy change.

## RCE Boundary

RFC 0052 extends the 32-byte owner lock hash with flags and extension data. An extension-enabled
xUDT can reference an RCE rule cell whose sparse-Merkle root classifies lock-script hashes. The RCE
validator consumes extension-specific proofs from `XudtWitness` and can enforce blacklists,
whitelists, emergency halt, append-only updates, and type freezing.

That model creates three Fiber-specific constraints:

- **Every on-chain path needs proof material.** Adding the xUDT and rule cell deps is insufficient;
  the transaction witness must match the current rule root and all participating lock hashes.
- **Rules can change while value is off chain.** A channel may open under one root, carry many
  off-chain payments without running the type script, then become impossible to settle under a new
  root or emergency halt.
- **Funding-only extension points are not lifecycle support.** Fiber's shell funding-transaction
  builder and external-funding RPC affect the opening transaction. Neither documents an equivalent
  proof-witness boundary for cooperative close, unilateral close, watchtower, or final settlement.

RCE support remains deferred until the pinned Fiber contract exposes and documents a proof-provider
boundary for every relevant transaction, or an upstream end-to-end fixture proves equivalent safe
behavior. A later implementation must pin that newer Fiber version independently.

## Required RCE Test Matrix

These are acceptance tests for future RCE work, not claims about current behavior:

| Case | Required result |
| --- | --- |
| Whitelisted funding and settlement locks | Open, cooperative close, force close, watchtower, and final settlement all validate with exact current proofs. |
| Non-whitelisted output lock | Funding or settlement is rejected with `ERROR_NOT_ON_WHITE_LIST`; no channel is reported ready. |
| Blacklisted input or output lock | The transaction is rejected with an RCE blacklist error and retains actionable diagnostics. |
| Missing, malformed, or stale proof | The transaction is rejected; Fiber does not enter an unbounded negotiating or settlement state. |
| Emergency-halt rule | New funding and settlement behavior is documented explicitly, including the recovery path for already-open channels. |
| Rule root changes while a channel is open | Payments, cooperative close, unilateral close, and watchtower settlement are tested before and after the change. No path may strand value silently. |
| Invalid rule update | SMT root, append-only, and type-freeze violations are rejected without mutating the accepted rule state. |
| Owner-mode issuance | Authorized mint/burn succeeds; an identical transaction without the owner condition fails. |
| Off-chain payment after policy change | The product states whether policy is checked off chain; it must not imply CKB enforcement when no script executed. |
| Cleanup and replay | Rule cells, proofs, asset cells, channels, node state, and credentials are recreated or purged deterministically. |

## Named Multi-Asset Design

The public identity of an asset is its resolved full type script. A local `id` is only a stable
human/config reference. Display name, symbol, and decimals are local metadata and must never be used
to decide protocol identity.

A future topology extension should be additive and explicit:

```yaml
assets:
  - id: forge-usd
    display:
      name: Forge USD
      symbol: FUSD
      decimals: 8
    contract:
      kind: bundled_xudt
      extensions: none
    issuance:
      per_node_base_units: "1000000000"

channels:
  - from: alice
    to: bob
    asset: forge-usd
    capacity_base_units: "500000000"
```

Rules for that contract:

- `assets` is optional; existing topology files remain valid unchanged.
- A channel supplies exactly one of `capacity_ckb` or `asset` plus `capacity_base_units`.
- IDs are unique DNS-safe references. Two IDs resolving to the same type script are rejected.
- Base-unit amounts are positive decimal strings parsed as `bigint`; JavaScript `number` is not an
  asset accounting boundary.
- `decimals` is bounded display metadata. Issuance and reconciliation always use base units.
- The first managed contract kind is `bundled_xudt` with `extensions: none`. Custom binaries,
  external networks, and RCE extensions remain unsupported.
- Persisted layouts record the resolved script and cell deps so status cannot silently reinterpret
  an asset after restart.
- Status and reports expose `assetId`, display metadata, full type script, base-unit capacity, and
  balances. The current `udt` boolean remains only as a compatibility field.

CLI commands should use `--asset <id>` for invoice, pay, and channel-open operations. The current
`--udt` flag and `udt issue` command should remain compatibility aliases for the built-in
`simple-udt` asset through the next major release; using both `--asset` and `--udt` is an error. SDK
changes require additive typed options before any boolean parameter is deprecated. The GUI should
render a select/menu of configured assets with symbol and exact available balance, rather than a
CKB/UDT binary switch.

## Security And UX Comparison

| Property | Current simple UDT | Plain xUDT recommendation | RCE-enabled xUDT |
| --- | --- | --- | --- |
| On-chain amount invariant | Simple 128-bit sum | Same, through backward-compatible xUDT | Same plus extension validation |
| Policy witness | None | None | Required and root-dependent |
| Rule changes | None | None | Can affect future on-chain settlement |
| Fiber rc7 proof | Existing automated live test | Manual local channel/payment proof | Not proven |
| User model | One anonymous `UDT` toggle | Named asset with symbol/decimals and full-script identity | Named asset plus policy state, proof freshness, and recovery semantics |
| Main risk | Asset ambiguity and fixed decimals | Metadata spoofing or selecting the wrong script | Stranded settlement, stale proofs, and false off-chain compliance claims |

## Separately Scoped Implementation Work

1. Add and validate the versioned asset registry/topology schema, resolved layout state, and
   generated multi-entry Fiber whitelist while preserving all current simple-UDT inputs.
2. Generalize dev-chain issuance and balance discovery around a resolved asset contract, with exact
   `bigint` base-unit APIs and additive CLI/SDK `--asset` options.
3. Ship one named bundled plain-xUDT preset with unit/package tests and a packed live proof covering
   issuance, channel open, payment, restart/status, and purge. Keep simple UDT in the same run.
4. Replace the GUI's boolean UDT controls with an accessible configured-asset selector and per-asset
   balances after the headless contract is stable.
5. Revisit RCE only against an upstream Fiber release that supplies complete witness/proof lifecycle
   support, then execute the full matrix above as a separate security-sensitive change.

## Primary Sources

- [Fiber rc7 UDT initializer](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/tests/deploy/udt-init/src/main.rs)
- [Fiber rc7 UDT configuration types](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/crates/fiber-types/src/config.rs)
- [Fiber rc7 whitelist matching](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/crates/fiber-lib/src/ckb/config.rs)
- [Fiber rc7 funding builder configuration](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/crates/fiber-lib/src/ckb/config.rs#L70-L86)
- [Fiber rc7 external-funding contract](https://github.com/nervosnetwork/fiber/blob/bc361aaaa40d1394b83e6a1808869b0b06c48c13/docs/external-funding.md)
- [Fiber rc7 xUDT routing fixture](https://github.com/nervosnetwork/fiber/tree/bc361aaaa40d1394b83e6a1808869b0b06c48c13/tests/bruno/e2e/udt-router-pay)
- [RFC 0052: Extensible UDT](https://github.com/nervosnetwork/rfcs/blob/53b2c5eb7dd82968327999534be74d7975865b9d/rfcs/0052-extensible-udt/0052-extensible-udt.md)
- [Production xUDT/RCE validator source](https://github.com/nervosnetwork/ckb-production-scripts/blob/abdcb117b512e35910fa8e30241a7a354e5cacf0/c/rce.h)
