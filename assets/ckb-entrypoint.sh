#!/usr/bin/env bash
# Initialize (once) and run a CKB dev chain with the Fiber contracts baked into genesis.
# Mounted: /assets (dev.toml + contracts/, read-only) and /data (persistent chain data).
set -euo pipefail

DATA=/data
ASSETS=/assets
BA_ARG=0xc8328aabcd9b9e8e64fbc566c4385c3bdeb219d7

if [ ! -f "$DATA/ckb.toml" ]; then
  ckb init -C "$DATA" -c dev --force --ba-arg "$BA_ARG"
  cp "$ASSETS/dev.toml" "$DATA/specs/dev.toml"
  cp -r "$ASSETS/contracts" "$DATA/contracts"
  # dev.toml references ../../deploy/contracts relative to itself; from $DATA/specs that is ../contracts.
  sed -i 's|\.\./\.\./deploy/contracts|../contracts|g' "$DATA/specs/dev.toml"
  # generate_block (used to mint blocks on demand) requires the IntegrationTest RPC module.
  grep -q 'IntegrationTest' "$DATA/ckb.toml" || sed -i 's/\("Debug"\)/\1, "IntegrationTest"/' "$DATA/ckb.toml"
  # peers reach RPC from other containers, so bind all interfaces.
  sed -i 's|127\.0\.0\.1:8114|0.0.0.0:8114|' "$DATA/ckb.toml"
fi

exec ckb run -C "$DATA" --indexer
