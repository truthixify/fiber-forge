import { realpathSync } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCchRunnerReport,
  persistCchRunnerReport,
  runBoundedCchRunnerStage,
} from "./cch-runner-state.mjs";

const PROVISION_TIMEOUT_MS = 10 * 60_000;
const PROVISION_STAGE_TIMEOUT_MS = PROVISION_TIMEOUT_MS + 15_000;
const PROOF_STAGE_GRACE_MS = 15_000;
const STATUS_STAGE_TIMEOUT_MS = 60_000;
const CLEANUP_STAGE_TIMEOUT_MS = 2 * 60_000;
const INITIALIZE_STAGE_TIMEOUT_MS = 30_000;
const FINALIZE_STAGE_TIMEOUT_MS = 30_000;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function failureOf(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "UNEXPECTED",
    message: "packed CCH run failed before verified terminal settlement",
    detail:
      error instanceof Error
        ? error.message.slice(0, 512)
        : "unknown packed runner failure",
    resource: typeof error?.resource === "string" ? error.resource : null,
    action: typeof error?.action === "string" ? error.action : null,
  };
}

export async function runPackedCchEvidence(args = process.argv.slice(2)) {
  const [outputFile, stateRoot, runPrefix] = args;
  if (!outputFile || !stateRoot || !runPrefix) {
    throw new Error(
      "usage: cch-packed-runner <output> <state-root> <run-prefix>",
    );
  }

  const report = createCchRunnerReport(runPrefix);
  await persistCchRunnerReport(outputFile, report);
  let failed = false;

  try {
    const sdk = await runBoundedCchRunnerStage(
      {
        outputFile,
        report,
        phase: "runner:load-sdk",
        timeoutMs: INITIALIZE_STAGE_TIMEOUT_MS,
      },
      () => import("@truthixify/fiber-forge/sdk"),
    );
    const selected = sdk.preset("cch");
    if (!selected?.cch) {
      throw new Error("installed package does not expose the CCH preset");
    }
    await mkdir(stateRoot, { recursive: true });

    for (const [index, mode] of ["cold-start", "warm-start"].entries()) {
      const net = `${runPrefix}-${index + 1}`.slice(0, 30);
      const stateDir = join(stateRoot, mode);
      const forge = sdk.createFiberForge({ stateDir });
      const started = Date.now();
      const run = {
        mode,
        net,
        startupMs: null,
        totalMs: 0,
        proof: null,
        failure: null,
        cleanup: "pending",
      };
      report.runs.push(run);
      await persistCchRunnerReport(outputFile, report);
      let stageTimedOut = false;

      try {
        const provisionController = new AbortController();
        await runBoundedCchRunnerStage(
          {
            outputFile,
            report,
            phase: `${mode}:provision`,
            timeoutMs: PROVISION_STAGE_TIMEOUT_MS,
            onTimeout: (error) => provisionController.abort(error),
          },
          () =>
            forge.up(
              { ...selected, name: net },
              {
                timeoutMs: PROVISION_TIMEOUT_MS,
                signal: provisionController.signal,
              },
            ),
        );
        run.startupMs = Date.now() - started;
        await persistCchRunnerReport(outputFile, report);

        const proofController = new AbortController();
        run.proof = await runBoundedCchRunnerStage(
          {
            outputFile,
            report,
            phase: `${mode}:proof`,
            timeoutMs: sdk.DEFAULT_CCH_PROOF_TIMEOUT_MS + PROOF_STAGE_GRACE_MS,
            onTimeout: (error) => proofController.abort(error),
          },
          () =>
            forge.proveCchTransfers(net, {
              timeoutMs: sdk.DEFAULT_CCH_PROOF_TIMEOUT_MS,
              signal: proofController.signal,
            }),
        );
        await persistCchRunnerReport(outputFile, report);

        await runBoundedCchRunnerStage(
          {
            outputFile,
            report,
            phase: `${mode}:status`,
            timeoutMs: STATUS_STAGE_TIMEOUT_MS,
          },
          async () => {
            const status = await forge.cchStatus(net);
            if (status.state !== "ready") {
              throw new Error(
                "CCH topology did not return to ready after settlement",
              );
            }
          },
        );
      } catch (error) {
        failed = true;
        stageTimedOut = error?.code === "CCH_RUNNER_STAGE_TIMEOUT";
        run.failure = failureOf(error);
        await persistCchRunnerReport(outputFile, report);
      } finally {
        if (!stageTimedOut) {
          try {
            await runBoundedCchRunnerStage(
              {
                outputFile,
                report,
                phase: `${mode}:cleanup`,
                timeoutMs: CLEANUP_STAGE_TIMEOUT_MS,
              },
              async () => {
                if (await exists(join(stateDir, net))) {
                  await forge.down(net, { purge: true });
                }
              },
            );
            run.cleanup = "passed";
          } catch {
            failed = true;
            run.cleanup = "failed";
          }
        } else {
          run.cleanup = "failed";
        }
        run.totalMs = Date.now() - started;
        await persistCchRunnerReport(outputFile, report);
      }

      if (run.failure || run.cleanup !== "passed") break;
    }

    try {
      await runBoundedCchRunnerStage(
        {
          outputFile,
          report,
          phase: "runner:finalize",
          timeoutMs: FINALIZE_STAGE_TIMEOUT_MS,
        },
        () => rm(stateRoot, { recursive: true, force: true }),
      );
    } catch {
      failed = true;
    }
  } catch (error) {
    failed = true;
    report.failure = failureOf(error);
  }

  report.status = !failed && report.runs.length === 2 ? "passed" : "failed";
  report.completedAt = new Date().toISOString();
  report.activeStage = null;
  await persistCchRunnerReport(outputFile, report);
  return report.status === "passed" ? 0 : 1;
}

const isMain =
  process.argv[1] &&
  realpathSync(process.argv[1]) ===
    realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    process.exitCode = await runPackedCchEvidence();
  } catch (error) {
    console.error(
      `[cch-packed-runner] ${error instanceof Error ? error.message : "unexpected runner failure"}`,
    );
    process.exitCode = 1;
  }
}
