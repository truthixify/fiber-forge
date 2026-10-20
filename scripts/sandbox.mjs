import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const repoDir = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const runtimeDir = resolve(
  repoDir,
  process.env.FIBER_FORGE_SANDBOX_RUNTIME_DIR ?? ".sandbox",
);
const stateDir = join(runtimeDir, "state");
const statusFile = join(runtimeDir, "status.json");
const logFile = join(runtimeDir, "supervisor.log");
const topologyFile = join(repoDir, ".devcontainer", "sandbox.yml");
const sdkFile = join(repoDir, "dist", "sdk.js");
const daemonFile = join(repoDir, "dist", "daemon.js");

export const SANDBOX_NET = "sandbox";
export const SANDBOX_GUI_PORT = 5178;
export const SANDBOX_TTL_MS = 4 * 60 * 60 * 1000;

const START_TIMEOUT_MS = 12 * 60 * 1000;
const STOP_TIMEOUT_MS = 2 * 60 * 1000;
const POLL_MS = 500;

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function waitForStopOrExpiry(ms, stopRequested) {
  let timer;
  try {
    return await Promise.race([
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise("expired"), ms);
      }),
      stopRequested.then(() => "stopped"),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readStatus() {
  try {
    return JSON.parse(await readFile(statusFile, "utf8"));
  } catch {
    return null;
  }
}

async function writeStatus(status) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const temporary = `${statusFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(status, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, statusFile);
}

export function safeMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replaceAll(repoDir, "[workspace]")
    .replaceAll(runtimeDir, "[runtime]")
    .replace(
      /\b([A-Za-z0-9_]*(?:password|private[_ -]?key|secret|token)[A-Za-z0-9_]*)(\s*[:=]\s*)\S+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\b0x[0-9a-f]{64,}\b/gi, "[REDACTED HEX]")
    .slice(0, 2_000);
}

async function commandResult(command, args) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: repoDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    return {
      code: 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    return {
      code: typeof error?.code === "number" ? error.code : 1,
      stdout: String(error?.stdout ?? "").trim(),
      stderr: String(error?.stderr ?? error?.message ?? error).trim(),
    };
  }
}

async function identity() {
  const packageJson = JSON.parse(
    await readFile(join(repoDir, "package.json"), "utf8"),
  );
  const git = await commandResult("git", ["rev-parse", "--short=12", "HEAD"]);
  const dirty = await commandResult("git", [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  return {
    package: {
      name: packageJson.name,
      version: packageJson.version,
    },
    build: {
      commit:
        process.env.GITHUB_SHA?.slice(0, 12) ||
        (git.code === 0 && git.stdout ? git.stdout : "unknown"),
      dirty: dirty.code === 0 && dirty.stdout.length > 0,
    },
  };
}

async function isSupervisorProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const result = await commandResult("ps", [
    "-p",
    String(pid),
    "-o",
    "command=",
  ]);
  return (
    result.code === 0 &&
    result.stdout.includes(scriptPath) &&
    result.stdout.includes("supervise")
  );
}

async function closeServer(server) {
  if (!server) return;
  server.close();
  server.closeAllConnections?.();
  await delay(100);
}

async function assertResourcesAbsent() {
  const containers = await commandResult("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=fiber-forge=${SANDBOX_NET}`,
  ]);
  if (containers.code !== 0) {
    throw new Error(`could not verify Docker cleanup: ${containers.stderr}`);
  }
  const network = await commandResult("docker", [
    "network",
    "inspect",
    `forge-${SANDBOX_NET}`,
  ]);
  const volume = await commandResult("docker", [
    "volume",
    "inspect",
    `forge-${SANDBOX_NET}-ckb-data`,
  ]);
  const leftovers = [];
  if (containers.stdout) leftovers.push(`containers: ${containers.stdout}`);
  if (network.code === 0) leftovers.push(`network: forge-${SANDBOX_NET}`);
  if (volume.code === 0)
    leftovers.push(`volume: forge-${SANDBOX_NET}-ckb-data`);
  if (await pathExists(stateDir)) leftovers.push("persisted state");
  if (leftovers.length > 0) {
    throw new Error(`sandbox cleanup left ${leftovers.join(", ")}`);
  }
}

async function loadRuntime() {
  if (!(await pathExists(sdkFile)) || !(await pathExists(daemonFile))) {
    throw new Error('sandbox runtime is not built; run "npm run build" first');
  }
  const sdk = await import(pathToFileURL(sdkFile).href);
  const daemon = await import(pathToFileURL(daemonFile).href);
  return { ...sdk, ...daemon };
}

