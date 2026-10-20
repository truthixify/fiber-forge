# Force-close and settlement

Fiber Forge exposes force-close only for disposable local networks. It publishes channel state to
the local CKB dev chain and can consume real capacity. It is not mainnet operator guidance.

## Run it

Copy the full channel ID, then repeat it exactly in `--confirm`:

```sh
fiber-forge channel ls trio feynman --json
fiber-forge channel force-close trio feynman 0xCHANNEL \
  --confirm 0xCHANNEL --json
```

The command waits up to seven minutes by default and generates three local dev-chain blocks between
observations. `--timeout <ms>` and `--mine-blocks <n>` tune those bounds. A settled result exits 0.
A timeout returns the complete report on stdout and exits 2; the Fiber operation continues.

Inspect the same evidence from a new process at any time:

```sh
fiber-forge channel settlement trio feynman 0xCHANNEL --json
```

## State mapping

The pinned Fiber image is `nervos/fiber:0.9.0-rc7`. Its RPC and source define these states:

| Operation or phase | Fiber RPC/state | Fiber Forge result |
| --- | --- | --- |
| Cooperative request | `shutdown_channel` without `force` | Existing `channel close`; never substituted for force-close |
| Force request | `shutdown_channel` with `{ force: true }` | `rpcAccepted: true`, then `close-requested` |
| Commitment confirmation | `Closed` with `UNCOOPERATIVE_LOCAL \| WAITING_ONCHAIN_SETTLEMENT` | `settlement-pending` |
| Final settlement | `Closed` with `UNCOOPERATIVE_LOCAL` and no waiting flag | `settled`, after CKB also reports the closing transaction `committed` |
| Cooperative completion | `Closed` with `COOPERATIVE` | `cooperatively-closed`, never reported as force-close success |

The local CKB chain has an 80-second epoch target and Fiber's default commitment delay is one epoch.
The pinned release checks closed-channel settlement on a five-minute production interval, so final
settlement is intentionally much slower than RPC acceptance or commitment confirmation.
If the counterparty stays offline, its commitment output can remain unspent and Fiber correctly
keeps `WAITING_ONCHAIN_SETTLEMENT`; restore that node and re-run settlement inspection instead of
treating CKB acceptance as completion.

## Evidence ownership

- **Fiber behavior:** `list_channels(include_closed: true)` supplies the channel state, close flags,
  `latest_commitment_transaction_hash`, and `shutdown_transaction_hash`. Fiber clears
  `WAITING_ONCHAIN_SETTLEMENT` after its watchtower observes final settlement.
- **CKB behavior:** `get_transaction` supplies the closing transaction's pool/chain status, block
  hash, and block number. The pinned Fiber channel response does not expose a separate hash for the
  later settlement spend.
- **Fiber Forge behavior:** exact-ID confirmation, bounded polling, dev-chain block generation,
  phase classification, timeout reporting, CLI exit codes, and GUI presentation. A report is only
  successful when both the terminal Fiber state and committed CKB closing transaction are present.

The report retains the channel ID, latest commitment hash, closing transaction hash, confirmation,
state, and flags when it times out. No Fiber Forge process-local record is needed for reinspection.
