import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as sdk from "@truthixify/fiber-forge/sdk";

const expectedRuntimeExports = [
  "BUNDLE_SCHEMA_VERSION",
  "DEFAULT_REPLAY_TIMEOUT_MS",
  "DEFAULT_PROVISION_TIMEOUT_MS",
  "FAULT_KINDS",
  "FUNDING_BUFFER_CKB",
  "ForgeError",
  "MAX_NODES",
  "MAX_BUNDLE_BYTES",
  "MAX_BUNDLE_ENTRIES",
  "MAX_BUNDLE_EXPANDED_BYTES",
  "MAX_REPLAY_TIMEOUT_MS",
  "MIN_CHANNEL_CAPACITY_CKB",
  "MIN_NODES",
  "TopologyError",
  "SCENARIO_REPORT_VERSION",
  "SCENARIO_SCHEMA_VERSION",
  "ScenarioError",
  "createFiberForge",
  "errorDetails",
  "isFaultKind",
  "line",
  "parseTopology",
  "parseScenario",
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
const forge = sdk.createFiberForge();
assert.deepEqual(sdk.FAULT_KINDS, [
  "node-kill",
  "peer-partition",
  "ckb-unavailable",
  "mining-pause",
]);
assert.equal(typeof forge.up, "function");
assert.equal(typeof forge.inspectNode, "function");
assert.equal(typeof forge.stopNode, "function");
assert.equal(typeof forge.startNode, "function");
assert.equal(typeof forge.restartNode, "function");
assert.equal(typeof forge.applyFault, "function");
assert.equal(typeof forge.faultStatus, "function");
assert.equal(typeof forge.resetFault, "function");
assert.equal(typeof forge.resetAllFaults, "function");
assert.equal(typeof forge.mineBlocks, "function");
assert.equal(typeof forge.runScenario, "function");
assert.equal(typeof forge.exportBundle, "function");
assert.equal(typeof forge.inspectBundle, "function");
assert.equal(typeof forge.replayBundle, "function");
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
