import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_CCH_PROOF_TIMEOUT_MS,
  createFiberForge,
  preset,
} from "@truthixify/fiber-forge/sdk";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const outputFile = process.argv[2];
const stateRoot = process.argv[3];
const runPrefix = process.argv[4];
if (!outputFile || !stateRoot || !runPrefix) {
  throw new Error(
    "usage: cch-packed-runner <output> <state-root> <run-prefix>",
  );
}

const selected = preset("cch");
if (!selected?.cch)
  throw new Error("installed package does not expose the CCH preset");
await mkdir(stateRoot, { recursive: true });

const runs = [];
let failed = false;
for (const [index, mode] of ["cold-start", "warm-start"].entries()) {
  const net = `${runPrefix}-${index + 1}`.slice(0, 30);
  const stateDir = join(stateRoot, mode);
  const forge = createFiberForge({ stateDir });
  const started = Date.now();
  let startupMs = null;
  let proof = null;
  let failure = null;
  let cleanup = "passed";

  try {
    await forge.up({ ...selected, name: net }, { timeoutMs: 10 * 60_000 });
    startupMs = Date.now() - started;
    proof = await forge.proveCchTransfers(net, {
      timeoutMs: DEFAULT_CCH_PROOF_TIMEOUT_MS,
    });
    const status = await forge.cchStatus(net);
    if (status.state !== "ready") {
      throw new Error("CCH topology did not return to ready after settlement");
    }
  } catch (error) {
    failed = true;
    failure = {
      code: typeof error?.code === "string" ? error.code : "UNEXPECTED",
      message: "packed CCH run failed before verified terminal settlement",
      detail:
        error instanceof Error
          ? error.message.slice(0, 512)
          : "unknown packed runner failure",
      resource: typeof error?.resource === "string" ? error.resource : null,
      action: typeof error?.action === "string" ? error.action : null,
    };
  } finally {
    if (await exists(join(stateDir, net))) {
      try {
        await forge.down(net, { purge: true });
      } catch {
        failed = true;
        cleanup = "failed";
      }
    }
  }

  runs.push({
    mode,
    net,
    startupMs,
    totalMs: Date.now() - started,
    proof,
    failure,
    cleanup,
  });
  if (failure || cleanup !== "passed") break;
}

await writeFile(
  outputFile,
  JSON.stringify(
    {
      schemaVersion: 1,
      source: "installed-packed-artifact",
      runs,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);

await rm(stateRoot, { recursive: true, force: true });
if (failed || runs.length !== 2) process.exitCode = 1;
