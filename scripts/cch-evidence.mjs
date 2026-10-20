import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, homedir, platform, release, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeText } from "./live-evidence.mjs";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const artifactDir = resolve(
  repoDir,
  process.env.FORGE_CCH_E2E_ARTIFACT_DIR ?? "artifacts/cch-e2e",
);
const summaryFile = join(artifactDir, "summary.json");
const markdownFile = join(artifactDir, "summary.md");
const diagnosticsFile = join(artifactDir, "diagnostics.log");
const MAX_DIAGNOSTICS_BYTES = 64 * 1024;
const MAX_SUMMARY_BYTES = 256 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
const PACKED_RUNNER_TIMEOUT_MS = 27 * 60_000;
const VOLUME_SUFFIXES = [
  "ckb-data",
  "bitcoin-data",
  "lnd-hub-data",
  "lnd-user-data",
  "cch-auth",
  "cch-data",
];

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoDir,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer;
    const retain = (current, chunk) =>
      (current + chunk).slice(-MAX_DIAGNOSTICS_BYTES);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      resolvePromise({
        code: timedOut ? 1 : (code ?? 1),
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout = retain(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = retain(stderr, chunk)));
    child.once("error", (error) => {
      stderr = retain(stderr, String(error));
      finish(1);
    });
    child.once("close", finish);
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      stderr = retain(
        stderr,
        `\ncommand exceeded ${options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS} ms`,
      );
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKillTimer.unref();
    }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    timeoutTimer.unref();
  });
}

function requireSuccess(label, result) {
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code}`);
  }
}

async function commandValue(command, args) {
  const result = await run(command, args);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function inspectResidue(net, stateRoot) {
  const containers =
    (await commandValue("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=fiber-forge=${net}`,
    ])) ?? "";
  const network = await run("docker", ["network", "inspect", `forge-${net}`]);
  const volumes = [];
  for (const suffix of VOLUME_SUFFIXES) {
    const name = `forge-${net}-${suffix}`;
    if ((await run("docker", ["volume", "inspect", name])).code === 0) {
      volumes.push(name);
    }
  }
  const statePath = join(stateRoot, "cold-start", net);
  const warmStatePath = join(stateRoot, "warm-start", net);
  const statePresent = await Promise.all(
    [statePath, warmStatePath].map(async (path) => {
      try {
        await stat(path);
        return path;
      } catch {
        return null;
      }
    }),
  );
  return {
    containers: containers ? containers.split("\n").filter(Boolean) : [],
    networkPresent: network.code === 0,
    volumes,
    statePaths: statePresent.filter(Boolean),
  };
}

function residueEmpty(residue) {
  return (
    residue.containers.length === 0 &&
    !residue.networkPresent &&
    residue.volumes.length === 0 &&
    residue.statePaths.length === 0
  );
}

async function recoverResidue(net, stateRoot) {
  const ids =
    (await commandValue("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=fiber-forge=${net}`,
    ])) ?? "";
  if (ids)
    await run("docker", ["rm", "-f", ...ids.split("\n").filter(Boolean)]);
  for (const suffix of VOLUME_SUFFIXES) {
    await run("docker", ["volume", "rm", "-f", `forge-${net}-${suffix}`]);
  }
  await run("docker", ["network", "rm", `forge-${net}`]);
  await Promise.all([
    rm(join(stateRoot, "cold-start", net), { recursive: true, force: true }),
    rm(join(stateRoot, "warm-start", net), { recursive: true, force: true }),
  ]);
}

function assertProofShape(proof) {
  const [send, receive] = proof?.flows ?? [];
  if (
    proof?.schemaVersion !== 1 ||
    proof?.kind !== "cch-transfer-proof" ||
    proof?.result !== "passed" ||
    proof?.flows?.length !== 2 ||
    send?.direction !== "fiber-to-lightning" ||
    receive?.direction !== "lightning-to-fiber" ||
    proof.flows.some((flow) => !validFlowShape(flow)) ||
    proof.boundaryChecks?.ckbDevChain !== "passed" ||
    proof.boundaryChecks?.bitcoinRegtest !== "passed" ||
    proof.boundaryChecks?.fiber !== "passed" ||
    proof.boundaryChecks?.cch !== "passed" ||
    proof.boundaryChecks?.lightning !== "passed" ||
    proof.chains?.ckb?.network !== "devnet" ||
    !Number.isSafeInteger(proof.chains?.ckb?.blockHeight) ||
    proof.chains.ckb.blockHeight <= 0 ||
    proof.chains?.bitcoin?.network !== "regtest" ||
    !Number.isSafeInteger(proof.chains?.bitcoin?.blockHeight) ||
    proof.chains.bitcoin.blockHeight < 113 ||
    proof.trust?.scope !== "local-development-only" ||
    proof.trust?.rate !== "1 wrapped base unit = 1 regtest satoshi" ||
    proof.trust?.operatorTrusted !== true ||
    proof.trust?.reserveProof !== false ||
    proof.trust?.mainnetFunds !== false ||
    send.fiber.user.after !== receive.fiber.user.before ||
    send.fiber.hub.after !== receive.fiber.hub.before ||
    send.lightning.user.after !== receive.lightning.user.before ||
    send.lightning.hub.after !== receive.lightning.hub.before
  ) {
    throw new Error("packed artifact returned an incomplete CCH proof report");
  }
  const serialized = JSON.stringify(proof).toLowerCase();
  for (const forbidden of [
    "invoice_address",
    "incoming_invoice",
    "outgoing_pay_req",
    "payment_preimage",
    "macaroon",
    "tls.cert",
    "private key",
    "lnbcrt",
    "-----begin",
  ]) {
    if (serialized.includes(forbidden)) {
      throw new Error(`CCH proof report contains forbidden field ${forbidden}`);
    }
  }
}

