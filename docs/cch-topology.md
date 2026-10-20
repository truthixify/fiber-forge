# CCH Topology

Fiber Forge can provision the accepted local Cross-Chain Hub stack with one command:

```sh
fiber-forge up cch
fiber-forge status cch --json
fiber-forge cch status cch --json
fiber-forge down cch --purge
```

The `cch` preset is opt-in. Ordinary Fiber presets do not pull or start Bitcoin, LND, or the CCH
operator.

## What It Starts

The topology contains:

- one CKB dev chain;
- a Fiber `user` and `hub` node;
- a 200,000-base-unit public `simple_udt` channel from user to hub;
- Bitcoin Core regtest and separate hub/user LND nodes;
- a 1,000,000-satoshi Lightning channel funded by the hub; and
- a standalone CCH operator connected to the Fiber hub and hub LND.

The wrapped UDT uses a fixed 1:1 test rate between base units and regtest satoshis. That rate and the
initial issuance are trusted development fixtures, not a Bitcoin reserve proof or production bridge.

Only CKB, Fiber RPC, and CCH RPC are published to `127.0.0.1`. Bitcoin RPC, ZMQ, LND peer, and LND
gRPC ports stay private to the managed Docker network. The operator mounts a dedicated read-only
volume containing only `cch.macaroon` and `tls.cert`; wallet seeds, admin macaroons, and private keys
are not written to the layout or status response.

## Readiness

`fiber-forge status cch --json` preserves the ordinary node/channel view and adds `profile: "cch"`
plus a versioned `cch` object. `fiber-forge cch status <net>` returns only that boundary view.

| State | Meaning |
| --- | --- |
| `ready` | Wrapped Fiber channel, operator RPC, Bitcoin, both LND nodes, and Lightning liquidity are ready. |
| `degraded` | The operator is running but a Fiber or Lightning dependency is not ready. |
| `settling` | A cross-network order is accepted but has not reached its terminal state. |
| `failed` | The expected CCH operator is absent or exited. |
| `unsupported` | The selected network is a Fiber-only topology. |

The standalone operator readiness probe deliberately accepts the pinned release's `Key not found`
response for an unknown order hash as transport readiness. Overall `ready` still requires the real
wrapped channel and Lightning backend state.

## Topology File

The same service profile can be attached to a custom two-or-more-node topology:

```yaml
name: bridge-lab
nodes:
  - { name: alice }
  - { name: gateway }
channels: []
funding:
  per_node_ckb: 100000
cch:
  user_node: alice
  hub_node: gateway
  wrapped_channel_base_units: 200000
  issued_base_units: 100000000
```

The CCH roles must reference different declared nodes, issuance must cover channel capacity, and all
base-unit values must be positive safe integers. The hub alone receives the `pubsub` RPC module.
Fiber-only topology files remain valid without a `cch` mapping.

## Failure And Cleanup

Every provisioning phase has a bounded deadline and names the failed resource. A failure or abort
rolls back all resources labeled for that network, including partially created CKB, Fiber, Bitcoin,
LND, CCH containers, the Docker network, backend volumes, credentials, and state directory.

Export bundles reject CCH networks. Their portable contract intentionally excludes backend
credentials and external-chain state, so replaying only the Fiber recipe would make a false
reproduction claim. Use the sanitized live evidence path for cross-network proofs instead.

See [Cross-Chain Hub feasibility](cch-feasibility.md) for the pinned versions, trust model, and manual
two-direction proof, and [Lightning backend](lightning-backend.md) for the isolated backend contract.
