# Export and replay bundle contract

**Decision:** accepted on 2026-10-20. Fiber Forge supports shareable recipe bundles and bounded
diagnostic bundles. It does not support exporting or restoring live node databases, Docker volumes,
private keys, or exact channel state.

The product terms are `export`, `inspect`, and `replay`. A `.ffbundle` reproduces a declarative test
on a fresh local network; it is not a VM image, backup, state snapshot, or exact restore point.

## Guarantees

A supported replay:

1. validates the complete untrusted bundle without provisioning or writing archive-controlled paths;
2. creates a clean network from the bundled topology with fresh CKB and Fiber keys;
3. runs the bundled checked scenario;
4. compares assertion outcomes with the recorded scenario report; and
5. purges every resource it created on success, failure, timeout, or ordinary cancellation.

Replay does not preserve node public keys, CKB addresses, channel IDs, payment hashes, ports, Docker
subnets, chain history, balances created outside the recipe, or in-flight HTLC/channel state. Those
values can appear only as sanitized diagnostics and are never replay inputs.

## Persisted-state audit

The default state root is `~/.fiber-forge/<network>/`. The audit used the implementation and a live
local state tree without reading key contents. The observed tree contained 273 files (about 7.1 MiB)
across the following stable classes:

| Item | Contents and risk | Bundle decision |
| --- | --- | --- |
| `layout.json` | Network/container names, host ports, private IPs, public node keys, CKB addresses, and channel recipe. Host-specific metadata; public identifiers can still correlate a run. | Do not copy. Rebuild `topology.json` from validated logical fields; regenerate layout, ports, addresses, and keys. |
| `faults.json` | Active fault intent, timestamps, isolation network/IP metadata. Not a credential, but replaying it as state could strand resources. | Do not copy or activate on import. Fault actions belong in `scenario.json`; a sanitized fault view may appear in diagnostics. |
| `<node>/ckb/key` | 77-byte encrypted CKB private key. The current password is derived from the network/node layout, so encryption does not make it shareable. | Always exclude. Generate a fresh private key and encrypted key file during replay. |
| `<node>/fiber/sk` | Raw 32-byte Fiber network private key, mode `0400`. | Always exclude. Let a fresh node generate a new key during replay. |
| `<node>/fiber/store/*` | Fiber RocksDB files containing version-coupled channel/payment/peer state and potentially sensitive protocol material. | Always exclude. Never inspect, redact, copy, or restore. Start with an empty store. |
| `<node>/config.yml` | Generated RPC/CKB endpoints and UDT whitelist. No current credential, but it is tied to the source layout. | Exclude and regenerate from the validated topology and pinned package assets. |
| `<node>/dev.toml` | Static dev-chain configuration copied from the package. | Exclude; record the package/image versions and regenerate from the installed package. |
| `<node>/contracts/*` | Static contract binaries copied from the package. | Exclude; use the exact installed package and verify its packed artifact. |
| `forge-<network>-ckb-data` Docker volume | CKB chain/index data and runtime files. Large, host/image-version coupled, and capable of retaining transaction history. | Always exclude. Replay creates a fresh dev chain. |
| Container configuration/environment | Includes `FIBER_SECRET_KEY_PASSWORD`, bind-mount paths, image settings, and runtime identifiers. `docker inspect` would expose the password. | Never collect raw container inspection. Export only allowlisted image references and sanitized observations. |
| Docker stdout/stderr logs | May contain invoices, hashes, absolute paths, RPC input, or future credential-shaped values. | Diagnostic level only: bounded tail, ANSI removal, secret/path redaction, then a second deny-pattern scan. |
| Host environment, npm configuration, Docker auth, SSH files | Can contain production tokens and credentials unrelated to Fiber Forge. | Never read or enumerate. No environment map or home-directory archive is allowed. |
| Topology/scenario source | Required logical input. Free-form descriptions could contain user text. | Re-serialize validated objects. Omit payment/invoice descriptions; reject secret-shaped structural values. Never copy source bytes. |
| Scenario report/network/channel/fault views | Public identifiers and local state observations; runner errors are already sanitized. | Allowlisted artifacts. Re-sanitize text and absolute paths before export; never use diagnostic values as replay configuration. |

The dev-chain treasury key committed in source is a public local-test fixture, not a production
credential. It is still not copied into bundles because replay obtains the same development behavior
from the pinned package and CKB image.

## Accepted levels

### Recipe bundle

Required files:

- `manifest.json`: format, compatibility pins, capabilities, and hashes;
- `topology.json`: canonical validated topology, without layout/port/password fields;
- `scenario.json`: canonical schema-version-1 scenario, with descriptions omitted; and
- `report.json`: sanitized scenario report used as the expected replay result.

This is the default and the artifact intended for source control, issue trackers, and cross-host
reproduction.

### Command and SDK shape

