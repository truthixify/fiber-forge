# Dev notes — spike findings

Discoveries from build-order step 1 (the "single node up" spike). These are the hard facts the
orchestrator is built against; kept here so the reasoning is not lost.

## Images (verified against Docker Hub, 2026-07-08)

- **fnn image:** `nervos/fiber` publishes to Docker Hub + `ghcr.io/nervosnetwork/fiber` only from
  recent tags. **No `v0.8.1` image exists** (Docker publishing postdates it). Published tags are
  `0.9.0-rc1 … 0.9.0-rc7`, multi-arch with `-arm64` / `-amd64` variants. **Default image:
  `nervos/fiber:0.9.0-rc7`** (configurable). This is a deliberate, necessary deviation from the
  spec's `docs/fiber-integration.md` "pin v0.8.1" — there is no v0.8.1 image to pin. The image tag
  is a config value; the roadmap already anticipates a version flag.
- **CKB image:** `nervos/ckb` is on Docker Hub (`v0.201.0`, `latest`).
- Host here is arm64; the multi-arch `0.9.0-rc7` tag resolves to arm64 automatically.

## fnn image contract (from `docker/README.md` + `docker/docker-entrypoint.sh`)

- Volume `/fiber`; the entrypoint copies a bundled **testnet/mainnet** config to
  `/fiber/config.yml` on first start (override template via `FIBER_CONFIG_TEMPLATE`). There is **no
  bundled devnet config** — a local dev chain needs a custom `config.yml` mounted at `/fiber`.
- **RPC binds `127.0.0.1:8227` in the bundled configs** — publishing the port is not enough; the
  mounted config must set `rpc.listening_addr = 0.0.0.0:8227` for the orchestrator to reach it.
- Env: `FIBER_SECRET_KEY_PASSWORD` (required), `RUST_LOG`. CKB private key expected under the
  mounted volume. `fnn-cli` ships in the image (`docker exec … fnn-cli info`).

## Devnet requirements (why it is not just "run the image")

- The image's bundled configs are testnet/mainnet; a **local CKB dev chain** needs a custom fnn
  `config.yml` pointing `ckb.rpc_url` at the dev-chain container, dev network params, and the
  **dev-deployed Fiber contract script references** (funding-lock, commitment-lock).
- The fiber repo deploys those contracts to a dev chain under `tests/deploy` (contracts,
  migrations, udt-init). The exact recipe (dev-chain config, genesis keys, contract deployment,
  fnn devnet config) is being extracted from the repo and will be captured here before the live
  orchestration is wired.

## Testing posture

The orchestrator, funding, RPC client, and topology are built against injectable interfaces and
unit-tested with fakes (no live node), keeping `make ci` green. The real Docker path and the
CKB-dev-chain-to-`CHANNEL_READY` flow are the E2E, run on a Docker host (available here).
