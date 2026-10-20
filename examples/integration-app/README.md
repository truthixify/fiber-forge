# Fiber Forge Integration Example

This is a small external-style Node application, not another Fiber Forge UI. Its payment code knows
only the versioned connection document and loopback Fiber JSON-RPC endpoints. The local harness owns
network setup and teardown through the public `@truthixify/fiber-forge/sdk` export.

## Run from this checkout

Requirements are Node.js 20 or newer and a running Docker daemon. From the repository root:

```console
npm ci
npm run example:local
```

The runner builds a `0.4.0-rc.1` tarball, copies this application to a temporary directory, installs
the tarball with production dependencies only, starts an isolated trio, asserts a real one-CKB
multi-hop payment, tears the network down, and removes its temporary state.

The failure example completes the same payment, then exits non-zero after verifying cleanup:

```console
npm run example:failure
```

After `0.4.0-rc.1` is published, the directory can also be copied elsewhere and run independently:

```console
npm install
npm test
```

## Run through the Action

The application entry point accepts the Action's structured output unchanged:

This example becomes externally runnable when `0.4.0-rc.1` is published. Until then, the exact
commit and packed candidate are exercised only by the repository's public
[Action evidence workflow](https://github.com/truthixify/fiber-forge/actions/runs/39373696256).

```yaml
- id: forge
  uses: truthixify/fiber-forge@a34cc3cac1f034404a16d9597d41b002789331d6
  with:
    package-version: 0.4.0-rc.1
    topology: trio
- run: node examples/integration-app/src/connection.mjs
  env:
    FIBER_FORGE_CONNECTION: ${{ steps.forge.outputs.connection-json }}
```

Failures are one-line JSON with a stable code, the failed node or method, and a recovery action. The
application rejects non-loopback endpoints, malformed node records, incompatible schemas, failed
payments, and timeouts. Set `FIBER_FORGE_FAIL_AFTER_PAYMENT=1` only to exercise Action teardown after
a consumer failure.

For example, if the receiver endpoint is no longer reachable, the process exits non-zero with an
actionable result instead of an unhandled fetch error:

```json
{"code":"RPC_UNREACHABLE","message":"new_invoice could not reach node carol at http://127.0.0.1:8302","action":"confirm the Fiber Forge setup step is still running in this job and use its connection-json output"}
```
