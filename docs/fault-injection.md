# Controlled fault injection

Fiber Forge faults are named, persisted test conditions scoped to one managed local network. They
use Docker Engine APIs rather than host firewall commands, so the baseline works on Docker Desktop
and native Docker hosts without modifying unrelated containers or networks.

## Commands

```sh
fiber-forge fault apply trio node-kill <node> --json
fiber-forge fault apply trio peer-partition <node> --json
fiber-forge fault apply trio ckb-unavailable --json
fiber-forge fault apply trio mining-pause --json

fiber-forge fault status trio --json
fiber-forge fault reset trio peer-partition <node> --json
fiber-forge fault reset-all trio --json
fiber-forge fault mine trio 1 --json
```

`faults.json` is written atomically beside the saved layout. A later CLI or SDK process can inspect
and reset the same requested fault. Repeating an already-observed apply or reset is a no-op.

## Fault semantics

| Fault | Requested condition | Observation and reset |
| --- | --- | --- |
| `node-kill <node>` | Send `SIGKILL` to one Fiber container while retaining its container and mounted data. | Active only when that exact container is stopped. Reset starts it, verifies its saved public key, and observes peer/channel recovery. |
| `peer-partition <node>` | Move one running Fiber node onto a dedicated managed bridge shared only with CKB. Other Fiber nodes remain on the primary network. | Active only when the node is absent from the primary bridge and both it and CKB are attached to the isolation bridge. Reset restores the node's original static IP, removes the isolation bridge, and observes recovery. |
| `ckb-unavailable` | Detach the running CKB container from the primary bridge and every active partition bridge. | Active only when every managed attachment is absent. Reset restores the saved static attachment(s) and waits for CKB RPC readiness. |
| `mining-pause` | Block Fiber Forge's on-demand `generate_block` control path. | This dev chain has no background miner; Fiber Forge is the mining actor. Funding, issuance, channel-open, and `fault mine` operations fail with `MINING_PAUSED` before submitting work. Reset proves recovery by mining one block. |

`peer-partition` isolates the selected node from all Fiber peers, not an arbitrary host or port. It
keeps the CKB dependency reachable through the dedicated bridge. Latency, packet loss, and
host-level firewall rules are deliberately outside this portable contract.

## Reports and recovery

Every `FaultReport` includes the requested state, observed state, application time, affected target,
whether the request changed anything, and a reset or recovery action. `degraded` means persisted
intent and Docker state disagree; inspect the report before retrying or resetting.

Reset restores the injected process or connectivity condition. It reports `ready` only after the
relevant RPC/dependency check. A node or partition reset can return `action-required` when the
process and network are restored but Fiber peers/channels did not recover inside the bounded
observation period. The CLI prints the report and exits with status 2 in that case.

`fiber-forge down` removes managed fault bridges and `faults.json` even when a fault is still active.
Fault bridges carry network ownership labels; a same-named external bridge is rejected and left
unchanged. Cleanup detaches only containers in the selected network's `fiber-forge=<net>` label set,
so an unrelated endpoint causes a visible cleanup failure instead of being force-disconnected.