function validFlowShape(flow) {
  if (
    !/^0x[0-9a-f]{64}$/.test(flow?.paymentHash ?? "") ||
    flow?.terminalOrderStatus !== "Success" ||
    !Number.isSafeInteger(flow?.durationMs) ||
    flow.durationMs < 0 ||
    !Array.isArray(flow?.orderTransitions) ||
    flow.orderTransitions.length === 0 ||
    flow.orderTransitions.length > 32 ||
    flow.orderTransitions.at(-1)?.status !== "Success" ||
    flow.orderTransitions.some(
      (transition) =>
        typeof transition?.status !== "string" ||
        !Number.isSafeInteger(transition?.elapsedMs) ||
        transition.elapsedMs < 0,
    ) ||
    flow.fiber?.asset !== "simple_udt" ||
    flow.fiber?.unit !== "base_units" ||
    flow.lightning?.asset !== "regtest_btc" ||
    flow.lightning?.unit !== "satoshis" ||
    !validBalanceChange(flow.fiber.user) ||
    !validBalanceChange(flow.fiber.hub) ||
    !validBalanceChange(flow.lightning.user) ||
    !validBalanceChange(flow.lightning.hub)
  ) {
    return false;
  }
  const values = [
    flow.deliveredAmountSats,
    flow.incomingAmountSats,
    flow.cchFeeSats,
    flow.routingFeeSats,
  ];
  if (values.some((value) => !isUnsignedDecimal(value))) return false;
  const [delivered, incoming, cchFee, routingFee] = values.map(BigInt);
  if (delivered <= 0n || incoming !== delivered + cchFee) return false;

  const fiberUserDelta = BigInt(flow.fiber.user.delta);
  const fiberHubDelta = BigInt(flow.fiber.hub.delta);
  const lightningUserDelta = BigInt(flow.lightning.user.delta);
  const lightningHubDelta = BigInt(flow.lightning.hub.delta);
  if (flow.direction === "fiber-to-lightning") {
    return (
      flow.fiber.paymentStatus === "Success" &&
      flow.lightning.invoiceState === "SETTLED" &&
      flow.lightning.paymentStatus === null &&
      routingFee === 0n &&
      fiberUserDelta === -incoming &&
      fiberHubDelta === incoming &&
      lightningUserDelta === delivered &&
      lightningHubDelta === -delivered
    );
  }
  if (flow.direction === "lightning-to-fiber") {
    return (
      flow.fiber.paymentStatus === null &&
      flow.lightning.invoiceState === null &&
      flow.lightning.paymentStatus === "SUCCEEDED" &&
      fiberUserDelta === delivered &&
      fiberHubDelta === -delivered &&
      lightningUserDelta === -(incoming + routingFee) &&
      lightningHubDelta === incoming
    );
  }
  return false;
}

function validBalanceChange(change) {
  if (
    !isUnsignedDecimal(change?.before) ||
    !isUnsignedDecimal(change?.after) ||
    typeof change?.delta !== "string" ||
    !/^-?(?:0|[1-9]\d*)$/.test(change.delta) ||
    change.delta.length > 40
  ) {
    return false;
  }
  return BigInt(change.after) - BigInt(change.before) === BigInt(change.delta);
}

function isUnsignedDecimal(value) {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9]\d*)$/.test(value) &&
    value.length <= 40
  );
}

