import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as sdk from "@truthixify/fiber-forge/sdk";

const expectedRuntimeExports = [
  "DEFAULT_PROVISION_TIMEOUT_MS",
  "FUNDING_BUFFER_CKB",
  "ForgeError",
  "MAX_NODES",
  "MIN_CHANNEL_CAPACITY_CKB",
  "MIN_NODES",
  "TopologyError",
  "createFiberForge",
  "errorDetails",
  "line",
  "parseTopology",
  "planNetwork",
  "preset",
  "presetNames",
  "ring",
  "star",
  "validateTopology",
  "version",
];

assert.deepEqual(Object.keys(sdk).sort(), expectedRuntimeExports.sort());

const packageMetadata = JSON.parse(
  await readFile(
    new URL(
      "../package.json",
      import.meta.resolve("@truthixify/fiber-forge/sdk"),
    ),
    "utf8",
  ),
);
assert.equal(sdk.version, packageMetadata.version);
assert.equal(sdk.DEFAULT_PROVISION_TIMEOUT_MS, 600_000);
assert.equal(sdk.preset("trio").nodes.length, 3);
assert.equal(
  sdk.parseTopology(`
name: package-smoke
nodes: [{ name: alice }, { name: bob }]
channels: [{ from: alice, to: bob, capacity_ckb: 1000 }]
funding: { per_node_ckb: 100000 }
`).channels.length,
  1,
);
assert.equal(typeof sdk.createFiberForge().up, "function");
assert.equal(sdk.planNetwork(sdk.preset("duo")).nodes.length, 2);
assert.deepEqual(
  sdk.errorDetails(
    new sdk.ForgeError("OPERATION_ABORTED", "aborted", {
      resource: "preflight",
    }),
  ),
  {
    code: "OPERATION_ABORTED",
    message: "aborted",
    resource: "preflight",
  },
);
