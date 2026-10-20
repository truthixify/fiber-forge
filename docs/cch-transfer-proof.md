# CCH Transfer Proof

The CCH proof executes both accepted local cross-network directions against a running `cch`
topology:

```sh
fiber-forge up cch --no-gui
fiber-forge cch prove cch --output cch-transfer-proof.json
fiber-forge down cch --purge
```

The packaged [two-way demo script](../examples/cch-two-way.sh) runs the same commands and installs a
cleanup trap. It accepts the report path as its only optional argument.

Success is deliberately stricter than request acceptance. For each direction, Fiber Forge requires
the CCH order to reach `Success`, verifies the shared payment hash and wrapped type script, checks the
Fiber payment or Lightning invoice/payment terminal state, and reconciles exact user and hub balance
deltas. The JSON report records decimal strings for amounts and fees, labels wrapped values as
`base_units` and Lightning values as `satoshis`, and includes every observed CCH order transition.
Invoices, preimages, macaroons, certificates, private keys, and wallet material are never included.

The automated `cch-e2e` workflow builds and installs the npm tarball into an empty consumer before
running the proof. It executes a first cold process/topology start and a second warm image-cache
start. Both runs use new network names, state directories, volumes, Lightning liquidity, and
credentials. The workflow publishes bounded `summary.json`, `summary.md`, and `diagnostics.log`
artifacts and verifies removal of all seven containers, the Docker network, six named volumes, and
the persisted network directory after each run.

This proves a disposable development path only. CKB runs in devnet mode, Bitcoin runs in regtest,
the operator supplies both liquidity pools, and the wrapped asset uses a trusted 1:1 fixture rate.
The report is not a Bitcoin reserve proof, a custody audit, or evidence of mainnet safety.
