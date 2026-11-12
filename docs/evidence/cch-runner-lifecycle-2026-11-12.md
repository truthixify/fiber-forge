# CCH Runner Lifecycle Evidence

- **Recorded:** 2026-11-12
- **Affected run:** [GitHub Actions run 39649745421](https://github.com/truthixify/fiber-forge/actions/runs/39649745421) at `742388f15d42f1a16e8f53f8620f91791a47067e`
- **Comparison run:** [GitHub Actions run 39543925459](https://github.com/truthixify/fiber-forge/actions/runs/39543925459) at `70a245ec23d4aa4de2b5fe13d65bd4c54abe5f68`

## Observed Failure

The affected Node 20.20.2 job packed and installed the package, pulled the pinned images, and built successfully. Its installed runner then ended after roughly three seconds with child exit code 13 before writing `runner.json`. The outer harness produced a failed summary and recovered the managed resources, but it could not name the awaited provisioning or proof operation. The comparison run passed on the same Node version. The intervening product change was limited to GUI, documentation, tests, and publishing workflow files; it did not change CCH orchestration.

## Root-Cause Boundary

Node exit code 13 is consistent with an unsettled top-level await, but that signal alone does not identify the pending call. The failed artifact's retention period has ended, and the old runner recorded no phase before its final report, so the exact internal SDK or Docker await cannot be recovered responsibly.

The code audit did establish two harness defects that made this failure possible and opaque: the installed runner depended on nested operations to retain an event-loop handle, and it persisted evidence only after all live phases completed. The remediation addresses that lifecycle boundary without claiming an unsupported internal cause and without adding retries or extending the accepted operation timeouts.

## Remediation

- Persist a mode-`0600` bounded runner report atomically before and after every live phase.
- Keep provisioning and proof operations under referenced phase deadlines tied to their existing SDK deadlines plus a small reporting grace period.
- Abort supported operations cooperatively when the runner-owned deadline fires.
- Preserve the active or last failed phase in the sanitized outer summary.
- Record child exit code, signal, duration, and timeout state.
- Treat Docker inspection failures as failed cleanup evidence rather than resource absence.
- Continue to validate exact settlement, balance, trust-boundary, and secret-exclusion requirements unchanged.

## Verification Boundary

Focused tests cover complete, failed, partial, and missing runner reports; stalled phase deadlines; atomic partial state; symlinked temporary consumers; sanitization; and Docker absence versus inspection failure. A packed external-consumer probe with Docker unavailable records `cold-start:provision`, `DOCKER_UNAVAILABLE`, child process metadata, and conservative cleanup inspection failures.

A packed macOS arm64 proof on Node 24.13.0 and Docker Desktop 29.3.1 passed on 2026-11-12. The cold start reached readiness in 29,951 ms, the warm image-cache start in 30,613 ms, both two-direction proofs passed, the installed runner exited 0 after 68,517 ms, and final inspection found no containers, network, volumes, state directories, or inspection failures for either run.

Three consecutive fresh Linux packed CCH proofs and their zero-residue observations remain required before this remediation can be used as release evidence.
