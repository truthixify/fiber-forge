import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageName = "@truthixify/fiber-forge";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const maxCommandOutputBytes = 64 * 1024;

export const requiredRegistryFiles = Object.freeze([
  "assets/ckb-entrypoint.sh",
  "assets/config.template.yml",
  "assets/contracts/commitment-lock",
  "assets/contracts/funding-lock",
  "assets/contracts/simple_udt",
  "assets/dev.toml",
  "assets/gui/index.html",
  "assets/gui/support.js",
  "bin/fiber-forge.mjs",
  "dist/sdk.d.ts",
  "dist/sdk.js",
]);

export const requiredLiquidityGuiMarkers = Object.freeze([
  "const assetColor = ch.udt ? 'var(--flux)' : 'var(--ember)'",
  "VISIBLE OUTBOUND",
  "openCapForPayment",
  "pairSelectionCount",
]);

export function assertReleaseVersion(version) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      version ?? "",
    )
  ) {
    throw new Error("registry smoke requires an exact semantic version");
  }
}

export async function verifyInstalledPackage(packageDir, expectedVersion) {
  assertReleaseVersion(expectedVersion);
  const metadata = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );
  assert.equal(metadata.name, packageName);
  assert.equal(metadata.version, expectedVersion);
  assert.equal(metadata.bin?.["fiber-forge"], "bin/fiber-forge.mjs");
  assert.equal(metadata.exports?.["./sdk"]?.import, "./dist/sdk.js");
  assert.equal(metadata.exports?.["./sdk"]?.types, "./dist/sdk.d.ts");

  for (const relativePath of requiredRegistryFiles) {
    const file = join(packageDir, relativePath);
    await access(file);
    assert.ok((await stat(file)).size > 0, `${relativePath} is empty`);
  }

  const gui = await readFile(join(packageDir, "assets/gui/index.html"), "utf8");
  for (const marker of requiredLiquidityGuiMarkers) {
    assert.ok(
      gui.includes(marker),
      `published GUI is missing marker: ${marker}`,
    );
  }

  return {
    name: metadata.name,
    version: metadata.version,
    files: requiredRegistryFiles.length,
    guiMarkers: requiredLiquidityGuiMarkers.length,
  };
}

async function run(command, args, cwd, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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
      stdout = `${stdout}${chunk}`.slice(-maxCommandOutputBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-maxCommandOutputBytes);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function requireSuccess(label, result) {
  if (result.code === 0) return;
  throw new Error(
    [
      `${label} failed with exit code ${String(result.code)}`,
      result.stdout.trim() && `stdout:\n${result.stdout.trim()}`,
      result.stderr.trim() && `stderr:\n${result.stderr.trim()}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export async function verifyRegistryArtifact(version) {
  assertReleaseVersion(version);
  const consumerDir = await mkdtemp(join(tmpdir(), "fiber-forge-registry-"));
  try {
    await writeFile(
      join(consumerDir, "package.json"),
      JSON.stringify({
        name: "fiber-forge-registry-smoke",
        private: true,
        type: "module",
      }),
    );
    const install = await run(
      npmCommand,
      [
        "install",
        "--ignore-scripts",
        "--engine-strict",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        `${packageName}@${version}`,
      ],
      consumerDir,
    );
    requireSuccess("registry install", install);

    const packageDir = join(
      consumerDir,
      "node_modules",
      "@truthixify",
      "fiber-forge",
    );
    const verified = await verifyInstalledPackage(packageDir, version);
    const cli = await run(
      process.execPath,
      [join(packageDir, "bin", "fiber-forge.mjs"), "--version"],
      consumerDir,
    );
    requireSuccess("published CLI smoke", cli);
    assert.equal(cli.stdout.trim(), version);

    const sdk = await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'const sdk = await import("@truthixify/fiber-forge/sdk"); for (const name of ["createFiberForge", "preset"]) { if (typeof sdk[name] !== "function") throw new Error(`missing SDK export ${name}`); }',
      ],
      consumerDir,
    );
    requireSuccess("published SDK smoke", sdk);
    process.stdout.write(
      `${JSON.stringify({ ...verified, cli: "passed", sdk: "passed" })}\n`,
    );
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await verifyRegistryArtifact(process.argv[2]);
}