The implementation exposes three explicit operations:

```console
fiber-forge export <network> --scenario scenario.yml --report report.json --output case.ffbundle
fiber-forge export <network> --scenario scenario.yml --report report.json --diagnostics --output case.ffbundle
fiber-forge bundle inspect case.ffbundle --json
fiber-forge replay case.ffbundle --network fresh-replay-name --json
```

The SDK mirrors these as typed `exportBundle`, `inspectBundle`, and `replayBundle` operations. Export
requires an existing managed network, a validated scenario, and a report produced for that scenario.
Before writing a bundle, it expands the scenario loop and verifies that the report has the same
ordered actions and the same assertion types and expected values. A missing, extra, reordered, or
mismatched result rejects export; a report cannot be attached to a different scenario merely because
both files parse. Export never infers expected behavior from live state. Replay requires a
caller-selected, validated fresh network name so an imported bundle cannot select a cleanup target.

Legacy unversioned `layout.json` files record nodes and channel capacities but not the original
per-node funding, so they cannot reconstruct a faithful topology by themselves. Current layouts
persist schema version 1 and the normalized topology. A legacy layout is exportable only with
`--topology <file>` (or the SDK equivalent); the exporter validates that its network name, ordered
node set, and channels match recorded state before using its funding declaration. Guessing funding
from current balances is prohibited.

### Diagnostic bundle

Contains the recipe files and an allowlisted subset of:

- `diagnostics/network.json`: sanitized `inspect` result;
- `diagnostics/channels.json`: sanitized channel rows;
- `diagnostics/faults.json`: sanitized fault observations; and
- `diagnostics/logs/ckb.log` and `diagnostics/logs/node-<node>.log`: at most 64 KiB per tail and
  512 KiB for all logs combined. The `node-` prefix keeps a node named `ckb` distinct from the
  chain log.

Diagnostics are inert evidence. Replay never reads them to choose images, resource names, actions,
or expected assertions.

### Stateful archive

Rejected and unsupported. Exact channel-state restoration would require raw Fiber stores, both node
keys, and compatible CKB state. Encryption would add key custody and recovery requirements without
solving image/database compatibility, rollback safety, or accidental mainnet-key inclusion.

There is no recorded user approval to implement this level. A future stateful-archive proposal must
be a separate, explicit opt-in decision that specifies encryption and key custody, Fiber/CKB database
compatibility, authenticated archive metadata, rollback behavior, and destructive restore UX. A
general request to finish export/replay work is not approval to include node databases.

## Archive and manifest

A `.ffbundle` is a gzip-compressed USTAR archive. Export normalizes entry order, modification time
(`0`), uid/gid (`0`), user/group names (empty), and regular-file mode (`0644`). File names are ASCII,
POSIX-relative, and selected from the level allowlist. Stable logical inputs therefore produce the
same canonical topology/scenario bytes and `recipeDigest`; timestamps and diagnostics do not promise
byte-identical archives. For fixed manifest and artifact bytes, the USTAR body is canonical; the
gzip DEFLATE encoding may vary across Node.js/zlib releases without changing bundle semantics.

The version-1 manifest schema is published at
[`schema/export-manifest-v1.schema.json`](schema/export-manifest-v1.schema.json). Its core fields are:

- `format: "fiber-forge-export"`;
- independent `{ major, minor }` schema version;
- `level: "recipe" | "diagnostic"`;
- generator package and exact version;
- exact CKB and Fiber image references;
- source host metadata for diagnosis, never resource selection;
- `exactStateRestore: false` and `containsSecrets: false` capabilities;
- an ordered artifact list with role, media type, byte size, and SHA-256; and
- `recipeDigest`, the stable semantic identity.

Artifact hashes use lowercase `sha256:<64 hex>` values and cover the exact uncompressed bytes. The
recipe digest hashes canonical JSON containing schema major, exact image references, and the
topology/scenario artifact hashes. Canonical JSON recursively sorts object keys, preserves array
order, emits no insignificant whitespace, and uses UTF-8. Reports, diagnostics, source host, and
`createdAt` are intentionally excluded from `recipeDigest`.

Hashes detect corruption and make semantic comparison deterministic. They do not authenticate a
malicious author, who can replace content and hashes together. Bundles are unsigned in version 1;
provenance must come from the transport, repository commit, or separately signed release artifact.

## Import validation

`inspect` and `replay` treat every bundle as hostile. Before Docker access, network calls, or
provisioning, the importer must:

1. require a regular input file no larger than 4 MiB;
2. bounded decompression with a 2 MiB uncompressed limit, at most 64 entries, a 1 MiB per-entry
   limit, a 64 KiB manifest limit, and a 64 KiB per-log/512 KiB aggregate-log limit;
3. reject absolute paths, `.`/`..`, empty segments, backslashes, NULs, non-ASCII names, names over
   240 bytes, duplicates, case-fold collisions, and every path outside the level allowlist;
