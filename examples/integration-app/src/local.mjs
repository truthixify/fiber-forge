import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFiberForge, preset } from "@truthixify/fiber-forge/sdk";

import { assertMultiHopPayment, errorResult } from "./payment.mjs";

async function run() {
  const stateRoot = await mkdtemp(join(tmpdir(), "fiber-forge-integration-"));
  const network = `integration-${process.pid}`;
  const base = preset("trio");
  if (!base)
    throw new Error("the installed SDK does not provide the trio preset");
  const topology = { ...base, name: network };
  const forge = createFiberForge({ stateDir: stateRoot });
  let primaryError;
  let result;

  try {
    await forge.down(network, { purge: true });
    const layout = await forge.up(topology, {
      onProgress: (message) => console.log(`[setup] ${message}`),
    });
    const view = await forge.inspect(network);
    const byName = new Map(view.nodes.map((node) => [node.name, node]));
    const connection = {
      schemaVersion: 1,
      network,
      ckbRpc: `http://127.0.0.1:${layout.ckbHostPort}`,
      nodes: layout.nodes.map((node) => ({
        name: node.name,
        pubkey: byName.get(node.name)?.pubkey,
        rpc: `http://127.0.0.1:${node.rpcHostPort}`,
      })),
    };
    result = await assertMultiHopPayment(connection, {
      failAfterPayment: process.argv.includes("--fail-after-payment"),
    });
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    await forge.down(network, { purge: true });
  } catch (error) {
    cleanupError = error;
  }
  await rm(stateRoot, { recursive: true, force: true });
  if (!cleanupError) console.log("[cleanup] exact integration network removed");

  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `${errorResult(primaryError).message}; cleanup also failed: ${errorResult(cleanupError).message}`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

try {
  console.log(JSON.stringify(await run()));
} catch (error) {
  console.error(JSON.stringify(errorResult(error)));
  process.exitCode = 1;
}
