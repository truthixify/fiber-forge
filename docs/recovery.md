# Node Recovery

This contract is verified against `nervos/fiber:0.9.0-rc7` and applies to an existing Fiber Forge
container that is stopped without being removed.

## Observed Relay Restart

The live recovery test uses a three-node line and stops the routing node after both channels are
ready. While the relay is stopped:

- node inspection reports `stopped` (the underlying Docker state is `exited`); and
- an endpoint payment is rejected because the sender has no usable outbound route.

Starting the same container preserves its mounted database and key. The node returns with the same
public key, and both existing channel IDs return to `ChannelReady`. Repeated live runs observed two
peer outcomes: all peers sometimes reconnect automatically, while another run left the original
channel opener disconnected after 60 seconds even though the gossip graph still listed both
channels. A graph count or relay-local channel state is therefore not enough to claim recovery.

The supported lifecycle commands are:

```sh
fiber-forge node inspect trio <relay> --json
fiber-forge node stop trio <relay> --json
fiber-forge node start trio <relay> --json
fiber-forge node restart trio <relay> --json
```

Stop retains the exact container and mounted data. Start/restart waits for RPC readiness, verifies
that the public key still matches saved state, and observes declared peers and channel states for a
bounded period. Its `NodeLifecycleReport` returns `recovery: "ready"` only when every declared peer
is connected with a `ChannelReady` channel. Otherwise the process operation still succeeds but the
report says `action-required` and provides a next inspection command.

The live recovery test then checks every node's expected ready channels, live peers, and graph
edges. If that full-network gate does not converge, it reconnects the original opener with
`connect_peer`, using the relay's saved address and peer ID, and checks the gate again. A new endpoint
payment must then succeed over the original channel IDs. This fallback remains explicit because
Fiber Forge does not claim that restarting a process always restores routing by itself.

**Classification:** automatic when the full RPC gate converges; otherwise manual peer reconnection.
No cooperative close, force-close, or channel reopen is required for this graceful stop/start case.

## Boundaries

- The CLI, SDK, local daemon, and GUI share the same lifecycle report. Repeating stop/start is an
  explicit no-op, and operations on the same node are serialized.
- A removed container cannot be started in place. The engine reports the missing container instead
  of claiming recovery.
- `fiber-forge down` removes the containers. `--keep` additionally retains the CKB data volume, but
  a later `up` still provisions fresh Fiber node state; it is not the node-recovery path.
- Abrupt kill, host reboot, corrupted state, and force-close settlement require their own evidence
  before they can share this classification.
