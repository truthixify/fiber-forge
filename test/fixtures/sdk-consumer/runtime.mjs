import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as sdk from "@truthixify/fiber-forge/sdk";

const expectedRuntimeExports = [
  "FUNDING_BUFFER_CKB",
  "MAX_NODES",
  "MIN_CHANNEL_CAPACITY_CKB",
  "MIN_NODES",
  "TopologyError",
  "createFiberForge",
  "line",
  "parseTopology",
  "preset",
  "presetNames",
  "ring",
  "star",
  "validateTopology",
  "version",
];

assert.deepEqual(Object.keys(sdk).sort(), expectedRuntimeExports.sort());

const packageMetadata = JSON.parse(
  await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
);
assert.equal(sdk.version, packageMetadata.version);
assert.equal(sdk.preset("trio").nodes.length, 3);
assert.equal(typeof sdk.createFiberForge().up, "function");
