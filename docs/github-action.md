# GitHub Action

The repository Action starts a local Fiber Forge network for ordinary later workflow steps and
registers a job-final post hook that removes the exact network, volume, containers, and isolated
state. Use a full Action commit SHA and an exact npm package version; those are separate trust and
compatibility decisions.

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v7
  - id: forge
    uses: truthixify/fiber-forge@<full-commit-sha>
    with:
      package-version: 0.4.0-rc.1
      topology: trio
  - run: node examples/integration-app/src/connection.mjs
    env:
      FIBER_FORGE_CONNECTION: ${{ steps.forge.outputs.connection-json }}
```

`connection-json` has schema version 1 and contains the network name, the loopback CKB RPC URL, and
an array of `{ name, pubkey, rpc }` node records. `nodes-json`, `network`, `ckb-rpc`,
`startup-duration-ms`, and the temporary `report-path` are also available. RPC is never bound or
reported outside `127.0.0.1`.

The post hook runs after successful steps, normal step failures, and standard cancellation when the
runner is still able to execute post actions. Host loss and force cancellation cannot run cleanup.
GitHub-hosted runners are disposable; a self-hosted runner should run the workflow again, which
pre-cleans the same deterministic network, or use:

```console
npx --yes --package @truthixify/fiber-forge@0.4.0-rc.1 \
  fiber-forge down trio --purge
```

Diagnostics are bounded, redacted, and controlled by `diagnostics: failure|always|never`. The Action
does not upload them. Upload `report-path` in a later workflow step when retention is required; the
temporary action directory is removed by the post hook.

## Releases and updates

Action releases use immutable Git commit SHAs as the reproducibility reference. A release records
the compatible exact npm versions and the successful `action-e2e` run. Moving major tags may be
provided for convenience but are not evidence pins. The Action runtime intentionally uses only
Node's standard library; Node runtime changes, npm package dependencies, and pinned GitHub Actions
in the evidence workflow are reviewed with the normal dependency-update cadence and rerun both the
successful and deliberate-failure jobs.

The repository evidence workflow packs the current package as a release candidate, installs that
exact tarball with lifecycle scripts disabled, completes a real three-node multi-hop payment, and
independently checks Docker cleanup after a deliberately failing consumer. Public consumers install
the exact registry version named by `package-version`; the candidate-tarball override is reserved
for this repository's pre-release gate.
