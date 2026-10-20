# Lifecycle Errors

Lifecycle failures have stable codes for CLI automation. When a command uses `--json`, Fiber Forge
writes one JSON error object to stderr and exits non-zero:

```json
{
  "ok": false,
  "error": {
    "code": "PORT_IN_USE",
    "message": "CKB RPC port 8114 is already in use",
    "resource": "127.0.0.1:8114",
    "action": "free port 8114 or choose a different port"
  }
}
```

`message` is for people. Automation should branch on `code`; `resource` and `action` are present
when Fiber Forge can identify a specific target and safe next step.

## Codes

| Code | Meaning |
| --- | --- |
| `DOCKER_UNAVAILABLE` | The Docker socket is missing, refused the connection, or is inaccessible. |
| `FAULT_UNSUPPORTED` | The active engine lacks a required portable primitive, or the requested fault kind is unknown. |
| `FAULT_PRECONDITION_FAILED` | A fault target, process state, or argument does not satisfy the documented precondition. |
| `FAULT_CONFLICT` | Another active fault prevents the requested condition from being applied truthfully. |
| `FAULT_STATE_MISMATCH` | Persisted fault intent is unreadable or does not match the observed Docker condition. |
| `IMAGE_PULL_FAILED` | A required pinned image could not be pulled. |
| `CONTAINER_START_FAILED` | Docker could not create or start the named container. |
| `CONTAINER_NOT_FOUND` | An operation required an existing container that has been removed. |
| `INVALID_NETWORK_NAME` | A network name is not safe for Docker resources or local state paths. |
| `PORT_IN_USE` | A requested port is occupied or overlaps another requested binding. |
| `INVALID_PORT` | A requested port or port range is outside the TCP port range. |
| `INVALID_TIMEOUT` | The requested provisioning timeout is not a positive finite number. |
| `NETWORK_EXISTS` | A same-name Fiber Forge network still has running containers. |
| `NETWORK_NOT_FOUND` | No readable saved layout exists for the requested network. |
| `MINING_PAUSED` | A mining-dependent operation was rejected before submission while the mining fault is active. |
| `NODE_NOT_FOUND` | The saved network has no node with the requested name. |
| `NODE_CONTAINER_MISSING` | The saved node exists, but its retained Docker container was removed. |
| `NODE_RPC_UNAVAILABLE` | A started node did not expose a usable RPC and peer address before its deadline. |
| `NODE_IDENTITY_MISMATCH` | A started container's public key differs from the saved node identity. |
| `NODE_STATE_MISMATCH` | Docker did not reach or retain the requested running/stopped state. |
| `OPERATION_ABORTED` | The caller's abort signal stopped provisioning; automatic rollback completed first. |
| `OPERATION_TIMEOUT` | The overall provisioning deadline elapsed; automatic rollback completed first. |
| `PAYMENT_FAILED` | Fiber could not create or route the requested payment; inspect connectivity and channel balances. |
| `PROVISION_FAILED` | Provisioning failed at a named node, peer, channel, or routing phase. |
| `ROLLBACK_FAILED` | Provisioning failed and automatic cleanup also encountered an error. |
| `DOCKER_OPERATION_FAILED` | Another named Docker inspection or cleanup operation failed. |
| `UNEXPECTED` | A failure outside the classified lifecycle paths. |

These codes describe the CLI and public SDK lifecycle contract. The SDK exports `ForgeError`,
`ForgeErrorCode`, `ForgeErrorDetails`, and `errorDetails` from
`@truthixify/fiber-forge/sdk`.

## Cleanup Rules

- Requested ports are validated before Docker resources are created.
- A same-name running network is never replaced implicitly; tear it down explicitly first.
- Exited, Fiber Forge-labeled containers and their stale network, CKB volume, and bind-mounted node
  state are removed before a fresh provisioning attempt.
- A failure after provisioning begins triggers `down --purge` semantics for that network only.
- Teardown continues across individual resource failures and reports every resource it could not
  remove. If a container remains, its bind-mounted state is retained for the next teardown attempt.
  Repeating teardown is safe when containers, networks, volumes, or state are already gone.
