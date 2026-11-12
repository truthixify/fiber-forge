# Live Verification

Fiber Forge separates fast unit/package CI from Docker-backed runtime evidence:

- [`ci.yml`](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml) runs formatting,
  type checks, unit tests, builds, SDK consumer checks, a production-dependency audit, and the
  packed-artifact smoke on every push and pull request.
- [`e2e.yml`](https://github.com/truthixify/fiber-forge/actions/workflows/e2e.yml) installs and checks
  the packed artifact, verifies native manifests for both pinned images before pulling, then runs
  real CKB/Fiber provisioning, automatic and explicit-router multi-hop CKB payments, live gossip and
  route inspection, relay recovery, safe export/fresh replay, force-close settlement, rollback, UDT,
  and cleanup paths.
- [`cch-e2e.yml`](https://github.com/truthixify/fiber-forge/actions/workflows/cch-e2e.yml) installs the
  packed artifact into an empty consumer and proves terminal Fiber-to-Lightning and
  Lightning-to-Fiber settlement twice against fresh CKB devnet and Bitcoin regtest state.

## Trigger And Release Policy

Live E2E runs on every push to `main`, runtime-relevant pull requests, manual dispatch, and the
weekly schedule. The workflow is also reusable: `publish.yml` calls it as a prerequisite, so a
`v*` tag cannot reach `npm publish` after a failed or incomplete live gate.

The publish job also requires the pushed `v*` tag to exactly match `package.json`. Stable versions
publish under npm's `latest` dist-tag; prerelease versions publish under `next`, so an RC cannot
silently replace the default install.

Pull requests that change source, Docker assets, live tests, package inputs, or either runtime
workflow automatically receive the live check. A reviewer can also dispatch it manually before
merge.

## Runtime Dependency Audit

The production dependency graph was reviewed on 2026-11-12 before and after updating
`@ckb-ccc/core` from 1.16.1 to 1.23.0. Both audits reported zero moderate, high, or critical
findings and four low entries representing one transitive advisory:

```text
@ckb-ccc/core@1.23.0
  -> @joyid/ckb@1.1.4
  -> @nervosnetwork/ckb-sdk-utils@0.109.5
  -> elliptic@6.6.1
```

The root finding is [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84).
The advisory covers incorrect ECDSA signatures in every published `elliptic` version through 6.6.1
and currently lists no patched version. npm's suggested fix is `@ckb-ccc/core@0.0.4`; that is an
incompatible downgrade and is not an accepted remediation.

Fiber Forge uses CCC's `SignerCkbPrivateKey`, which signs through `@noble/curves`, for local funding
and simple-UDT issuance. It does not call CCC's JoyID verification helpers or
`@nervosnetwork/ckb-sdk-utils`' ECPair signing API. The affected signing routine is therefore not on
a supported Fiber Forge execution path. The dependency remains installed, however, so the finding
is retained rather than suppressed. This disposition applies only to Fiber Forge's disposable local
networks and public dev-chain deployer key; it is not a statement that arbitrary use of the
transitive package is safe for production keys.

CCC 1.23.0 was accepted for transaction-building fixes relevant to Fiber Forge: fee-completion
convergence, minimum output capacity after data mutation, exact UDT type matching, and non-mutating
transaction normalization. Its legacy byte-encoding and Molecule-union changes do not intersect the
hex, address, transaction, or UDT APIs used here. The packed live suite remains the compatibility
gate for funding, UDT issuance, channels, and cleanup.

CI runs `npm audit --omit=dev --audit-level=high`, so a new high or critical production finding
fails the source gate while the reviewed low finding remains visible in the job log. Recheck the
advisory and the JoyID/CKB SDK dependency chain before each release and whenever CCC changes. Once a
patched upstream path exists, update it and rerun the Node compatibility, packed live, UDT, and CCH
proofs before removing this residual-risk record.

## Evidence Artifact

The `live-e2e-<run>-<attempt>` artifact is retained for 14 days and contains only:

- `summary.json`: schema version, package/commit, pinned image references and inspected image
  platform, host/Node/Docker versions, per-path and per-test results/durations, and cleanup status;
- `summary.md`: the same high-signal fields rendered in the workflow job summary; and
- `diagnostics.log`: a sanitized failure tail capped at 64 KiB.

Raw Vitest output and generated state never enter the uploaded artifact. Before publication, the
finalizer removes ANSI escapes, credentials, token-shaped values, private-key material, long hex
values, the home directory, and the temporary state path. Individual failure messages are capped at
2 KiB, the diagnostic file at 64 KiB, and the JSON summary at 128 KiB.

The finalizer runs with `if: always()`. It removes and then verifies the absence of every known E2E
container, Docker network, CKB volume, and temporary state directory. Cleanup failure fails the job
and remains visible in both summary formats.

The separate `cch-e2e-<run>-<attempt>` artifact uses the same three filenames and retention period.
Its summary records cold and warm-image-cache startup timings, exact terminal transfer reports, and
cleanup results for both fresh networks. Diagnostics remain capped at 64 KiB. The finalizer checks
all seven topology containers, the Docker network, six named volumes, and persisted state. CCH
evidence is a trusted local-development proof only, not a reserve proof, custody audit, or mainnet
safety claim.

## Failure Probe

The manual workflow input `failure_probe` deliberately fails the multi-hop payment stage after its
containers are running. The test still executes its `finally` cleanup, the workflow finalizer checks
for leftovers, and the artifact upload still runs. The injected token-shaped marker must appear only
as `[REDACTED]` in the downloaded evidence.

For the normal local path, run:

```sh
make e2e
npm run test:cch-e2e
```

The evidence files are written to `artifacts/live-e2e/` and `artifacts/cch-e2e/`, which are ignored
by Git.
Supported environments and durable environment-specific records are listed in the
[host compatibility matrix](compatibility.md).
