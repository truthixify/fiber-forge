import { appendFile, readFile, rm } from "node:fs/promises";

import { errorAnnotation, getSavedState, noticeAnnotation } from "./github.mjs";
import {
  assertManagedActionRoot,
  collectNetworkDiagnostics,
  errorSummary,
  forceRemoveExactResources,
  loadInstalledSdk,
  sanitizeText,
  verifyExactCleanup,
  writeDiagnostics,
  writeJson,
} from "./runtime.mjs";

async function readReport(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { schemaVersion: 1 };
  }
}

async function writeSummary(env, message) {
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `${message}\n`, "utf8");
  }
}

export async function runCleanup(env = process.env) {
  const actionRootValue = getSavedState("action_root", env);
  if (!actionRootValue) return;
  const actionRoot = assertManagedActionRoot(
    actionRootValue,
    env.RUNNER_TEMP ?? "",
  );
  const installRoot = getSavedState("install_root", env);
  const stateRoot = getSavedState("state_root", env);
  const reportPath = getSavedState("report_path", env);
  const diagnosticsPath = getSavedState("diagnostics_path", env);
  const diagnosticsMode = getSavedState("diagnostics_mode", env) || "failure";
  const packageVersion = getSavedState("package_version", env);
  const network = getSavedState("network", env);
  const privatePaths = [actionRoot, env.GITHUB_WORKSPACE, env.RUNNER_TEMP];
  const failures = [];
  const recovered = [];
  const diagnosticLines = [];

  if (network) {
    try {
      const sdk = await loadInstalledSdk(installRoot, packageVersion);
      await sdk
        .createFiberForge({ stateDir: stateRoot })
        .down(network, { purge: true });
    } catch (error) {
      recovered.push(errorSummary(error, undefined, privatePaths).message);
    }
    try {
      await verifyExactCleanup(network, stateRoot, env);
    } catch (error) {
      recovered.push(errorSummary(error, undefined, privatePaths).message);
      diagnosticLines.push(await collectNetworkDiagnostics(network, env));
      try {
        await forceRemoveExactResources(network, stateRoot, env);
        await verifyExactCleanup(network, stateRoot, env);
      } catch (fallbackError) {
        failures.push(
          errorSummary(fallbackError, undefined, privatePaths).message,
        );
      }
    }
  }

  const cleanupStatus = failures.length === 0 ? "success" : "failure";
  if (reportPath) {
    const report = await readReport(reportPath);
    report.cleanup = {
      status: cleanupStatus,
      completedAt: new Date().toISOString(),
      ...(failures.length > 0 ? { errors: failures } : {}),
      ...(recovered.length > 0 ? { recoveredErrors: recovered } : {}),
    };
    await writeJson(reportPath, report);
  }
  if (
    diagnosticsPath &&
    (diagnosticsMode === "always" ||
      failures.length > 0 ||
      recovered.length > 0)
  ) {
    const dockerDiagnostics = network
      ? await collectNetworkDiagnostics(network, env)
      : "No network name was saved; only action temporary files required cleanup.";
    await writeDiagnostics(
      diagnosticsPath,
      [...failures, ...recovered, ...diagnosticLines, dockerDiagnostics],
      privatePaths,
    );
  }

  await writeSummary(
    env,
    failures.length === 0
      ? `Fiber Forge cleanup verified${network ? ` for \`${network}\`` : ""}.`
      : `Fiber Forge cleanup failed${network ? ` for \`${network}\`` : ""}: ${failures.join("; ")}`,
  );
  await rm(actionRoot, { recursive: true, force: true });
  if (failures.length > 0) {
    throw new Error(`cleanup failed: ${failures.join("; ")}`);
  }
  noticeAnnotation(
    `Fiber Forge cleanup verified${network ? ` for ${network}` : ""}`,
  );
}

try {
  await runCleanup();
} catch (error) {
  errorAnnotation(
    sanitizeText(error instanceof Error ? error.message : String(error), [
      process.env.GITHUB_WORKSPACE,
      process.env.RUNNER_TEMP,
    ]),
  );
  process.exitCode = 1;
}
