# Fiber Forge follow-up release

This release publishes the channel-liquidity GUI improvements already reviewed on the default
branch and hardens the package and release path around them.

## Changes

- Adds directional-liquidity payment preflight, visible shortfalls, and a prefilled channel-recovery
  flow in the GUI.
- Adds stable CKB/UDT channel styling and filters, pair-based channel creation, and navigable peer
  and channel rows.
- Preserves stage-level evidence when the packed CCH runner fails or times out.
- Restores strict Node.js 20 installation support and verifies Node 20 and 24 consumers.
- Updates the CKB transaction dependency after compatibility review and records the remaining low
  transitive advisory without applying npm's breaking downgrade.
- Adds pull-request, scheduled CCH, and exact-commit release gates.

## Compatibility

- Node.js 20 or newer and a running Docker daemon are required.
- Linux amd64 with Docker Engine and macOS arm64 with Docker Desktop are supported by complete live
  evidence; WSL2 remains unverified.
- CKB remains pinned to `nervos/ckb:v0.201.0` and Fiber to `nervos/fiber:0.9.0-rc7` for this release.

## Known Limitations

- Fiber Forge remains a disposable local-development tool; testnet, mainnet, custody, and reserve
  claims are outside its scope.
- The CCH proof uses CKB devnet, Bitcoin regtest, operator-provided liquidity, and a trusted fixture
  rate.
- Stable Fiber compatibility is separate future work and is not claimed by this release.
- WSL2 and cross-host bundle replay still need recorded live evidence.
