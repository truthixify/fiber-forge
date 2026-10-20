# Checked scenarios

`fiber-forge run` executes a bounded YAML test specification against an existing local network. A
scenario can perform supported network operations, poll observable state, and produce one stable JSON
report for CI. It cannot run JavaScript, shell commands, Docker commands, or arbitrary expressions.

## Run the examples

The examples use the fixed node names in `examples/topology.yml`:

```console
fiber-forge up ./examples/topology.yml --no-gui
fiber-forge run my-net ./examples/payments.yml
fiber-forge run my-net ./examples/outage-recovery.yml --json
fiber-forge down my-net --purge
```

`run` exits `0` when every step passes, `2` when execution completed but an action or assertion
failed, and `1` when the scenario is invalid or cannot be loaded. JSON mode writes exactly one report
to stdout. Schema/load failures use the standard structured error on stderr.

## Schema version 1

New files should declare `version: 1`. Files without `version` retain the original action-only
behavior and are interpreted as version 1. Unknown versions fail before any live operation starts.

```yaml
version: 1
steps:
  - fault: { action: apply, kind: node-kill, target: bob }
    expect: { node_status: stopped, timeout_ms: 10000 }

  - pay: { from: alice, to: carol, amount: 10 }
    expect: { error_code: PAYMENT_FAILED }

  - fault: { action: reset, kind: node-kill, target: bob }
    expect: { node_status: running, timeout_ms: 60000 }

  - assert:
      channel_state: { node: alice, peer: bob, equals: ChannelReady }
      timeout_ms: 60000
      poll_interval_ms: 500

  - assert:
      balance: { node: alice, asset: ckb, operator: gte, amount: "1000.00000000" }
```

The top-level keys are:

| Key | Meaning |
| --- | --- |
| `version` | Schema version. Use `1`; omission is accepted only for legacy compatibility. |
| `loop` | Positive integer repeat count. Defaults to `1`. |
| `steps` | Ordered non-empty action list. |

At most 1,000 steps, 10,000 total loop executions, and one hour of expanded declared waits/polling
windows are accepted. Unknown keys are errors.

## Actions

Each step contains exactly one action:

| Action | Fields |
| --- | --- |
| `pay` | `from`, `to`, `amount`, optional `description`, optional `udt` |
| `open` | `from`, `to`, `capacity`, optional `udt` |
| `close` | `node`, `channel` |
| `fund` | `node`, `amount` in whole CKB |
| `invoice` | `node`, `amount`, optional `description`, optional `udt` |
| `node` | `action` (`inspect`, `stop`, `start`, `restart`), `node`, optional `timeout_ms` |
| `fault` | `action` (`apply`, `reset`), `kind`, and `target` where the fault requires one |
| `assert` | One typed predicate plus optional polling controls |
| `wait` | A non-negative duration in milliseconds, capped at one hour |

`pay`, `open`, and `invoice` use whole CKB by default. Set `udt: true` for the included dev UDT.

## Expectations and assertions

An action can have one `expect` outcome:

- `payment_status`: exact Fiber payment status, valid only for `pay`;
- `node_status`: `running`, `stopped`, `unhealthy`, or `absent`, valid for node actions and targeted
  faults; or
- `error_code`: one stable Fiber Forge error code from [Lifecycle errors](lifecycle-errors.md).

Standalone `assert` steps support:

- `node_status`, selected by node name;
- `channel_state`, selected by node plus `channel_id`, `peer`, or both; and
- `balance`, selected by node and `ckb` or `udt`, with `eq`, `gte`, or `lte`.

Assertions poll every `poll_interval_ms` (default 500 ms) until `timeout_ms` (default 30 seconds,
maximum 5 minutes). A zero timeout makes exactly one observation. Payment status and expected errors
are immediate results because there is no follow-up payment lookup in the current Fiber API.

Balance values use whole-asset units with up to eight decimal places. Quote fractional amounts in
YAML, for example `"10.00000001"`. The parser converts both expected and observed balances to integer
base units before comparing them; floating-point equality is never used.

## Reports and cleanup

Every run returns `fiber-forge-scenario-report` version 1. The report includes network and schema
versions, start/end timestamps, total duration, aggregate counts, and each step's timing, pass state,
actual value, expected value, attempts, and stable error details.

```json
{
  "format": "fiber-forge-scenario-report",
  "version": 1,
  "scenarioVersion": 1,
  "network": "my-net",
  "startedAt": "2026-10-20T09:00:00.000Z",
  "finishedAt": "2026-10-20T09:00:00.002Z",
  "durationMs": 2,
  "passed": false,
  "summary": { "total": 1, "passed": 0, "failed": 1 },
  "steps": [
    {
      "index": 0,
      "iteration": 0,
      "action": "assert",
      "passed": false,
      "summary": "node_status: failed",
      "startedAt": "2026-10-20T09:00:00.000Z",
      "finishedAt": "2026-10-20T09:00:00.002Z",
      "durationMs": 2,
      "actual": "running",
      "assertions": [
        {
          "type": "node_status",
          "passed": false,
          "expected": "stopped",
          "actual": "running",
          "attempts": 1,
          "durationMs": 2,
          "diagnostic": "expectation was not met within 0ms"
        }
      ]
    }
  ]
}
```

A failed action or assertion is recorded instead of aborting the sequence. Put reset and cleanup
steps after destructive operations; they still run when an earlier expectation fails. Parser errors
remain fail-fast because no live operation has started.

Reports omit generated invoice strings and stack traces. Diagnostics redact invoice-like values,
credential labels, and long hexadecimal secrets. Scenario files are still source code artifacts:
do not put wallet seeds, private keys, tokens, or passwords in them.
