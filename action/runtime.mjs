import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const PACKAGE_NAME = "@truthixify/fiber-forge";

export class CommandError extends Error {
  constructor(command, result) {
    super(
      result.timedOut
        ? `${command} timed out after ${result.timeoutMs}ms`
        : `${command} exited with code ${String(result.code)}`,
    );
    this.name = "CommandError";
    this.result = result;
  }
}

function boundedTail(current, chunk, limit) {
  const combined = current + String(chunk);
  return combined.length <= limit ? combined : combined.slice(-limit);
}

export async function runCommand(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 300_000,
    captureBytes = MAX_DIAGNOSTIC_BYTES,
  } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = boundedTail(stdout, chunk, captureBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedTail(stderr, chunk, captureBytes);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      const result = {
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        timeoutMs,
      };
      if (timedOut) {
        reject(new CommandError(command, result));
        return;
      }
      resolvePromise(result);
    });
  });
}

export async function requireCommand(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new CommandError(command, result);
  }
  return result;
}

function pathIsInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) &&
      fromRoot !== ".." &&
      !isAbsolute(fromRoot))
  );
}

export async function resolveTopologyFile(candidate, workspace) {
  const [workspacePath, candidatePath] = await Promise.all([
    realpath(workspace),
    realpath(candidate),
  ]);
  if (!pathIsInside(workspacePath, candidatePath)) {
    throw new Error(
      "topology files must not escape GITHUB_WORKSPACE through a symlink",
    );
  }
  const info = await lstat(candidatePath);
  if (
    !info.isFile() ||
    ![".yml", ".yaml"].includes(extname(candidatePath).toLowerCase())
  ) {
    throw new Error(
      "topology must resolve to a YAML file inside GITHUB_WORKSPACE",
    );
  }
  return candidatePath;
}

async function resolveCandidateTarball(path, workspace, runnerTemp) {
  const candidate = await realpath(path);
  const roots = await Promise.all(
    [workspace, runnerTemp].filter(Boolean).map((root) => realpath(root)),
  );
  if (!roots.some((root) => pathIsInside(root, candidate))) {
    throw new Error(
      "candidate package tarball must be inside GITHUB_WORKSPACE or RUNNER_TEMP",
    );
  }
  const info = await lstat(candidate);
  if (!info.isFile() || extname(candidate).toLowerCase() !== ".tgz") {
    throw new Error("candidate package must be a .tgz file");
  }
  return candidate;
}

