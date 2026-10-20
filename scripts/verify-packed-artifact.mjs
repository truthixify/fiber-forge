import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = join(repoDir, "test", "fixtures", "sdk-consumer");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/;

const requiredPackageFiles = [
  "assets/ckb-entrypoint.sh",
  "assets/config.template.yml",
  "assets/contracts/always_success",
  "assets/contracts/auth",
  "assets/contracts/commitment-lock",
  "assets/contracts/funding-lock",
  "assets/contracts/simple_udt",
  "assets/contracts/xudt_rce",
  "assets/dev.toml",
  "assets/gui/index.html",
  "assets/gui/support.js",
  "bin/fiber-forge.mjs",
  "dist/sdk.d.ts",
  "dist/sdk.js",
  "docs/examples/export-v1/manifest.json",
  "docs/examples/export-v1/report.json",
  "docs/examples/export-v1/scenario.json",
  "docs/examples/export-v1/topology.json",
  "docs/export-bundles.md",
  "docs/fault-injection.md",
  "docs/force-close.md",
  "docs/lifecycle-errors.md",
  "docs/compatibility.md",
  "docs/evidence/linux-amd64-2026-10-20.json",
  "docs/evidence/macos-arm64-2026-10-20.json",
  "docs/github-action.md",
  "docs/integration.md",
  "docs/recovery.md",
  "docs/scenarios.md",
  "docs/sandbox.md",
  "docs/schema/export-manifest-v1.schema.json",
  "docs/sdk.md",
  "docs/verification.md",
  "examples/outage-recovery.yml",
  "examples/payments.yml",
  "examples/topology.yml",
  "package.json",
  "src/cli.ts",
];

