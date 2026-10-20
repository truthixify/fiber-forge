import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  arch,
  homedir,
  platform,
  release,
  tmpdir,
  type as osType,
} from "node:os";
import { basename, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const artifactDir = resolve(
  repoDir,
  process.env.FORGE_E2E_ARTIFACT_DIR ?? "artifacts/live-e2e",
);
const internalDir = join(artifactDir, ".internal");
const metadataFile = join(internalDir, "metadata.json");
const runFile = join(internalDir, "run.json");
const stateRootFile = join(internalDir, "state-root.txt");
const vitestResultFile = join(internalDir, "vitest.json");
const summaryJsonFile = join(artifactDir, "summary.json");
const summaryMarkdownFile = join(artifactDir, "summary.md");
const diagnosticsFile = join(artifactDir, "diagnostics.log");

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_FAILURE_BYTES = 2 * 1024;
const MAX_SUMMARY_BYTES = 128 * 1024;
const FORGE_LABEL = "fiber-forge";
const TEST_NETWORKS = [
  "e2e-multihop",
  "e2e-recovery",
  "e2e-replay",
  "e2e-rollback-node",
  "e2e-rollback-peer",
  "e2e-rollback-channel",
  "e2e-udt",
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) {
    return { text: value, truncated: false };
  }
  const marker = "\n...[truncated]...\n";
  const room = Math.max(0, maxBytes - Buffer.byteLength(marker));
  const headBytes = Math.ceil(room * 0.6);
  const tailBytes = room - headBytes;
  return {
    text:
      bytes.subarray(0, headBytes).toString("utf8") +
      marker +
      bytes.subarray(bytes.length - tailBytes).toString("utf8"),
    truncated: true,
  };
}

function truncateTailUtf8(value, maxBytes) {
  const bytes = Buffer.from(value);
  return bytes.length <= maxBytes
    ? value
    : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

/** Redact credential-shaped values and key material before text can enter a published artifact. */
export function sanitizeText(value, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_DIAGNOSTIC_BYTES;
  let text = String(value ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  let redactions = 0;
  const redact = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      redactions += 1;
      return typeof replacement === "function"
        ? replacement(...args)
        : replacement;
    });
  };

  redact(
    /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi,
    "[REDACTED PRIVATE KEY]",
  );
  redact(
    /\b(authorization)(\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, key, separator) => `${key}${separator}[REDACTED]`,
  );
  redact(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  redact(
    /\b([A-Za-z0-9_]*(?:password|passwd|private[_ -]?key|secret|token)[A-Za-z0-9_]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, key, separator) => `${key}${separator}[REDACTED]`,
  );
  redact(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}\b/g, "[REDACTED TOKEN]");
  redact(
    /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    (_match, protocol) => `${protocol}[REDACTED]@`,
  );
  redact(/\b0x[0-9a-f]{64,}\b/gi, "[REDACTED HEX]");
  redact(/\b[0-9a-f]{64,}\b/gi, "[REDACTED HEX]");
  redact(/\b[A-Za-z0-9+/]{48,}={0,2}\b/g, "[REDACTED BASE64]");

  for (const privatePath of options.privatePaths ?? []) {
    if (!privatePath) continue;
    redact(
      new RegExp(escapeRegex(resolve(privatePath)), "g"),
      "[REDACTED PATH]",
    );
  }

  const truncated = truncateUtf8(text, maxBytes);
  return {
    text: truncated.text,
    redactions,
    truncated: truncated.truncated,
  };
}

function appendTail(current, chunk, maxBytes = MAX_COMMAND_OUTPUT_BYTES) {
  return truncateTailUtf8(current + chunk, maxBytes);
}