export async function installExactPackage({
  installRoot,
  packageVersion,
  candidateTarball,
  workspace,
  runnerTemp,
  env = process.env,
}) {
  await mkdir(installRoot, { recursive: true });
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify({ name: "fiber-forge-action-runtime", private: true })}\n`,
    "utf8",
  );
  const spec = candidateTarball
    ? await resolveCandidateTarball(candidateTarball, workspace, runnerTemp)
    : `${PACKAGE_NAME}@${packageVersion}`;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await requireCommand(
    npm,
    [
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--package-lock=false",
      "--loglevel=error",
      spec,
    ],
    {
      cwd: installRoot,
      env: { ...env, npm_config_update_notifier: "false" },
      timeoutMs: 300_000,
    },
  );
}

function declaredImportTarget(exportsValue) {
  if (typeof exportsValue === "string") return exportsValue;
  if (!exportsValue || typeof exportsValue !== "object") return undefined;
  if (typeof exportsValue.import === "string") return exportsValue.import;
  if (typeof exportsValue.default === "string") return exportsValue.default;
  return undefined;
}

export async function loadInstalledSdk(installRoot, expectedVersion) {
  const packageDir = await realpath(
    join(installRoot, "node_modules", "@truthixify", "fiber-forge"),
  );
  const metadata = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );
  if (metadata.name !== PACKAGE_NAME || metadata.version !== expectedVersion) {
    throw new Error(
      `installed package identity mismatch: expected ${PACKAGE_NAME}@${expectedVersion}`,
    );
  }
  const target = declaredImportTarget(metadata.exports?.["./sdk"]);
  if (!target?.startsWith("./")) {
    throw new Error(
      "installed package does not declare a public ./sdk import export",
    );
  }
  const sdkPath = await realpath(resolve(packageDir, target));
  if (!pathIsInside(packageDir, sdkPath)) {
    throw new Error(
      "installed package's ./sdk export resolves outside the package",
    );
  }
  const sdk = await import(
    `${pathToFileURL(sdkPath).href}?action=${Date.now()}`
  );
  for (const name of ["createFiberForge", "parseTopology", "preset"]) {
    if (typeof sdk[name] !== "function") {
      throw new Error(`installed ./sdk export is missing ${name}()`);
    }
  }
  if (sdk.version !== expectedVersion) {
    throw new Error(
      `SDK version mismatch: expected ${expectedVersion}, received ${String(sdk.version)}`,
    );
  }
  return sdk;
}

export function sanitizeText(value, privatePaths = []) {
  let text = String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /\b(authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[redacted-token]",
    )
    .replace(/\b0x[0-9a-f]{64}\b/gi, "[redacted-hex]");
  const paths = [...privatePaths, homedir()]
    .filter(Boolean)
    .map((path) => resolve(path))
    .sort((a, b) => b.length - a.length);
  for (const path of paths) {
    text = text.replaceAll(path, "[private-path]");
  }
  return text.slice(-MAX_DIAGNOSTIC_BYTES);
}

export function errorSummary(error, sdk, privatePaths = []) {
  let details;
  try {
    details = sdk?.errorDetails?.(error);
  } catch {
    details = undefined;
  }
  const source = details ?? {
    code: "ACTION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
  return {
    code: String(source.code ?? "ACTION_FAILED"),
    message: sanitizeText(source.message, privatePaths),
    ...(source.resource
      ? { resource: sanitizeText(source.resource, privatePaths) }
      : {}),
    ...(source.action
      ? { action: sanitizeText(source.action, privatePaths) }
      : {}),
  };
}

export function errorDiagnostics(error, privatePaths = []) {
  const lines = [error instanceof Error ? error.message : String(error)];
  if (error instanceof CommandError) {
    lines.push(error.result.stdout, error.result.stderr);
  }
  return sanitizeText(lines.filter(Boolean).join("\n"), privatePaths);
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeDiagnostics(path, lines, privatePaths = []) {
  const content = sanitizeText(lines.filter(Boolean).join("\n"), privatePaths);
  await writeFile(path, `${content.trimEnd()}\n`, "utf8");
}

async function dockerNames(kind, env, net) {
  let args;
  if (kind === "container") {
    args = [
      "ps",
      "-a",
      "--filter",
      `label=fiber-forge=${net}`,
      "--format",
      "{{.ID}} {{.Names}}",
    ];
  } else {
    const name = kind === "network" ? `forge-${net}` : `forge-${net}-ckb-data`;
    args = [kind, "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"];
  }
  const result = await requireCommand("docker", args, {
    env,
    timeoutMs: 30_000,
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function exactDockerResourceState(net, env = process.env) {
  const containers = (await dockerNames("container", env, net))
    .map((line) => line.split(/\s+/, 2)[1])
    .filter(Boolean);
  const networks = (await dockerNames("network", env, net)).filter(
    (name) => name === `forge-${net}`,
  );
  const volumes = (await dockerNames("volume", env, net)).filter(
    (name) => name === `forge-${net}-ckb-data`,
  );
  return { containers, networks, volumes };
}

export async function exactResourceState(net, stateRoot, env = process.env) {
  const docker = await exactDockerResourceState(net, env);
  let stateExists = true;
  try {
    await access(join(stateRoot, net));
  } catch (error) {
    if (error?.code === "ENOENT") stateExists = false;
    else throw error;
  }
  return { ...docker, stateExists };
}

export async function verifyExactCleanup(net, stateRoot, env = process.env) {
  const state = await exactResourceState(net, stateRoot, env);
  const remaining = [
    ...state.containers.map((name) => `container ${name}`),
    ...state.networks.map((name) => `network ${name}`),
    ...state.volumes.map((name) => `volume ${name}`),
    ...(state.stateExists ? [`state ${join(stateRoot, net)}`] : []),
  ];
  if (remaining.length > 0) {
    throw new Error(`cleanup left managed resources: ${remaining.join(", ")}`);
  }
}

export async function forceRemoveExactResources(
  net,
  stateRoot,
  env = process.env,
) {
  const failures = [];
  try {
    const state = await exactResourceState(net, stateRoot, env);
    if (state.containers.length > 0) {
      const result = await runCommand(
        "docker",
        ["rm", "-f", ...state.containers],
        {
          env,
          timeoutMs: 60_000,
        },
      );
      if (result.code !== 0)
        failures.push(`container removal: ${result.stderr.trim()}`);
    }
    if (state.networks.length > 0) {
      const result = await runCommand(
        "docker",
        ["network", "rm", `forge-${net}`],
        {
          env,
          timeoutMs: 30_000,
        },
      );
      if (result.code !== 0)
        failures.push(`network removal: ${result.stderr.trim()}`);
    }
    if (state.volumes.length > 0) {
      const result = await runCommand(
        "docker",
        ["volume", "rm", "-f", `forge-${net}-ckb-data`],
        {
          env,
          timeoutMs: 30_000,
        },
      );
      if (result.code !== 0)
        failures.push(`volume removal: ${result.stderr.trim()}`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  try {
    await rm(join(stateRoot, net), { recursive: true, force: true });
  } catch (error) {
    failures.push(
      `state removal: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`exact-resource fallback failed: ${failures.join("; ")}`);
  }
}

export async function collectNetworkDiagnostics(net, env = process.env) {
  const lines = [];
  try {
    const result = await requireCommand(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=fiber-forge=${net}`,
        "--format",
        "{{.Names}} {{.Status}}",
      ],
      { env, timeoutMs: 30_000 },
    );
    const containers = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    lines.push(...containers);
    for (const entry of containers.slice(0, 11)) {
      const name = entry.split(/\s+/, 1)[0];
      const logs = await runCommand("docker", ["logs", "--tail", "40", name], {
        env,
        timeoutMs: 30_000,
        captureBytes: 8 * 1024,
      });
      lines.push(`--- ${name} ---`, logs.stdout, logs.stderr);
    }
  } catch (error) {
    lines.push(
      `Docker diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return lines.join("\n").slice(-MAX_DIAGNOSTIC_BYTES);
}

export function assertManagedActionRoot(actionRoot, runnerTemp) {
  const root = resolve(runnerTemp);
  const candidate = resolve(actionRoot);
  if (
    !pathIsInside(root, candidate) ||
    candidate === root ||
    !candidate.split(sep).at(-1)?.startsWith("fiber-forge-action-")
  ) {
    throw new Error(
      "refusing to remove an action directory outside RUNNER_TEMP",
    );
  }
  return candidate;
}
