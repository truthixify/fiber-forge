# Disposable hosted sandbox

The checked-in development container is the supported hosted-sandbox prototype. Each reviewer gets
one isolated GitHub Codespace with its own Docker-in-Docker daemon and a fixed `alice - bob - carol`
network. There is no shared Fiber Forge service and no host Docker socket is mounted.

## Launch and review

1. Open [Fiber Forge in GitHub Codespaces](https://codespaces.new/truthixify/fiber-forge?quickstart=1)
   and create the default 4-core environment. Codespaces usage may consume your personal or
   organization quota.
2. Wait for the post-start task to print `Fiber Forge sandbox: ready`. The same output records the
   package version, checked-out commit, run ID, expiry time, and a successful one-CKB payment from
   `alice` to `carol` through `bob`.
3. Open **Fiber Forge GUI (private)** on port 5178 from the Ports panel. Keep its visibility set to
   **Private**, which is GitHub Codespaces'
   [authenticated default](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace?tool=vscode#sharing-a-port).
   Do not make the GUI or any node RPC port public.
4. Select `sandbox` in the GUI. Inspect all three funded nodes and the two ready channels, then use
   **Pay** to send another payment from `alice` to `carol`.

Useful lifecycle commands inside the Codespace are:

```sh
npm run sandbox:status
npm run sandbox:reset
npm run sandbox:stop
```

`reset` purges and recreates only the fixed sandbox network. `stop` removes its containers, Docker
network, CKB volume, node keys, and saved state. The supervisor performs the same verified cleanup
automatically four hours after each start. Stopping or deleting the Codespace provides the outer
tenant cleanup boundary as well.

## Security and resource boundary

- The development-container base image is pinned by multi-platform digest. The Docker-in-Docker
  feature, Docker Engine, CKB image, Fiber image, Node major, and npm dependency graph are pinned by
  the checked-in definition and lockfile.
- Docker-in-Docker gives every Codespace a dedicated daemon. The host Docker socket is never
  mounted, so one reviewer cannot inspect another reviewer's containers or keys. A separate
  `node_modules` volume also prevents Linux native packages in the container from replacing a local
  macOS or Windows installation when the definition is used outside Codespaces.
- CKB and Fiber RPC ports bind to `127.0.0.1` only. Automatic forwarding is disabled for every port
  except GUI port 5178. GitHub forwards that port privately by default and authenticates remote
  access. The sandbox backend rejects additional networks, fixing the workload at three nodes.
- The definition requests a host with 4 CPUs, 8 GB of memory, and 32 GB of storage, then caps the
  outer container at 4 CPUs, 8 GB of memory, and 4096 processes. It contains only disposable
  dev-chain assets and generated local keys; there is no testnet or mainnet configuration, account,
  token, wallet seed, or funded production credential.
- Runtime status is stored in `.sandbox/status.json` and deliberately contains no node keys or raw
  RPC endpoints. `npm run sandbox:status` makes the exact build and payment proof visible.

The environment reproduces the checked-out commit, not an uncommitted working tree. For a fixed
review, check out the desired commit before creating or rebuilding the container. The project itself
is built from that revision; no unpublished package is represented as released evidence.

## Why this model

| Model | Isolation and operations | Decision |
| --- | --- | --- |
| Per-user Codespace | Disposable tenant, authenticated private forwarding, no shared Docker API | Accepted prototype |
| On-demand hosted service | Requires a new auth layer, tenant scheduler, abuse controls, billing, and incident response | Deferred pending explicit deployment approval |
| Shared read-only demo | Cannot prove network creation or mutation and can become stale | Rejected |

This choice keeps costs with the reviewer's existing
[GitHub Codespaces allowance](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces).
There is no Fiber Forge cloud bill or always-on service. GitHub controls account quotas,
[idle timeout](https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces),
retention, and machine availability; the in-container four-hour expiry is an additional bound, not
a replacement for those controls.

Maintenance consists of reviewing pinned base-image and Docker feature updates, running the complete
local and live verification gates, and then updating their exact references. In an incident, remove
or disable repository Codespaces access and close active Codespaces; no shared endpoint needs to be
drained. A centrally operated or paid sandbox remains intentionally undeployed until its threat
model, quota, cost ceiling, and disable procedure receive explicit approval.
