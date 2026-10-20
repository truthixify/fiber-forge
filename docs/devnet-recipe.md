# Devnet-boot recipe

The verified, authoritative procedure the orchestrator implements to go from nothing to N fnn
nodes with funded `CHANNEL_READY` channels on a local CKB dev chain. Extracted and cross-checked
against `nervosnetwork/fiber` (`tests/nodes/deployer/*`, `tests/deploy/*`) and the pulled images.

## The load-bearing fact

**The Fiber contracts are baked into the CKB dev-chain genesis, not deployed by a transaction.**
The chain spec `assets/dev.toml` lists them under `[[genesis.system_cells]]` — `auth`,
`funding-lock`, `commitment-lock`, `simple_udt`, `xudt_rce` — loaded from `assets/contracts/*`. An
fnn node points `fiber.chain` at the same `dev.toml` and discovers the contract cell-deps by
scanning genesis. There is therefore **no `scripts:` section in fnn config and no deploy step**;
the whole "deploy" is shipping the right `dev.toml` + contract binaries and booting CKB against it.

## Vendored assets (in `assets/`, invariant, shipped with fiber-forge)

- `dev.toml` — the `ckb_dev` chain spec with the Fiber contracts in genesis.
- `config.template.yml` — the fnn config template (per-node values are filled at boot).
- `contracts/{auth,funding-lock,commitment-lock,simple_udt,xudt_rce,always_success}` — the
  compiled contract binaries `dev.toml` references (byte-size verified).

## Public dev keys (test keys — safe to hardcode)

- **Deployer / treasury:** privkey `0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc`,
  lock arg `0xc8328aabcd9b9e8e64fbc566c4385c3bdeb219d7`. Genesis-issued treasury **and** the CKB
  block-assembler (`--ba-arg`), so mined cellbase rewards accrue to it — it self-funds. Every
  node's on-chain balance is transferred from this key.

## 1. CKB dev-chain container

- Image `nervos/ckb:v0.201.0`. One per fiber-forge network; name `forge-<net>-ckb`; RPC 8114.
- Init (idempotent, guard on an existing data dir):
  - `ckb init -C <data> -c dev --force --ba-arg 0xc8328aabcd9b9e8e64fbc566c4385c3bdeb219d7`
  - copy `assets/dev.toml` → `<data>/specs/dev.toml`; rewrite the `../../deploy/contracts` paths to
    where `assets/contracts` is mounted in the container.
  - enable the `IntegrationTest` RPC module in `ckb.toml` (required for `generate_block`).
  - bind RPC `0.0.0.0:8114` so peer containers reach it.
- Run `ckb run -C <data> --indexer`.
- **Mining:** dev chain uses Dummy PoW; mint on demand with `generate_block` (JSON-RPC, params
  `[]`) in a ~1s loop. `cellbase_maturity = 0`, so funds are spendable almost immediately.
- Readiness: poll `get_tip_block_number` until it returns and increments.

## 2. Funding a node's wallet

Transfer from the deployer key to each node's CKB wallet address, then mint blocks to confirm.
Upstream uses `ckb-cli wallet transfer --to-address <node> --capacity <n> --privkey-path
<deployer>`; fiber-forge builds the equivalent transfer with `@ckb-ccc/core` (TS-native, no
ckb-cli dependency) and calls `generate_block` a few times to confirm. Fund `per_node_ckb` per
node (topology).

## 3. Per-fnn-node container

- Image `nervos/fiber:0.9.0-rc7` (configurable). Name `forge-<net>-node-<i>`; volume `/fiber`.
- Generated `config.yml` (from `config.template.yml`) with the devnet-specific values:
  - `fiber.chain: dev.toml` (mount `assets/dev.toml` into `/fiber`).
  - `fiber.auto_announce_node: true`, `fiber.announce_private_addr: true` (nodes announce their
    private/container addresses so peers can dial them).
  - `ckb.rpc_url: http://forge-<net>-ckb:8114` (point at the dev-chain container).
  - `rpc.listening_addr: 0.0.0.0:8227` (rebind off 127.0.0.1 so the orchestrator can reach RPC).
  - `fiber.listening_addr` for p2p (default 8228), announced with the container name.
  - `cch.ignore_startup_failure: true` (no lnd in the devnet — CCH must not abort boot).
  - `enabled_modules` includes `dev` (needed for dev-only helpers) and the standard set.
- Provision: the node's CKB private key + fiber secret key under `/fiber`, and
  `FIBER_SECRET_KEY_PASSWORD` env. Publish RPC (8227) to a host port `8228 + i`.

## 4. Wiring to CHANNEL_READY

1. `node_info` on each node until it answers (readiness) — harvest pubkey + announced address.
2. `connect_peer` from each channel's `from` node to its `to` node's announced address (inside the
   docker network, nodes dial by container name / announced private addr).
3. Fund each `from` node's wallet from the deployer key (step 2), confirm with `generate_block`.
4. `open_channel` from `from` to `to` with the topology capacity; mint blocks so the funding tx
   confirms.
5. Poll `list_channels` until the channel reaches `CHANNEL_READY`; anything else past a timeout is
   a named failure carrying the node's last log lines (FR-1).

## Naming & ports (one fiber-forge network)

- Docker network `forge-<net>`; CKB `forge-<net>-ckb` (host 8114); node `i` container
  `forge-<net>-node-<i>`, RPC host port `8228 + i`, p2p internal 8228.
- State under `~/.fiber-forge/<net>/` includes the layout and per-node bind mounts. Starting the
  same stopped container reuses that Fiber state; `down --keep` retains the CKB volume but a later
  `up` provisions fresh Fiber nodes.

## MVP note

CKB-only channels need only `auth` + `funding-lock` + `commitment-lock` in genesis (all present in
`dev.toml`); `udt_whitelist` and the UDT contracts matter only for the stretch UDT preset. The
minimal path to a green E2E is a CKB channel — no UDT, no lnd, no CCH.
