# Host Compatibility

Fiber Forge calls a host **supported** only after the packed npm artifact has completed real
provisioning, a three-node multi-hop CKB payment, stopped-relay recovery, and verified teardown on
that environment. An available container-image manifest or a passing TypeScript suite alone does
not qualify a host.

## Support Matrix

| Host | Status | Last verified | Runtime | Evidence |
| --- | --- | --- | --- | --- |
| Linux amd64 | Supported | 2026-10-20 | Node 20.20.2, Docker 28.0.4, native linux/amd64 images | [record](evidence/linux-amd64-2026-10-20.json), [GitHub run](https://github.com/truthixify/fiber-forge/actions/runs/39363776395) |
| macOS arm64 with Docker Desktop | Supported | 2026-10-20 | Darwin 24.6.0, Node 24.13.0, Docker Desktop 29.3.1 with a linux/arm64 daemon | [record](evidence/macos-arm64-2026-10-20.json) |
| WSL2 | Unverified | Not run | Requires a Linux distro and Docker Desktop WSL2 integration | No live evidence yet |

Both supported rows used `@truthixify/fiber-forge@0.2.9`, `nervos/ckb:v0.201.0`, and
`nervos/fiber:0.9.0-rc7`. The evidence records include the exact image IDs and the result of each
required path.

Recipe-bundle replay is portable only between supported rows using the exact exporter package
version and pinned image references. It regenerates keys, ports, chain data, and channel identifiers;
stateful database/volume restore is unsupported. The complete decision table is in the
[export and replay bundle contract](export-bundles.md).

## Image Platform Preflight

The repository's live verification checks the Docker daemon OS and architecture, fetches the
manifest lists for both pinned runtime images, and prints the available platforms before pulling
either image. It refuses a missing native platform instead of silently enabling emulation. Run the
same gate locally with:

```sh
node scripts/live-evidence.mjs pull-images
```

`make e2e` includes this preflight before the packed-artifact and live tests. At the verification
date, both pinned tags published `linux/amd64` and `linux/arm64` variants; the CKB arm variant was
identified as `linux/arm64/v8`.

## WSL2 Verification Instructions

WSL2 is not currently a supported row because no complete live artifact has been recorded. To run
the verification without changing that status prematurely:

1. Enable Docker Desktop's WSL 2 engine and its integration for the chosen Linux distribution.
2. Install Node.js 20 or newer inside that distribution and run every command from its shell.
3. Clone the repository into the Linux filesystem, such as `~/src/fiber-forge`, rather than
   `/mnt/c`. Fiber node state is bind-mounted; Windows-mounted files can have materially different
   permissions, metadata behavior, and I/O performance.
4. Confirm `docker info` reaches Docker Desktop's Linux daemon. Make sure ports 8114 and 8300 onward
   are free and that Windows firewall or localhost-forwarding rules do not intercept them.
5. Run `npm ci && make e2e`, retain the three bounded evidence files, and verify that cleanup reports
   no remaining containers, networks, volumes, or temporary state.

Only a successful record containing all required paths should change the WSL2 row to supported.

## Limitations

- Windows-native PowerShell or Command Prompt operation is unsupported; WSL2 is the intended path
  but remains unverified.
- Linux arm64 and macOS amd64 are unverified as host environments even though both image tags expose
  matching manifests. A manifest is not a substitute for the full live proof.
- Other operating systems and CPU architectures are unsupported unless a row is added with dated
  evidence.
- Emulated cross-architecture execution is unverified and is not an automatic fallback. Fiber Forge
  verification requires a native image for the Docker daemon platform.

The GitHub artifact attached to a run is retained for 14 days. The compact records under
`docs/evidence/` keep the environment, immutable image IDs, exercised paths, and source run in the
repository after that artifact expires.
