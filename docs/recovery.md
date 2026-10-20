# Node Recovery

This contract is verified against `nervos/fiber:0.9.0-rc7` and applies to an existing Fiber Forge
container that is stopped without being removed.

## Observed Relay Restart

The live recovery test uses a three-node line and stops the routing node after both channels are
ready. While the relay is stopped:

- inspection reports its container as `exited`; and
- an endpoint payment is rejected because the sender has no usable outbound route.

Starting the same container preserves its mounted database and key. The node returns with the same
public key, and both existing channel IDs return to `ChannelReady`. Repeated live runs observed two
peer outcomes: all peers sometimes reconnect automatically, while another run left the original
channel opener disconnected after 60 seconds even though the gossip graph still listed both
channels. A graph count or relay-local channel state is therefore not enough to claim recovery.

The supported path first waits for every node to report its expected ready channels, live peers,
and graph edges. If that bounded gate does not converge, it reconnects the original opener with
`connect_peer`, using the relay's saved address and peer ID, and checks the full gate again. A new
endpoint payment must then succeed over the original channel IDs.

**Classification:** automatic when the full RPC gate converges; otherwise manual peer reconnection.
No cooperative close, force-close, or channel reopen is required for this graceful stop/start case.

## Boundaries

- This is an internal engine path today; Fiber Forge does not yet expose a node restart CLI or SDK
  command.
- A removed container cannot be started in place. The engine reports the missing container instead
  of claiming recovery.
- `fiber-forge down` removes the containers. `--keep` additionally retains the CKB data volume, but
  a later `up` still provisions fresh Fiber node state; it is not the node-recovery path.
- Abrupt kill, host reboot, corrupted state, and force-close settlement require their own evidence
  before they can share this classification.