function commandFailure(label, result) {
  return new Error(
    [
      `${label} failed with exit code ${String(result.code)}`,
      result.stdout && `stdout:\n${result.stdout.trimEnd()}`,
      result.stderr && `stderr:\n${result.stderr.trimEnd()}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function run(command, args, options = {}) {
  const { cwd = repoDir, env = process.env, timeoutMs = 300_000 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function requireSuccess(label, result) {
  if (result.code !== 0) {
    throw commandFailure(label, result);
  }
}

function assertNoAnsi(label, value) {
  assert.equal(
    ansiPattern.test(value),
    false,
    `${label} contains ANSI escapes`,
  );
}

function validatePackListing(metadata) {
  assert.equal(metadata.length, 1, "npm pack must produce one tarball");
  const packed = metadata[0];
  assert.equal(packed.name, "@truthixify/fiber-forge");

  const entries = new Map(packed.files.map((entry) => [entry.path, entry]));
  for (const path of requiredPackageFiles) {
    const entry = entries.get(path);
    assert.ok(entry, `packed artifact is missing ${path}`);
    assert.ok(entry.size > 0, `packed artifact contains an empty ${path}`);
  }

  const unexpected = [...entries.keys()].filter(
    (path) =>
      ![
        "LICENSE",
        "README.md",
        "package.json",
        "assets/",
        "bin/",
        "dist/",
        "docs/examples/export-v1/",
        "docs/export-bundles.md",
        "docs/fault-injection.md",
        "docs/force-close.md",
        "docs/lifecycle-errors.md",
        "docs/compatibility.md",
        "docs/evidence/",
        "docs/github-action.md",
        "docs/integration.md",
        "docs/recovery.md",
        "docs/scenarios.md",
        "docs/sandbox.md",
        "docs/schema/",
        "docs/sdk.md",
        "docs/verification.md",
        "examples/outage-recovery.yml",
        "examples/payments.yml",
        "examples/topology.yml",
        "src/",
      ].some((allowedPath) =>
        allowedPath.endsWith("/")
          ? path.startsWith(allowedPath)
          : path === allowedPath,
      ),
  );
  assert.deepEqual(
    unexpected,
    [],
    `unexpected packed files: ${unexpected.join(", ")}`,
  );

  const bin = entries.get("bin/fiber-forge.mjs");
  assert.ok((bin.mode & 0o111) !== 0, "packed CLI is not executable");
  return packed;
}

async function assertInstalledFiles(packageDir) {
  for (const path of requiredPackageFiles) {
    const info = await stat(join(packageDir, path));
    assert.ok(info.isFile(), `installed package is missing ${path}`);
    assert.ok(info.size > 0, `installed package contains an empty ${path}`);
  }
}

async function main() {
  const packageMetadata = JSON.parse(
    await readFile(join(repoDir, "package.json"), "utf8"),
  );
  const tempDir = await mkdtemp(join(tmpdir(), "fiber-forge-package-"));

  try {
    const packDir = join(tempDir, "pack");
    const consumerDir = join(tempDir, "consumer");
    const consumerHome = join(tempDir, "home");
    await Promise.all([
      mkdir(packDir, { recursive: true }),
      mkdir(consumerDir, { recursive: true }),
      mkdir(consumerHome, { recursive: true }),
    ]);

    const packResult = await run(npmCommand, [
      "pack",
      "--json",
      "--pack-destination",
      packDir,
    ]);
    requireSuccess("npm pack", packResult);
    const packed = validatePackListing(JSON.parse(packResult.stdout));
    const tarball = join(packDir, packed.filename);

    await writeFile(
      join(consumerDir, "package.json"),
      JSON.stringify(
        {
          name: "fiber-forge-package-smoke",
          private: true,
          type: "module",
        },
        null,
        2,
      ) + "\n",
    );
    const installResult = await run(
      npmCommand,
      [
        "install",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        tarball,
      ],
      { cwd: consumerDir },
    );
    requireSuccess("production-only tarball installation", installResult);

    const packageDir = join(
      consumerDir,
      "node_modules",
      "@truthixify",
      "fiber-forge",
    );
    await assertInstalledFiles(packageDir);
    const installLock = JSON.parse(
      await readFile(join(consumerDir, "package-lock.json"), "utf8"),
    );
    const installedDevEntries = Object.entries(installLock.packages)
      .filter(([, entry]) => entry.dev === true)
      .map(([path]) => path);
    assert.deepEqual(
      installedDevEntries,
      [],
      `production fixture installed dev-only entries: ${installedDevEntries.join(", ")}`,
    );
    for (const devOnlyPackage of ["prettier", "vitest"]) {
      await assert.rejects(
        stat(join(consumerDir, "node_modules", devOnlyPackage)),
        `${devOnlyPackage} must not be installed in the production fixture`,
      );
    }

    await Promise.all(
      ["consumer.ts", "runtime.mjs", "tsconfig.json"].map((file) =>
        copyFile(join(fixtureDir, file), join(consumerDir, file)),
      ),
    );
    const invalidTopology = join(consumerDir, "invalid-topology.yml");
    await writeFile(
      invalidTopology,
      [
        "name: packed-smoke",
        "nodes: [{ name: alice }, { name: bob }]",
        "channels:",
        "  - { from: alice, to: missing, capacity_ckb: 1000 }",
        "funding: { per_node_ckb: 100000 }",
        "",
      ].join("\n"),
    );

    const bin = join(
      consumerDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "fiber-forge.cmd" : "fiber-forge",
    );
    const cliEnv = {
      ...process.env,
      HOME: consumerHome,
      USERPROFILE: consumerHome,
      NO_COLOR: "1",
      DOCKER_HOST: `unix://${join(tempDir, "no-docker.sock")}`,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    };
    delete cliEnv.FORCE_COLOR;

    const versionResult = await run(bin, ["--version"], {
      cwd: consumerDir,
      env: cliEnv,
    });
    requireSuccess("installed CLI --version", versionResult);
    assert.equal(versionResult.stdout.trim(), packageMetadata.version);
    assert.equal(versionResult.stderr, "");

    const helpResult = await run(bin, ["--help"], {
      cwd: consumerDir,
      env: cliEnv,
    });
    requireSuccess("installed CLI --help", helpResult);
    assert.match(helpResult.stdout, /One-click local Fiber networks/);
    assert.match(helpResult.stdout, /\bup\b/);
    assert.equal(helpResult.stderr, "");
    assertNoAnsi("CLI help", helpResult.stdout);

    const jsonResult = await run(bin, ["ls", "--json"], {
      cwd: consumerDir,
      env: cliEnv,
    });
    requireSuccess("installed CLI JSON output", jsonResult);
    assert.deepEqual(JSON.parse(jsonResult.stdout), []);
    assert.equal(jsonResult.stderr, "");
    assertNoAnsi("CLI JSON output", jsonResult.stdout);

    const topologyResult = await run(
      bin,
      ["up", invalidTopology, "--no-gui", "--json"],
      { cwd: consumerDir, env: cliEnv },
    );
    assert.equal(topologyResult.code, 1, "invalid topology must exit non-zero");
    assert.equal(topologyResult.stdout, "");
    const topologyError = JSON.parse(topologyResult.stderr);
    assert.equal(topologyError.ok, false);
    assert.equal(topologyError.error.code, "UNEXPECTED");
    assert.match(topologyError.error.message, /invalid topology/);
    assert.match(topologyError.error.message, /unknown node "missing"/);
    assertNoAnsi("CLI topology error", topologyResult.stderr);

    const runtimeResult = await run(
      process.execPath,
      [join(consumerDir, "runtime.mjs")],
      { cwd: consumerDir, env: cliEnv },
    );
    requireSuccess("installed SDK runtime import", runtimeResult);

    const typecheckResult = await run(
      process.execPath,
      [
        join(repoDir, "node_modules", "typescript", "bin", "tsc"),
        "--project",
        join(consumerDir, "tsconfig.json"),
      ],
      { cwd: consumerDir },
    );
    requireSuccess("installed SDK declaration typecheck", typecheckResult);

    console.log(
      `packed artifact verified: ${packed.filename} (${packed.entryCount} files)`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