async function cleanup(forge, server) {
  const failures = [];
  try {
    await closeServer(server);
  } catch (error) {
    failures.push(`stop GUI: ${safeMessage(error)}`);
  }
  try {
    await forge.down(SANDBOX_NET, { purge: true });
  } catch (error) {
    failures.push(`remove network: ${safeMessage(error)}`);
  }
  try {
    await rm(stateDir, { recursive: true, force: true });
  } catch (error) {
    failures.push(`remove state: ${safeMessage(error)}`);
  }
  try {
    await assertResourcesAbsent();
  } catch (error) {
    failures.push(safeMessage(error));
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

function checkNet(net) {
  if (net !== SANDBOX_NET) {
    throw new Error(`the hosted sandbox only permits network "${SANDBOX_NET}"`);
  }
}

/** Restrict the GUI backend to the one fixed sandbox network. */
export function createSandboxBackend(forge) {
  return {
    inspect: (net) => {
      checkNet(net);
      return forge.inspect(net);
    },
    list: async () =>
      (await forge.list()).filter((network) => network.net === SANDBOX_NET),
    channels: (net, node) => {
      checkNet(net);
      return forge.channels(net, node);
    },
    pay: (net, from, to, amount, description, udt) => {
      checkNet(net);
      return forge.pay(net, from, to, amount, description, udt);
    },
    openChannelBetween: async (net) => {
      checkNet(net);
      throw new Error(
        "the hosted sandbox channel topology is fixed; run npm run sandbox:reset",
      );
    },
    issueUdt: async (net) => {
      checkNet(net);
      throw new Error(
        "the hosted sandbox does not permit additional asset issuance",
      );
    },
    closeChannel: (net, node, channelId) => {
      checkNet(net);
      return forge.closeChannel(net, node, channelId);
    },
    fund: async (net) => {
      checkNet(net);
      throw new Error("the hosted sandbox uses a fixed funding allocation");
    },
    createInvoice: (net, node, amount, description, udt) => {
      checkNet(net);
      return forge.createInvoice(net, node, amount, description, udt);
    },
    logs: (net, node) => {
      checkNet(net);
      return forge.logs(net, node);
    },
    down: (net) => {
      checkNet(net);
      return forge.down(net, { purge: true, keep: false });
    },
    up: async () => {
      throw new Error(
        "the hosted sandbox topology is fixed; run npm run sandbox:reset",
      );
    },
  };
}

export function formatStatus(status) {
  if (!status) return "Fiber Forge sandbox: not started";
  const lines = [
    `Fiber Forge sandbox: ${status.state}`,
    `Build: ${status.package.name}@${status.package.version} (${status.build.commit}${status.build.dirty ? "+dirty" : ""})`,
    `Run: ${status.runId}`,
  ];
  if (status.expiresAt) lines.push(`Expires: ${status.expiresAt}`);
  if (status.state === "ready") {
    lines.push(`GUI: http://127.0.0.1:${SANDBOX_GUI_PORT}`);
    lines.push(
      `Payment proof: alice -> carol, ${status.payment.amountCkb} CKB, ${status.payment.status} (${status.payment.paymentHash})`,
    );
  }
  if (status.error) lines.push(`Error: ${status.error}`);
  if (status.cleanup?.complete) {
    lines.push(`Cleanup: complete at ${status.cleanup.completedAt}`);
  }
  return lines.join("\n");
}

async function supervise() {
  const base = {
    schemaVersion: 1,
    ...(await identity()),
    runId: `${process.env.CODESPACE_NAME ?? "local"}-${randomUUID().slice(0, 8)}`,
    supervisorPid: process.pid,
    topology: {
      net: SANDBOX_NET,
      nodes: ["alice", "bob", "carol"],
    },
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SANDBOX_TTL_MS).toISOString(),
  };
  let forge;
  let server;
  let requestedStop = false;
  let notifyStop;
  const stopRequested = new Promise((resolvePromise) => {
    notifyStop = resolvePromise;
  });
  const abortController = new AbortController();
  const requestStop = () => {
    requestedStop = true;
    abortController.abort();
    notifyStop();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  await writeStatus({ ...base, state: "starting" });
  try {
    const { createFiberForge, parseTopology, serveGui } = await loadRuntime();
    forge = createFiberForge({ stateDir });
    await cleanup(forge);
    if (requestedStop) throw new Error("sandbox stopped during startup");

    const topology = parseTopology(await readFile(topologyFile, "utf8"));
    const layout = await forge.up(topology, {
      signal: abortController.signal,
      onProgress: (message) => console.log(`[sandbox] ${message}`),
    });
    if (requestedStop) throw new Error("sandbox stopped during startup");

    const payment = await forge.pay(
      SANDBOX_NET,
      "alice",
      "carol",
      1,
      "sandbox readiness proof",
    );
    if (payment.status !== "Success") {
      throw new Error(`readiness payment returned ${payment.status}`);
    }

    server = await serveGui(createSandboxBackend(forge), SANDBOX_GUI_PORT);
    await writeStatus({
      ...base,
      state: "ready",
      layout: { network: layout.network, nodeCount: layout.nodes.length },
      payment: {
        from: "alice",
        to: "carol",
        amountCkb: 1,
        status: payment.status,
        paymentHash: payment.paymentHash,
      },
    });

    const remaining = Math.max(0, Date.parse(base.expiresAt) - Date.now());
    const finalState = await waitForStopOrExpiry(remaining, stopRequested);
    await writeStatus({ ...base, state: "stopping" });
    await cleanup(forge, server);
    await writeStatus({
      ...base,
      state: finalState,
      cleanup: { complete: true, completedAt: new Date().toISOString() },
    });
  } catch (error) {
    let cleanupError;
    if (forge) {
      try {
        await cleanup(forge, server);
      } catch (cleanupFailure) {
        cleanupError = safeMessage(cleanupFailure);
      }
    }
    const stopped = requestedStop && cleanupError === undefined;
    await writeStatus({
      ...base,
      state: stopped ? "stopped" : "error",
      error: stopped ? undefined : safeMessage(error),
      cleanup: {
        complete: cleanupError === undefined,
        completedAt: new Date().toISOString(),
        error: cleanupError,
      },
    });
    if (!stopped) throw error;
  }
}

async function waitForReady(pid) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await readStatus();
    if (status?.supervisorPid === pid) {
      if (status.state === "ready") return status;
      if (["error", "expired", "stopped"].includes(status.state)) {
        throw new Error(status.error ?? `sandbox entered ${status.state}`);
      }
    }
    if (!(await isSupervisorProcess(pid))) {
      throw new Error(`sandbox supervisor exited; inspect ${logFile}`);
    }
    await delay(POLL_MS);
  }
  throw new Error(
    `sandbox did not become ready within 12 minutes; inspect ${logFile}`,
  );
}