function normalizeFailure(failure) {
  if (!failure || typeof failure !== "object") return null;
  const clean = (value, maxBytes = 512) =>
    value === null || value === undefined
      ? null
      : sanitizeText(String(value), {
          maxBytes,
          privatePaths: [homedir()],
        }).text;
  return {
    code:
      typeof failure.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)
        ? failure.code
        : "UNEXPECTED",
    message: clean(failure.message),
    detail: clean(failure.detail),
    resource: clean(failure.resource, 160),
    action: clean(failure.action, 512),
  };
}

export function buildCchEvidence(input) {
  const rawRuns = Array.isArray(input.runner?.runs) ? input.runner.runs : [];
  const runs = rawRuns.map((run) => {
    let proof = run?.proof ?? null;
    let failure = normalizeFailure(run?.failure);
    if (proof) {
      try {
        assertProofShape(proof);
      } catch {
        proof = null;
        failure = {
          code: "INVALID_PROOF_REPORT",
          message: "packed artifact returned an invalid proof report",
        };
      }
    }
    return {
      mode:
        run?.mode === "cold-start" || run?.mode === "warm-start"
          ? run.mode
          : "invalid-mode",
      net:
        typeof run?.net === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(run.net)
          ? run.net
          : "invalid-network",
      startupMs:
        Number.isSafeInteger(run?.startupMs) && run.startupMs >= 0
          ? run.startupMs
          : null,
      totalMs:
        Number.isSafeInteger(run?.totalMs) && run.totalMs >= 0
          ? run.totalMs
          : null,
      proof,
      failure,
      cleanup: run?.cleanup === "passed" ? "passed" : "failed",
    };
  });
  const passed =
    input.runner?.schemaVersion === 1 &&
    input.runner?.source === "installed-packed-artifact" &&
    runs.length === 2 &&
    runs[0]?.mode === "cold-start" &&
    runs[1]?.mode === "warm-start" &&
    runs[0]?.net !== runs[1]?.net &&
    runs.every(
      (run) =>
        run.startupMs !== null &&
        run.proof?.net === run.net &&
        run.proof?.result === "passed" &&
        !run.failure &&
        run.cleanup === "passed" &&
        input.cleanup?.[run.net]?.result === "passed",
    );
  return {
    schemaVersion: 1,
    kind: "cch-live-evidence",
    result: passed ? "passed" : "failed",
    generatedAt: new Date().toISOString(),
    source: {
      packedArtifact: true,
      package: input.package,
      tarball: input.tarball,
      commit: input.commit,
    },
    host: input.host,
    timings: {
      artifactInstallMs: input.installMs,
      coldStartMs: runs[0]?.startupMs ?? null,
      warmStartMs: runs[1]?.startupMs ?? null,
    },
    runs,
    cleanup: input.cleanup,
    diagnostics: input.diagnostics,
  };
}

export function renderCchEvidenceMarkdown(summary) {
  const lines = [
    "# CCH Live Evidence",
    "",
    `**Result:** ${summary.result.toUpperCase()}  `,
    `**Package:** \`${summary.source.package.name}@${summary.source.package.version}\`  `,
    `**Commit:** \`${summary.source.commit.slice(0, 12)}\`  `,
    `**Host:** ${summary.host.platform} ${summary.host.release} (${summary.host.architecture}), Node ${summary.host.node}, Docker ${summary.host.docker}`,
    "",
    "| Run | Fresh state | Startup | Proof | Cleanup |",
    "| --- | --- | ---: | ---: | --- |",
    ...summary.runs.map(
      (run) =>
        `| ${run.mode} | yes | ${run.startupMs ?? "n/a"} ms | ${run.proof?.durationMs ?? "n/a"} ms | ${summary.cleanup[run.net]?.result ?? "failed"} |`,
    ),
    "",
    "Both runs install and execute the packed public SDK path. Runtime state, liquidity, credentials, containers, networks, and volumes are recreated for each run.",
    "",
    "This is a trusted local-development bridge over CKB devnet and Bitcoin regtest. It is not a reserve proof and does not establish mainnet custody safety.",
    "",
  ];
  return lines.join("\n");
}

