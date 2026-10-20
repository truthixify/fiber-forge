import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoDir,
      env: options.env ?? process.env,
      shell: false,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
    }
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

function requireSuccess(label, result) {
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with exit code ${String(result.code)}\n${result.stderr}`,
    );
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), "fiber-forge-example-"));
let childSignal;
try {
  const packDir = join(tempRoot, "pack");
  const appDir = join(tempRoot, "app");
  await Promise.all([
    mkdir(packDir, { recursive: true }),
    cp(join(repoDir, "examples", "integration-app"), appDir, {
      recursive: true,
    }),
  ]);

  const packed = await run(
    npmCommand,
    ["pack", "--json", "--pack-destination", packDir],
    { capture: true },
  );
  requireSuccess("npm pack", packed);
  const [metadata] = JSON.parse(packed.stdout);
  const packageMetadata = JSON.parse(
    await readFile(join(repoDir, "package.json"), "utf8"),
  );
  if (metadata.version !== packageMetadata.version) {
    throw new Error(
      "packed example dependency version does not match package.json",
    );
  }
  const tarball = join(packDir, metadata.filename);
  const installed = await run(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--package-lock=false",
      "--no-save",
      tarball,
    ],
    { cwd: appDir, capture: true },
  );
  requireSuccess("isolated example install", installed);

  const result = await run(
    process.execPath,
    [join(appDir, "src", "local.mjs"), ...process.argv.slice(2)],
    { cwd: appDir },
  );
  childSignal = result.signal;
  process.exitCode = result.code ?? 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
if (childSignal) process.kill(process.pid, childSignal);