async function start() {
  await access(sdkFile, constants.R_OK).catch(() => {
    throw new Error('sandbox runtime is not built; run "npm run build" first');
  });
  const current = await readStatus();
  if (await isSupervisorProcess(current?.supervisorPid)) {
    const status =
      current.state === "ready"
        ? current
        : await waitForReady(current.supervisorPid);
    console.log(formatStatus(status));
    return;
  }

  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await rm(statusFile, { force: true });
  const log = openSync(logFile, "w", 0o600);
  const child = spawn(process.execPath, [scriptPath, "supervise"], {
    cwd: repoDir,
    detached: true,
    env: process.env,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.unref();
  const status = await waitForReady(child.pid);
  console.log(formatStatus(status));
}

async function standaloneCleanup() {
  const { createFiberForge } = await loadRuntime();
  const forge = createFiberForge({ stateDir });
  await cleanup(forge);
}

async function stop({ quiet = false } = {}) {
  const current = await readStatus();
  const pid = current?.supervisorPid;
  if (await isSupervisorProcess(pid)) {
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline && (await isSupervisorProcess(pid))) {
      await delay(POLL_MS);
    }
    if (await isSupervisorProcess(pid)) {
      process.kill(pid, "SIGKILL");
      await standaloneCleanup();
    }
  } else {
    await standaloneCleanup();
  }

  const latest = await readStatus();
  if (!latest || !["stopped", "expired"].includes(latest.state)) {
    const base = latest ?? {
      schemaVersion: 1,
      ...(await identity()),
      runId: "none",
    };
    await writeStatus({
      ...base,
      state: "stopped",
      supervisorPid: undefined,
      cleanup: { complete: true, completedAt: new Date().toISOString() },
    });
  }
  if (!quiet) console.log(formatStatus(await readStatus()));
}

async function reset() {
  await stop({ quiet: true });
  await start();
}

async function main() {
  const command = process.argv[2] ?? "status";
  if (command === "start") return start();
  if (command === "stop") return stop();
  if (command === "reset") return reset();
  if (command === "status") {
    console.log(formatStatus(await readStatus()));
    return;
  }
  if (command === "supervise") return supervise();
  throw new Error(`unknown sandbox command "${command}"`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`sandbox: ${safeMessage(error)}`);
    process.exitCode = 1;
  });
}