async function main() {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), "fiber-forge-cch-evidence-"));
  const stateRoot = join(tempDir, "state");
  const runnerOutput = join(tempDir, "runner.json");
  const diagnostics = [];
  let runner = null;
  let tarball = { filename: "unavailable", bytes: 0, sha256: "unavailable" };
  let installMs = 0;
  let runnerResult = { code: 1, stdout: "", stderr: "", durationMs: 0 };
  const packageJson = JSON.parse(
    await readFile(join(repoDir, "package.json"), "utf8"),
  );
  const commit =
    process.env.GITHUB_SHA ??
    (await commandValue("git", ["rev-parse", "HEAD"])) ??
    "unknown";
  const runPrefix = `cch-${Date.now().toString(36).slice(-7)}`;

  try {
    const packDir = join(tempDir, "pack");
    const consumerDir = join(tempDir, "consumer");
    await Promise.all([
      mkdir(packDir, { recursive: true }),
      mkdir(consumerDir, { recursive: true }),
    ]);
    const packResult = await run("npm", [
      "pack",
      "--json",
      "--pack-destination",
      packDir,
    ]);
    diagnostics.push({ phase: "npm-pack", ...packResult });
    requireSuccess("npm pack", packResult);
    const packed = JSON.parse(packResult.stdout)[0];
    const tarballPath = join(packDir, packed.filename);
    const tarballBytes = await readFile(tarballPath);
    tarball = {
      filename: basename(tarballPath),
      bytes: tarballBytes.length,
      sha256: createHash("sha256").update(tarballBytes).digest("hex"),
    };
    await writeFile(
      join(consumerDir, "package.json"),
      JSON.stringify({
        name: "fiber-forge-cch-proof",
        private: true,
        type: "module",
      }),
    );
    const installResult = await run(
      "npm",
      ["install", "--omit=dev", "--no-audit", "--no-fund", tarballPath],
      { cwd: consumerDir },
    );
    installMs = installResult.durationMs;
    diagnostics.push({ phase: "packed-install", ...installResult });
    requireSuccess("packed artifact install", installResult);
    const copiedRunner = join(consumerDir, "cch-packed-runner.mjs");
    await copyFile(
      join(repoDir, "scripts", "cch-packed-runner.mjs"),
      copiedRunner,
    );
    runnerResult = await run(
      process.execPath,
      [copiedRunner, runnerOutput, stateRoot, runPrefix],
      { cwd: consumerDir, timeoutMs: PACKED_RUNNER_TIMEOUT_MS },
    );
    diagnostics.push({ phase: "packed-live-proof", ...runnerResult });
    try {
      runner = JSON.parse(await readFile(runnerOutput, "utf8"));
    } catch {
      // A missing report is represented as a failed evidence result below.
    }
  } finally {
    const cleanup = {};
    const nets = [`${runPrefix}-1`, `${runPrefix}-2`];
    for (const net of nets) {
      let residue = await inspectResidue(net, stateRoot);
      const initiallyClean = residueEmpty(residue);
      if (!initiallyClean) {
        await recoverResidue(net, stateRoot);
        residue = await inspectResidue(net, stateRoot);
      }
      cleanup[net] = {
        result: initiallyClean && residueEmpty(residue) ? "passed" : "failed",
        resourcesChecked: 9 + VOLUME_SUFFIXES.length,
        residue,
      };
    }

    const rawDiagnostics = diagnostics
      .map(
        ({ phase, code, durationMs, stdout, stderr }) =>
          `[${phase}] exit=${code} durationMs=${durationMs}\n${stdout}${stderr}`,
      )
      .join("\n");
    const sanitized = sanitizeText(rawDiagnostics, {
      maxBytes: MAX_DIAGNOSTICS_BYTES,
      privatePaths: [homedir(), tempDir],
    });
    const dockerVersion = await commandValue("docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    const host = {
      platform: platform(),
      release: release(),
      architecture: arch(),
      node: process.version,
      docker: dockerVersion ?? "unavailable",
    };
    const summary = buildCchEvidence({
      runner,
      cleanup,
      package: { name: packageJson.name, version: packageJson.version },
      tarball,
      commit,
      host,
      installMs,
      diagnostics: {
        file: "diagnostics.log",
        bytes: Buffer.byteLength(sanitized.text),
        redactions: sanitized.redactions,
        truncated: sanitized.truncated,
        limitBytes: MAX_DIAGNOSTICS_BYTES,
      },
    });
    const summaryJson = JSON.stringify(summary, null, 2) + "\n";
    if (Buffer.byteLength(summaryJson) > MAX_SUMMARY_BYTES) {
      throw new Error("CCH evidence summary exceeded its bounded size");
    }
    const markdown = renderCchEvidenceMarkdown(summary) + "\n";
    await Promise.all([
      writeFile(summaryFile, summaryJson),
      writeFile(markdownFile, markdown),
      writeFile(diagnosticsFile, sanitized.text),
    ]);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
    }
    await rm(tempDir, { recursive: true, force: true });
    console.log(`[cch-evidence] ${summary.result}; summary ${summaryFile}`);
    if (runnerResult.code !== 0 || summary.result !== "passed") {
      process.exitCode = 1;
    }
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await main();
  } catch (error) {
    const failure = sanitizeText(error instanceof Error ? error.stack : error, {
      maxBytes: 2048,
      privatePaths: [homedir()],
    });
    console.error(`[cch-evidence] ${failure.text}`);
    process.exitCode = 1;
  }
}