function runCommand(command, args, options = {}) {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoDir,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once("error", (error) => {
      resolvePromise({
        command: [command, ...args].join(" "),
        code: 1,
        stdout,
        stderr: appendTail(stderr, String(error)),
        durationMs: Date.now() - started,
      });
    });
    child.once("close", (code, signal) => {
      resolvePromise({
        command: [command, ...args].join(" "),
        code: code ?? 1,
        signal: signal ?? undefined,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function commandValue(command, args) {
  const result = await runCommand(command, args);
  return result.code === 0 ? result.stdout.trim() : "unavailable";
}

async function imageInfo(reference) {
  const value = await commandValue("docker", [
    "image",
    "inspect",
    reference,
    "--format",
    "{{.Id}}|{{.Os}}|{{.Architecture}}",
  ]);
  if (value === "unavailable") {
    return {
      reference,
      id: "unavailable",
      os: "unknown",
      architecture: "unknown",
    };
  }
  const [id = "unknown", os = "unknown", architecture = "unknown"] =
    value.split("|");
  return { reference, id, os, architecture };
}

async function collectMetadata() {
  const packageJson = JSON.parse(
    await readFile(join(repoDir, "package.json"), "utf8"),
  );
  const images = packageJson.fiberForge.images;
  const commit =
    process.env.GITHUB_SHA ??
    (await commandValue("git", ["rev-parse", "HEAD"]));
  return {
    schemaVersion: 1,
    run: {
      id: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      event: process.env.GITHUB_EVENT_NAME ?? "local",
      ref: process.env.GITHUB_REF ?? null,
      commit,
      url:
        process.env.GITHUB_SERVER_URL &&
        process.env.GITHUB_REPOSITORY &&
        process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : null,
      startedAt: new Date().toISOString(),
    },
    package: {
      name: packageJson.name,
      version: packageJson.version,
    },
    host: {
      os: osType(),
      platform: platform(),
      release: release(),
      architecture: arch(),
      node: process.version,
      docker: await commandValue("docker", [
        "version",
        "--format",
        "{{.Server.Version}}",
      ]),
    },
    images: {
      ckb: await imageInfo(images.ckb),
      fiber: await imageInfo(images.fiber),
    },
  };
}

async function runPhase(name, command, args, env = process.env) {
  console.log(`[live-evidence] ${name} started`);
  const result = await runCommand(command, args, { env });
  const status = result.code === 0 ? "passed" : "failed";
  console.log(
    `[live-evidence] ${name} ${status} in ${(result.durationMs / 1000).toFixed(1)}s`,
  );
  return { name, status, ...result };
}

async function runLiveEvidence() {
  if (artifactDir === parse(artifactDir).root) {
    throw new Error("artifact directory cannot be a filesystem root");
  }
  await mkdir(artifactDir, { recursive: true });
  await rm(internalDir, { recursive: true, force: true });
  await mkdir(internalDir, { recursive: true });
  await Promise.all(
    [summaryJsonFile, summaryMarkdownFile, diagnosticsFile].map((path) =>
      rm(path, { force: true }),
    ),
  );

  const stateRoot = await mkdtemp(join(tmpdir(), "fiber-forge-live-"));
  await writeFile(stateRootFile, stateRoot + "\n");
  await writeFile(
    metadataFile,
    JSON.stringify(await collectMetadata(), null, 2),
  );

  const phases = [];
  phases.push(await runPhase("build", "npm", ["run", "build"]));
  if (phases.at(-1).status === "passed") {
    phases.push(
      await runPhase("packed-artifact", "npm", ["run", "test:package"]),
    );
  } else {
    phases.push({ name: "packed-artifact", status: "skipped", durationMs: 0 });
  }

  if (phases.every((phase) => phase.status === "passed")) {
    const vitestBin = join(repoDir, "node_modules", "vitest", "vitest.mjs");
    phases.push(
      await runPhase(
        "live-e2e",
        process.execPath,
        [
          vitestBin,
          "run",
          "test/e2e.test.ts",
          "--reporter=json",
          `--outputFile=${vitestResultFile}`,
        ],
        {
          ...process.env,
          FORGE_E2E: "1",
          FORGE_E2E_STATE_ROOT: stateRoot,
        },
      ),
    );
  } else {
    phases.push({ name: "live-e2e", status: "skipped", durationMs: 0 });
  }

  await writeFile(
    runFile,
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        phases,
      },
      null,
      2,
    ),
  );
  if (phases.some((phase) => phase.status === "failed")) {
    process.exitCode = 1;
  }
}

export function normalizeArchitecture(value) {
  const architecture = String(value ?? "").toLowerCase();
  if (["aarch64", "arm64"].includes(architecture)) return "arm64";
  if (["amd64", "x64", "x86_64"].includes(architecture)) return "amd64";
  return architecture;
}

export function manifestPlatforms(manifest) {
  return [
    ...new Set(
      (manifest?.manifests ?? [])
        .map((entry) => {
          const os = String(entry?.platform?.os ?? "").toLowerCase();
          const architecture = normalizeArchitecture(
            entry?.platform?.architecture,
          );
          const variant = String(entry?.platform?.variant ?? "").toLowerCase();
          if (
            !os ||
            os === "unknown" ||
            !architecture ||
            architecture === "unknown"
          ) {
            return null;
          }
          return `${os}/${architecture}${variant ? `/${variant}` : ""}`;
        })
        .filter(Boolean),
    ),
  ].sort();
}

export function assertImagePlatform(reference, platforms, os, architecture) {
  const target = `${String(os).toLowerCase()}/${normalizeArchitecture(architecture)}`;
  if (
    platforms.some(
      (candidate) => candidate === target || candidate.startsWith(`${target}/`),
    )
  ) {
    return;
  }
  throw new Error(
    `image ${reference} has no ${target} manifest (available: ${platforms.join(", ") || "none"})`,
  );
}

export function imageGroupReferences(packageJson, group) {
  const configured = packageJson.fiberForge?.[group];
  if (!configured || typeof configured !== "object") {
    throw new Error(`package.json does not define fiberForge.${group}`);
  }
  const references = Object.values(configured);
  if (
    references.length === 0 ||
    references.some(
      (reference) => typeof reference !== "string" || reference.length === 0,
    )
  ) {
    throw new Error(`package.json contains an invalid fiberForge.${group}`);
  }
  return references;
}

async function pullImageGroup(group) {
  const packageJson = JSON.parse(
    await readFile(join(repoDir, "package.json"), "utf8"),
  );
  const references = imageGroupReferences(packageJson, group);
  const dockerInfoResult = await runCommand("docker", [
    "info",
    "--format",
    "{{json .}}",
  ]);
  if (dockerInfoResult.code !== 0) {
    throw new Error(
      `could not inspect Docker daemon: ${dockerInfoResult.stderr || dockerInfoResult.stdout}`,
    );
  }

  let dockerInfo;
  try {
    dockerInfo = JSON.parse(dockerInfoResult.stdout);
  } catch (error) {
    throw new Error(`could not parse Docker daemon details: ${String(error)}`);
  }
  const daemonOs = String(dockerInfo.OSType ?? "").toLowerCase();
  const daemonArchitecture = normalizeArchitecture(dockerInfo.Architecture);
  if (!daemonOs || !daemonArchitecture) {
    throw new Error(
      "Docker daemon did not report its operating system and architecture",
    );
  }
  console.log(
    `[live-evidence] host ${platform()}/${normalizeArchitecture(arch())}; Docker ${dockerInfo.ServerVersion ?? "unknown"} ${daemonOs}/${daemonArchitecture}`,
  );

  for (const reference of references) {
    const manifestResult = await runCommand("docker", [
      "manifest",
      "inspect",
      reference,
    ]);
    if (manifestResult.code !== 0) {
      throw new Error(
        `could not inspect image manifest for ${reference}: ${manifestResult.stderr || manifestResult.stdout}`,
      );
    }
    let manifest;
    try {
      manifest = JSON.parse(manifestResult.stdout);
    } catch (error) {
      throw new Error(
        `could not parse image manifest for ${reference}: ${String(error)}`,
      );
    }
    const platforms = manifestPlatforms(manifest);
    console.log(
      `[live-evidence] ${reference} platforms: ${platforms.join(", ") || "none"}`,
    );
    assertImagePlatform(reference, platforms, daemonOs, daemonArchitecture);
  }

  for (const reference of references) {
    console.log(`[live-evidence] pulling ${reference}`);
    const result = await runCommand("docker", ["pull", reference]);
    if (result.code !== 0) {
      throw new Error(`could not pull ${reference}: ${result.stderr}`);
    }
  }
}

async function dockerResourceExists(kind, name) {
  const result = await runCommand("docker", [kind, "inspect", name]);
  if (result.code === 0) return true;
  if (/no such (?:network|volume|object)|not found/i.test(result.stderr)) {
    return false;
  }
  throw new Error(`${kind} inspect ${name}: ${result.stderr || result.stdout}`);
}

function safeStateRoot(path) {
  const absolute = resolve(path);
  const temp = resolve(tmpdir());
  const withinTemp = relative(temp, absolute);
  return (
    withinTemp !== "" &&
    !withinTemp.startsWith(`..${sep}`) &&
    withinTemp !== ".." &&
    basename(absolute).startsWith("fiber-forge-live-")
  );
}

async function cleanupLiveResources() {
  const started = Date.now();
  const failures = [];
  const resourcesChecked = [];
  let stateRoot;
  try {
    stateRoot = (await readFile(stateRootFile, "utf8")).trim();
  } catch {
    stateRoot = undefined;
  }

  const dockerAvailable = await runCommand("docker", ["version"]);
  if (dockerAvailable.code !== 0) {
    failures.push(
      `Docker unavailable during cleanup: ${dockerAvailable.stderr}`,
    );
  } else {
    for (const net of TEST_NETWORKS) {
      const containerQuery = await runCommand("docker", [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=${FORGE_LABEL}=${net}`,
      ]);
      if (containerQuery.code !== 0) {
        failures.push(`list containers for ${net}: ${containerQuery.stderr}`);
      } else {
        const ids = containerQuery.stdout.trim().split(/\s+/).filter(Boolean);
        if (ids.length > 0) {
          const removed = await runCommand("docker", ["rm", "--force", ...ids]);
          if (removed.code !== 0) {
            failures.push(`remove containers for ${net}: ${removed.stderr}`);
          }
        }
      }

      const network = `forge-${net}`;
      try {
        if (await dockerResourceExists("network", network)) {
          const removed = await runCommand("docker", [
            "network",
            "rm",
            network,
          ]);
          if (removed.code !== 0) {
            failures.push(`remove network ${network}: ${removed.stderr}`);
          }
        }
      } catch (error) {
        failures.push(String(error));
      }

      const volume = `forge-${net}-ckb-data`;
      try {
        if (await dockerResourceExists("volume", volume)) {
          const removed = await runCommand("docker", [
            "volume",
            "rm",
            "--force",
            volume,
          ]);
          if (removed.code !== 0) {
            failures.push(`remove volume ${volume}: ${removed.stderr}`);
          }
        }
      } catch (error) {
        failures.push(String(error));
      }
      resourcesChecked.push(net);
    }
  }

  if (stateRoot) {
    if (!safeStateRoot(stateRoot)) {
      failures.push(`refused unsafe state root: ${stateRoot}`);
    } else {
      try {
        await rm(stateRoot, { recursive: true, force: true });
      } catch (error) {
        failures.push(`remove state root: ${String(error)}`);
      }
    }
  }

  if (dockerAvailable.code === 0) {
    for (const net of TEST_NETWORKS) {
      const remaining = await runCommand("docker", [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=${FORGE_LABEL}=${net}`,
      ]);
      if (remaining.code !== 0 || remaining.stdout.trim()) {
        failures.push(`containers remain for ${net}`);
      }
      for (const [kind, name] of [
        ["network", `forge-${net}`],
        ["volume", `forge-${net}-ckb-data`],
      ]) {
        try {
          if (await dockerResourceExists(kind, name)) {
            failures.push(`${kind} remains: ${name}`);
          }
        } catch (error) {
          failures.push(String(error));
        }
      }
    }
  }

  if (stateRoot && safeStateRoot(stateRoot)) {
    try {
      await stat(stateRoot);
      failures.push(`state root remains: ${stateRoot}`);
    } catch (error) {
      if (error?.code !== "ENOENT") failures.push(String(error));
    }
  }

  return {
    result: failures.length === 0 ? "passed" : "failed",
    durationMs: Date.now() - started,
    resourcesChecked,
    failures,
  };
}

function testDescriptor(name) {
  if (name.includes("trio multi-hop")) {
    return {
      topology: "trio (3-node line)",
      paths: ["provisioning", "multi-hop-ckb"],
    };
  }
  if (name.includes("relay node recovery")) {
    return {
      topology: "trio (3-node line)",
      paths: ["recovery", "replay", "force-close"],
    };
  }
  if (name.includes("partial provisioning rollback")) {
    return { topology: "duo (2-node line)", paths: ["rollback"] };
  }
  if (name.includes("UDT asset")) {
    return { topology: "duo (2 nodes)", paths: ["udt"] };
  }
  return { topology: "unknown", paths: [] };
}

function pathResult(tests, path) {
  const selected = tests.filter((test) => test.paths.includes(path));
  if (selected.length === 0) return { result: "not-run", durationMs: 0 };
  return {
    result: selected.every((test) => test.result === "passed")
      ? "passed"
      : "failed",
    durationMs: Math.round(
      selected.reduce((total, test) => total + test.durationMs, 0),
    ),
  };
}

function normalizedTests(vitest, privatePaths) {
  return (vitest?.testResults ?? []).flatMap((suite) =>
    (suite.assertionResults ?? []).map((assertion) => {
      const descriptor = testDescriptor(
        assertion.fullName ?? assertion.title ?? "unknown test",
      );
      const sanitizedFailures = (assertion.failureMessages ?? []).map(
        (failure) =>
          sanitizeText(failure, {
            maxBytes: MAX_FAILURE_BYTES,
            privatePaths,
          }),
      );
      const failures = sanitizedFailures.map((failure) => failure.text);
      const redactions = sanitizedFailures.reduce(
        (total, failure) => total + failure.redactions,
        0,
      );
      return {
        name: assertion.fullName ?? assertion.title ?? "unknown test",
        topology: descriptor.topology,
        result: assertion.status ?? "unknown",
        durationMs: Math.round(assertion.duration ?? 0),
        paths: descriptor.paths,
        ...(failures.length > 0 ? { failureReason: failures.join("\n") } : {}),
        ...(failures.length > 0 ? { diagnostics: ["diagnostics.log"] } : {}),
        ...(redactions > 0 ? { redactions } : {}),
      };
    }),
  );
}

/** Build the public summary and diagnostic text from raw runner data. */
export function buildEvidence({
  metadata,
  run,
  vitest,
  cleanup,
  privatePaths = [],
}) {
  const tests = normalizedTests(vitest, privatePaths);
  const packagePhase = run?.phases?.find(
    (phase) => phase.name === "packed-artifact",
  );
  const pathNames = [
    ["packed-artifact", "Packed artifact install + CLI/SDK smoke"],
    ["provisioning", "Real CKB/Fiber provisioning"],
    ["multi-hop-ckb", "Three-node multi-hop CKB payment"],
    ["recovery", "Stopped relay recovery + payment"],
    ["replay", "Secret-safe outage export + fresh replay"],
    ["force-close", "Failed-peer recovery + terminal force-close settlement"],
    ["rollback", "Node/peer/channel rollback"],
    ["udt", "UDT issue/channel/payment regression"],
  ];
  const paths = pathNames.map(([id, name]) => {
    if (id === "packed-artifact") {
      return {
        id,
        name,
        result: packagePhase?.status ?? "not-run",
        durationMs: Math.round(packagePhase?.durationMs ?? 0),
      };
    }
    return { id, name, ...pathResult(tests, id) };
  });
  paths.push({
    id: "cleanup",
    name: "Emergency cleanup + absence verification",
    result: cleanup.result,
    durationMs: cleanup.durationMs,
  });

  const phaseFailures = (run?.phases ?? []).filter(
    (phase) => phase.status === "failed",
  );
  const testFailures = tests.filter((test) => test.result === "failed");
  const jobFailed = ["failure", "cancelled"].includes(
    process.env.FORGE_E2E_JOB_STATUS ?? "",
  );
  const requiredTestsPassed =
    tests.length === 6 && tests.every((test) => test.result === "passed");
  const requiredPathsPassed = paths.every((path) => path.result === "passed");
  const result =
    run &&
    phaseFailures.length === 0 &&
    requiredTestsPassed &&
    requiredPathsPassed &&
    cleanup.result === "passed" &&
    !jobFailed
      ? "passed"
      : "failed";

  const diagnosticParts = [];
  for (const phase of phaseFailures) {
    diagnosticParts.push(
      `## Phase: ${phase.name}\n${phase.stderr || phase.stdout || "no output captured"}`,
    );
  }
  for (const test of testFailures) {
    diagnosticParts.push(
      `## Test: ${test.name}\nTopology: ${test.topology}\n${test.failureReason ?? "failed without a message"}`,
    );
  }
  if (cleanup.failures.length > 0) {
    diagnosticParts.push(`## Cleanup\n${cleanup.failures.join("\n")}`);
  }
  if (!run) {
    diagnosticParts.push(
      "## Runner\nThe live runner did not produce a completion record.",
    );
  }

  const sanitizedDiagnostics = sanitizeText(
    diagnosticParts.join("\n\n") || "No failure diagnostics were produced.\n",
    { maxBytes: MAX_DIAGNOSTIC_BYTES, privatePaths },
  );
  const extractedRedactions = tests.reduce(
    (total, test) => total + (test.redactions ?? 0),
    0,
  );
  const generatedAt = new Date().toISOString();
  const summary = {
    schemaVersion: 1,
    result,
    generatedAt,
    run: { ...metadata.run, completedAt: run?.completedAt ?? generatedAt },
    package: metadata.package,
    images: metadata.images,
    host: metadata.host,
    paths,
    tests,
    cleanup: {
      result: cleanup.result,
      durationMs: cleanup.durationMs,
      resourcesChecked: cleanup.resourcesChecked,
      failureCount: cleanup.failures.length,
    },
    diagnostics: {
      file: "diagnostics.log",
      bytes: Buffer.byteLength(sanitizedDiagnostics.text),
      redactions: extractedRedactions + sanitizedDiagnostics.redactions,
      truncated: sanitizedDiagnostics.truncated,
      limitBytes: MAX_DIAGNOSTIC_BYTES,
    },
  };
  return { summary, diagnostics: sanitizedDiagnostics.text };
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function renderMarkdown(summary) {
  const commit = summary.run.commit?.slice(0, 12) ?? "unknown";
  const lines = [
    "# Live E2E Evidence",
    "",
    `**Result:** ${summary.result.toUpperCase()}  `,
    `**Commit:** \`${commit}\`  `,
    `**Package:** \`${summary.package.name}@${summary.package.version}\`  `,
    `**Host:** ${summary.host.os} ${summary.host.release} (${summary.host.architecture}), Node ${summary.host.node}, Docker ${summary.host.docker}`,
    "",
    `- CKB image: \`${summary.images.ckb.reference}\` (${summary.images.ckb.architecture})`,
    `- Fiber image: \`${summary.images.fiber.reference}\` (${summary.images.fiber.architecture})`,
    `- Cleanup: **${summary.cleanup.result}** (${summary.cleanup.durationMs} ms; ${summary.cleanup.failureCount} failures)`,
    `- Diagnostics: \`${summary.diagnostics.file}\` (${summary.diagnostics.bytes}/${summary.diagnostics.limitBytes} bytes, ${summary.diagnostics.redactions} redactions)`,
    "",
    "## Exercised Paths",
    "",
    "| Path | Result | Duration |",
    "| --- | --- | ---: |",
    ...summary.paths.map(
      (path) =>
        `| ${markdownCell(path.name)} | ${markdownCell(path.result)} | ${(path.durationMs / 1000).toFixed(1)}s |`,
    ),
    "",
    "## Tests",
    "",
    "| Test | Topology | Result | Duration |",
    "| --- | --- | --- | ---: |",
    ...summary.tests.map(
      (test) =>
        `| ${markdownCell(test.name)} | ${markdownCell(test.topology)} | ${markdownCell(test.result)} | ${(test.durationMs / 1000).toFixed(1)}s |`,
    ),
    "",
  ];
  if (summary.run.url) {
    lines.splice(7, 0, `- Workflow run: ${summary.run.url}`);
  }
  return lines.join("\n");
}

async function fallbackMetadata() {
  try {
    return await collectMetadata();
  } catch {
    // Keep finalization independent from package metadata or Docker inspection failures.
  }
  const packageJson = await readJson(join(repoDir, "package.json"), {
    name: "@truthixify/fiber-forge",
    version: "unknown",
  });
  const images = packageJson.fiberForge?.images ?? {
    ckb: "unknown",
    fiber: "unknown",
  };
  return {
    run: {
      id: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      event: process.env.GITHUB_EVENT_NAME ?? "unknown",
      ref: process.env.GITHUB_REF ?? null,
      commit: process.env.GITHUB_SHA ?? "unknown",
      url: null,
      startedAt: null,
    },
    package: { name: packageJson.name, version: packageJson.version },
    host: {
      os: osType(),
      platform: platform(),
      release: release(),
      architecture: arch(),
      node: process.version,
      docker: "unavailable",
    },
    images: {
      ckb: {
        reference: images.ckb,
        id: "unavailable",
        architecture: "unknown",
      },
      fiber: {
        reference: images.fiber,
        id: "unavailable",
        architecture: "unknown",
      },
    },
  };
}

async function finalizeLiveEvidence() {
  await mkdir(artifactDir, { recursive: true });
  const [metadata, run, vitest] = await Promise.all([
    readJson(metadataFile, null),
    readJson(runFile, null),
    readJson(vitestResultFile, null),
  ]);
  let stateRoot;
  try {
    stateRoot = (await readFile(stateRootFile, "utf8")).trim();
  } catch {
    stateRoot = undefined;
  }
  const cleanup = await cleanupLiveResources();
  const evidence = buildEvidence({
    metadata: metadata ?? (await fallbackMetadata()),
    run,
    vitest,
    cleanup,
    privatePaths: [homedir(), stateRoot].filter(Boolean),
  });
  const summaryJson = JSON.stringify(evidence.summary, null, 2) + "\n";
  if (Buffer.byteLength(summaryJson) > MAX_SUMMARY_BYTES) {
    throw new Error(`summary exceeds ${MAX_SUMMARY_BYTES} bytes`);
  }
  const markdown = renderMarkdown(evidence.summary) + "\n";
  await Promise.all([
    writeFile(summaryJsonFile, summaryJson),
    writeFile(summaryMarkdownFile, markdown),
    writeFile(diagnosticsFile, evidence.diagnostics),
  ]);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  await rm(internalDir, { recursive: true, force: true });
  console.log(
    `[live-evidence] ${evidence.summary.result}; cleanup ${cleanup.result}; summary ${summaryJsonFile}`,
  );
  if (cleanup.result !== "passed") {
    process.exitCode = 1;
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === "pull-images") {
    await pullImageGroup("images");
    return;
  }
  if (mode === "pull-cch-images") {
    await pullImageGroup("cchImages");
    return;
  }
  if (mode === "all") {
    let runExitCode = 0;
    try {
      await pullImageGroup("images");
      await runLiveEvidence();
      runExitCode = process.exitCode ?? 0;
    } catch (error) {
      runExitCode = 1;
      const failure = sanitizeText(
        error instanceof Error ? error.stack : error,
        {
          maxBytes: MAX_FAILURE_BYTES,
          privatePaths: [homedir()],
        },
      );
      console.error(`[live-evidence] runner failed: ${failure.text}`);
    }
    process.exitCode = 0;
    try {
      await finalizeLiveEvidence();
    } catch (error) {
      process.exitCode = 1;
      const failure = sanitizeText(
        error instanceof Error ? error.stack : error,
        {
          maxBytes: MAX_FAILURE_BYTES,
          privatePaths: [homedir()],
        },
      );
      console.error(`[live-evidence] finalizer failed: ${failure.text}`);
    }
    if (runExitCode !== 0 || process.exitCode) {
      process.exitCode = 1;
    }
    return;
  }
  if (mode === "run") {
    await runLiveEvidence();
    return;
  }
  if (mode === "finalize") {
    await finalizeLiveEvidence();
    return;
  }
  throw new Error(
    "usage: node scripts/live-evidence.mjs <pull-images|pull-cch-images|all|run|finalize>",
  );
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await main();
  } catch (error) {
    const failure = sanitizeText(error instanceof Error ? error.stack : error, {
      maxBytes: MAX_FAILURE_BYTES,
      privatePaths: [homedir()],
    });
    console.error(`[live-evidence] ${failure.text}`);
    process.exitCode = 1;
  }
}