4. reject symlinks, hard links, devices, FIFOs, sparse files, PAX/GNU extensions, nested archives,
   executable modes, and any non-regular tar entry;
5. parse strict JSON with bounded files and reject duplicate/unknown manifest fields, unsupported
   schema versions, unknown roles/media types/hash algorithms, and artifacts missing from either the
   archive or manifest;
6. verify every declared byte count and hash with timing-safe digest comparison;
7. require exactly one topology, scenario, and scenario-report artifact; enforce each role's fixed
   path and media type; and verify the report's ordered actions, assertion types, and expected values
   against the expanded scenario;
8. parse topology and scenario through the existing validators, then enforce replay-specific total
   resource/time limits;
9. scan every text artifact for private-key blocks, credential labels, bearer/GitHub tokens, long
   hex/base64 secrets, URLs with credentials, and absolute source paths; and
10. hold validated entries in bounded memory or an importer-created `mkdtemp` directory. Never join
   an archive path onto a caller-selected extraction root and never invoke a shell.

Inspection is read-only and prints manifest, compatibility, integrity, and redaction status. It does
not pull images, contact Docker, create files beside the bundle, or execute a scenario.

## Replay compatibility

| Dimension | Version-1 behavior |
| --- | --- |
| Bundle schema | Major `1`, minor `0` is supported. Unknown major or newer minor is rejected before artifact use. |
| Fiber Forge package | Exact generator version is supported. A different version may inspect the base envelope but replay is rejected; re-export with the installed version. |
| CKB/Fiber images | References must exactly equal the installed package's pinned references. Replay refuses arbitrary or drifted image references. A native manifest for the target Docker daemon is required. |
| OS/architecture | Linux amd64 and macOS arm64 with Docker Desktop are supported using their native image variants. Other hosts are rejected until the compatibility matrix records full live evidence. |
| Docker/Node | Replay requires Node.js 20 or newer on a supported host family. The manifest records source versions as evidence, but patch-level Docker differences are not a replay input. Docker availability and native-image compatibility still fail before provisioning. |
| Source to target host | Recipe replay between the two supported host rows is supported because keys, ports, subnet, chain, and databases are regenerated. Source image IDs may differ by native architecture; image references must not. |
| Reports | Assertion type, expected value, pass/fail outcome, and aggregate result are comparable. Timestamps, durations, attempts, public keys, addresses, hashes, channel IDs, ports, and diagnostic text are informational and may differ. |
| Exact state/channel restore | Unsupported on every version and host. |

Replay uses only package-approved pinned images; an untrusted manifest cannot select executable
container code. It requires a new validated target network name and fails if same-name Fiber Forge
resources or state already exist. Cleanup is scoped by that validated name and Fiber Forge labels.

## Threat model

| Threat | Control |
| --- | --- |
| Path traversal or overwrite | No caller-controlled extraction; strict path grammar, allowlist, collision checks, and regular-file-only archive entries. |
| Compression/memory/disk denial of service | Compressed, expanded, entry-count, per-file, JSON, and log limits enforced while streaming. |
| Archive parser ambiguity | USTAR regular files only; no links, extensions, duplicate names, alternate separators, or unknown schema fields. |
| Corrupt/truncated content | Exact byte counts and SHA-256 for every payload before parsing or execution. |
| Malicious image execution | Image references must equal package pins; no Dockerfile, Compose file, binary, plugin, or command is accepted from a bundle. |
| Shell/code execution through scenario | Existing closed scenario vocabulary and topology validators; replay uses APIs and argument arrays, never `eval` or a shell. |
| Secret exfiltration from source | Construct artifacts from allowlisted API data, exclude raw state, omit descriptions, redact bounded logs/reports, scan the final payload, and fail closed on residual matches. |
| Diagnostic data changing replay | Diagnostic roles are never consulted for provisioning, actions, assertions, or compatibility pins. |
| Resource collision/destructive cleanup | Validate a clean target name before Docker mutation; label every created resource; purge only resources owned by that replay. |
| Forged provenance | Hashes provide integrity, not authorship. Users must trust the bundle source or an external signature. |

## Reviewable sample

[`examples/export-v1`](examples/export-v1/manifest.json) is the logical, uncompressed form of a recipe
bundle, and [`failure.ffbundle`](examples/export-v1/failure.ffbundle) is its checked shareable
archive. CI rebuilds the archive, verifies every manifest hash, inspects it through the production
importer, and checks that it has no secret-shaped content, symlinks, unexpected files, oversized
entries, or forbidden persisted-state names such as `ckb/key`, `fiber/sk`, `fiber/store`, and Docker
volume data. Security tests also exercise traversal, link, expansion, hash, schema, cancellation,
and cleanup rejection paths directly.
