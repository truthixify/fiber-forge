import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { buildActionOutputs, validateActionInputs } from "./contract.mjs";
import { getInput, saveState, setOutput } from "./github.mjs";
import {
  collectNetworkDiagnostics,
  errorDiagnostics,
  errorSummary,
  installExactPackage,
  loadInstalledSdk,
  resolveTopologyFile,
  writeDiagnostics,
  writeJson,
} from "./runtime.mjs";

function isoNow() {
  return new Date().toISOString();
}

function actionInputs(env) {
  return {
    packageVersion: getInput("package-version", env),
    topology: getInput("topology", env),
    ckbPort: getInput("ckb-port", env),
    rpcPortBase: getInput("rpc-port-base", env),
    startupTimeoutMs: getInput("startup-timeout-ms", env),
    udtPerNode: getInput("udt-per-node", env),
    diagnostics: getInput("diagnostics", env),
  };
}

async function resolveTopology(inputs, sdk, workspace) {
  if (inputs.topologyKind === "preset") {
    const topology = sdk.preset(inputs.topology);
    if (!topology)
      throw new Error(
        `installed SDK does not recognize preset ${inputs.topology}`,
      );
    return topology;
  }
  const path = await resolveTopologyFile(inputs.topology, workspace);
  return sdk.parseTopology(await readFile(path, "utf8"));
}

export async function runSetup(env = process.env) {
  if (process.platform !== "linux") {
    throw new Error(
      "Fiber Forge's GitHub Action currently supports Linux runners only",
    );
  }
  const workspace = env.GITHUB_WORKSPACE;
  const runnerTemp = env.RUNNER_TEMP;
  if (!workspace || !runnerTemp) {
    throw new Error("GITHUB_WORKSPACE and RUNNER_TEMP are required");
  }
  const inputs = validateActionInputs(actionInputs(env), workspace);
  const actionRoot = await mkdtemp(join(runnerTemp, "fiber-forge-action-"));
  const installRoot = join(actionRoot, "install");
  const stateRoot = join(actionRoot, "state");
  const reportPath = join(actionRoot, "report.json");
  const diagnosticsPath = join(actionRoot, "diagnostics.log");
  await mkdir(stateRoot, { recursive: true });

  for (const [name, value] of [
    ["action_root", actionRoot],
    ["install_root", installRoot],
    ["state_root", stateRoot],
    ["report_path", reportPath],
    ["diagnostics_path", diagnosticsPath],
    ["diagnostics_mode", inputs.diagnostics],
    ["package_version", inputs.packageVersion],
  ]) {
    await saveState(name, value, env);
  }

  const startedAt = isoNow();
  const started = Date.now();
  const progress = [];
  let sdk;
  let network;
  let target = {
    kind: inputs.topologyKind,
    value:
      inputs.topologyKind === "preset"
        ? inputs.topology
        : basename(inputs.topology),
  };

  try {
    console.log(
      `Installing ${inputs.packageVersion} with lifecycle scripts disabled`,
    );
    await installExactPackage({
      installRoot,
      packageVersion: inputs.packageVersion,
      candidateTarball: env.FIBER_FORGE_ACTION_PACKAGE_TARBALL,
      workspace,
      runnerTemp,
      env,
    });
    sdk = await loadInstalledSdk(installRoot, inputs.packageVersion);
    const topology = await resolveTopology(inputs, sdk, workspace);
    network = topology.name;
    await saveState("network", network, env);

    const client = sdk.createFiberForge({ stateDir: stateRoot });
    console.log(`Preparing isolated Fiber Forge network ${network}`);
    await client.down(network, { purge: true });

    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    let layout;
    try {
      layout = await client.up(topology, {
        layout: {
          ...(inputs.ckbPort ? { ckbHostPort: inputs.ckbPort } : {}),
          ...(inputs.rpcPortBase
            ? { rpcHostPortBase: inputs.rpcPortBase }
            : {}),
        },
        timeoutMs: inputs.startupTimeoutMs,
        signal: controller.signal,
        ...(inputs.udtPerNode ? { udtPerNode: inputs.udtPerNode } : {}),
        onProgress: (message) => {
          progress.push(String(message));
          if (progress.length > 80) progress.shift();
          console.log(String(message));
        },
      });
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }

    const view = await client.inspect(network);
    const viewByName = new Map(view.nodes.map((node) => [node.name, node]));
    const connection = {
      network,
      ckbRpc: `http://127.0.0.1:${layout.ckbHostPort}`,
      nodes: layout.nodes.map((node) => {
        const current = viewByName.get(node.name);
        if (!current?.pubkey || current.status !== "running") {
          throw new Error(
            `node ${node.name} is not running with a public key after setup`,
          );
        }
        return {
          name: node.name,
          pubkey: current.pubkey,
          rpc: `http://127.0.0.1:${node.rpcHostPort}`,
        };
      }),
    };
    const startupDurationMs = Date.now() - started;
    const outputs = buildActionOutputs(connection, {
      reportPath,
      startupDurationMs,
    });
    const report = {
      schemaVersion: 1,
      actionRevision: env.GITHUB_ACTION_REF || env.GITHUB_SHA || "local",
      package: {
        name: "@truthixify/fiber-forge",
        version: inputs.packageVersion,
      },
      target,
      network,
      result: "success",
      startedAt,
      completedAt: isoNow(),
      startupDurationMs,
      connection: JSON.parse(outputs["connection-json"]),
      cleanup: { status: "pending" },
    };
    await writeJson(reportPath, report);
    if (inputs.diagnostics === "always") {
      await writeDiagnostics(
        diagnosticsPath,
        ["Recent setup progress:", ...progress],
        [actionRoot, workspace, runnerTemp],
      );
    }
    for (const [name, value] of Object.entries(outputs)) {
      await setOutput(name, value, env);
    }
    console.log(
      `Fiber Forge network ${network} is ready on loopback endpoints`,
    );
    return outputs;
  } catch (error) {
    const failure = errorSummary(error, sdk, [
      actionRoot,
      workspace,
      runnerTemp,
    ]);
    await writeJson(reportPath, {
      schemaVersion: 1,
      actionRevision: env.GITHUB_ACTION_REF || env.GITHUB_SHA || "local",
      package: {
        name: "@truthixify/fiber-forge",
        version: inputs.packageVersion,
      },
      target,
      ...(network ? { network } : {}),
      result: "failure",
      startedAt,
      completedAt: isoNow(),
      startupDurationMs: Date.now() - started,
      error: failure,
      cleanup: { status: "pending" },
    });
    if (inputs.diagnostics !== "never") {
      const dockerDiagnostics = network
        ? await collectNetworkDiagnostics(network, env)
        : "Provisioning did not reach a named network.";
      await writeDiagnostics(
        diagnosticsPath,
        [
          errorDiagnostics(error, [actionRoot, workspace, runnerTemp]),
          "Recent setup progress:",
          ...progress,
          dockerDiagnostics,
        ],
        [actionRoot, workspace, runnerTemp],
      );
    }
    throw new Error(`${failure.code}: ${failure.message}`);
  }
}
