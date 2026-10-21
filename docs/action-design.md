# GitHub Action Design

**Decision:** accepted on 2026-10-20. Implement a JavaScript setup action with a job-final `post`
hook in this repository. Do not require consumers to remember a teardown step, and do not execute a
consumer-provided shell command inside the action.

GitHub registers a JavaScript action's `post` entry point after `main` and runs it at the end of the
job with an implicit `always()` condition. State written through `GITHUB_STATE` is available only to
that action's post process. These are documented platform contracts, not log conventions:

- [Action metadata: `runs.main`, `runs.post`, and `runs.post-if`](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#runs-for-javascript-actions)
- [Workflow state and output environment files](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions)
- [Cancellation sequence and force-cancel boundary](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)

## Evaluated Lifecycle Models

| Model | Failure cleanup | Flexibility | Decision |
| --- | --- | --- | --- |
| JavaScript `main` + `post` | Post is registered by the runner and defaults to `always()` after setup succeeds or fails. | Consumer tests remain ordinary later steps and use structured outputs. | Selected. |
| Separate setup/down steps | `if: always()` handles ordinary failures, but callers can omit or misconfigure teardown. | Maximum workflow flexibility. | Document as a fallback only, not the public contract. |
| Wrapper action runs a command in `try/finally` | Strongest in-process guarantee for a normal command failure. | Requires a shell command input, complicates quoting, hides step-level logs, and prevents normal output use across steps. | Rejected for the first public interface. |

Minimal selected workflow:

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v7
  - id: forge
    uses: truthixify/fiber-forge@9300bea5f9ec5e72bfdec30b6648a8e79325063d
    with:
      package-version: 0.4.0
      topology: trio
  - run: npm test
    env:
      FIBER_FORGE_CONNECTION: ${{ steps.forge.outputs.connection-json }}
```

The action's post hook tears the network down after `npm test`, including when that step exits
non-zero. The evaluated paired-step model can be expressed without the action, using one shared job
home and an explicit network name:

```yaml
- run: >-
    npx --yes --package @truthixify/fiber-forge@0.2.9
    fiber-forge up ./test/network.yml --json --no-gui > fiber-forge-connection.json
- run: npm test
  env:
    FIBER_FORGE_CONNECTION_FILE: fiber-forge-connection.json
- if: always()
  run: >-
    npx --yes --package @truthixify/fiber-forge@0.2.9
    fiber-forge down integration-net --purge
```

Here `integration-net` is the checked-in topology's `name`. This model works for ordinary failure
but is easier to misconfigure, so it is not the selected public interface. The rejected wrapper
prototype would put `npm test` into an action input; it is intentionally not implemented.

## Accepted Interface

Inputs:

| Input | Required/default | Contract |
| --- | --- | --- |
| `package-version` | Required | Exact semver only; ranges, tags, and `latest` are rejected. |
| `topology` | Required | `duo`, `trio`, `hub`, a valid `line:N`/`ring:N`/`star:N`, or a YAML path inside `GITHUB_WORKSPACE`. |
| `ckb-port` | Automatic | Optional loopback CKB RPC port. |
| `rpc-port-base` | Automatic | Optional first loopback Fiber RPC port. |
| `startup-timeout-ms` | `600000` | Overall SDK provisioning timeout, bounded from 1 second through 30 minutes. |
| `udt-per-node` | Disabled | Optional positive whole UDT amount; experimental with the SDK asset contract. |
| `diagnostics` | `failure` | `failure`, `always`, or `never`; controls the bounded report, never raw state. |

Outputs:

| Output | Shape |
| --- | --- |
| `network` | Created Fiber Forge network name. |
| `ckb-rpc` | Loopback HTTP URL. |
| `nodes-json` | JSON array of `{ name, pubkey, rpc }`; RPC URLs are loopback-only. |
| `connection-json` | Versioned JSON object containing network, CKB RPC, and nodes. |
| `report-path` | Absolute path to the bounded setup report on the runner. |
| `startup-duration-ms` | Decimal elapsed milliseconds. |

Outputs are written through `GITHUB_OUTPUT`; no consumer parses styled logs. Generated private keys,
node key passwords, Docker paths, and raw container configuration are never outputs.

## Setup And Cleanup Sequence

1. Validate the exact package version, numeric bounds, diagnostics mode, and topology target. Resolve
   topology files inside the workspace and reject traversal or symlink escape.
2. Create an action-specific install directory and state directory under `RUNNER_TEMP`. Save both to
   `GITHUB_STATE` before provisioning can create resources.
3. Install the exact npm package with scripts disabled. Resolve only the installed package's
   declared public `./sdk` import export, verify that it stays inside the package, then import it.
4. Resolve and validate the topology, save its network name to action state before Docker changes,
   then call `up` with the isolated state directory, deadline, optional ports, and an abort signal
   tied to process signals.
5. Call `inspect` and write the versioned connection object and report before setting outputs.
6. In `post`, import the already-installed package and call `down(network, { purge: true })`. If no
   network name was saved, provisioning never began; remove only the action's temporary directories.
7. Verify labeled containers, the Docker network, volume, and action state directory are absent.
   Cleanup is idempotent, and a cleanup failure fails the post action with named resources.

The post hook covers normal success, a later step failure, a setup failure after state is saved, and
standard cancellation when GitHub permits post steps to run. No action can guarantee cleanup after
runner loss, host termination, or force cancellation. GitHub-hosted runners are disposable; on a
self-hosted runner, the next invocation pre-cleans the topology's deterministic network name and
operators retain a documented `fiber-forge down <network> --purge` recovery command.

## Diagnostics Policy

The setup report contains action/package versions, input topology kind, loopback endpoints, duration,
result, and cleanup status. Failure diagnostics use bounded tails and the existing Fiber Forge
redaction rules. `failure` writes diagnostics only when setup or cleanup fails; `always` writes the
same bounded data on success; `never` retains only the minimal report needed for outputs. The action
does not upload artifacts itself because that would require dictating consumer retention; examples
can upload `report-path` explicitly.

## Threat And Maintenance Review

- The action receives no repository token and examples grant only `contents: read`. It never opens
  Docker, CKB, Fiber RPC, or the GUI on a non-loopback address.
- Package versions and action revisions are separate trust decisions. Evidence workflows pin an
  exact package version and immutable action commit; moving major tags are convenience only.
- Commands are spawned with argument arrays, not a shell. Topology files are data, restricted to the
  workspace, and validated by the released SDK before Docker changes.
- Installation disables lifecycle scripts and uses an action-private prefix. Bundled Action runtime
  dependencies are reviewed and updated with normal dependency automation.
- Logs and outputs exclude node passwords, generated key material, environment secrets, Docker
  authentication, and unbounded container output.
- The implementation lives at root `action.yml` plus committed dependency-free runtime JavaScript in
  this repository. No second repository or external service is required. Releases document both the
  immutable SHA and compatible npm package versions.

The executable contract is exercised by `test/action-design.test.mjs`. It validates both target forms,
exact version selection, loopback/secret-free output construction, post cleanup after a deliberately
failing consumer, and post execution after setup failure. Real Docker and runner behavior are the
acceptance gate for the implementation task, not inferred from the prototype.
