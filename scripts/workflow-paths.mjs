import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const sharedRuntimePaths = [
  ".github/workflows/merge-gate.yml",
  "assets/**",
  "bin/**",
  "package-lock.json",
  "package.json",
  "scripts/workflow-paths.mjs",
  "src/**",
  "tsconfig.build.json",
  "tsconfig.json",
];

export const workflowPathGroups = Object.freeze({
  ordinary: [
    ...sharedRuntimePaths,
    ".github/workflows/e2e.yml",
    ".github/workflows/publish.yml",
    "examples/outage-recovery.yml",
    "examples/payments.yml",
    "examples/topology.yml",
    "scripts/live-evidence.mjs",
    "scripts/verify-packed-artifact.mjs",
    "test/e2e.test.ts",
    "test/live-evidence.test.mjs",
  ],
  cch: [
    ...sharedRuntimePaths,
    ".github/workflows/cch-e2e.yml",
    ".github/workflows/publish.yml",
    "examples/cch-two-way.sh",
    "scripts/cch-evidence.mjs",
    "scripts/cch-packed-runner.mjs",
    "scripts/cch-runner-state.mjs",
    "scripts/live-evidence.mjs",
    "test/cch-evidence.test.mjs",
    "test/cch-proof.test.ts",
    "test/cch-runner-state.test.mjs",
    "test/cch-status.test.ts",
    "test/cch-topology-e2e.test.ts",
    "test/cch.test.ts",
    "test/lightning-e2e.test.ts",
  ],
  action: [
    ...sharedRuntimePaths,
    ".github/workflows/action-e2e.yml",
    ".github/workflows/publish.yml",
    "action.yml",
    "action/**",
    "examples/integration-app/**",
    "test/action-design.test.mjs",
    "test/action-runtime.test.mjs",
    "test/fixtures/action-cleanup-probe/**",
    "test/integration-app.test.mjs",
  ],
});

function matchesRule(file, rule) {
  if (!rule.endsWith("/**")) return file === rule;
  const directory = rule.slice(0, -3);
  return file === directory || file.startsWith(`${directory}/`);
}

export function classifyWorkflowPaths(files) {
  const uniqueFiles = [...new Set(files)];
  return Object.fromEntries(
    Object.entries(workflowPathGroups).map(([name, rules]) => [
      name,
      uniqueFiles.some((file) => rules.some((rule) => matchesRule(file, rule))),
    ]),
  );
}

export function changedFilesBetween(baseSha, headSha, cwd = process.cwd()) {
  for (const [label, sha] of [
    ["base", baseSha],
    ["head", headSha],
  ]) {
    if (!/^[0-9a-f]{40,64}$/i.test(sha ?? "")) {
      throw new Error(`${label} commit must be a full hexadecimal object ID`);
    }
  }
  const output = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--no-renames",
      "--diff-filter=ACDMRTUXB",
      "-z",
      baseSha,
      headSha,
    ],
    { cwd },
  );
  return output.toString("utf8").split("\0").filter(Boolean);
}

export function formatWorkflowOutputs(classification) {
  return ["ordinary", "cch", "action"]
    .map(
      (name) => `${name}=${classification[name] === true ? "true" : "false"}`,
    )
    .join("\n");
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const [, , baseSha, headSha] = process.argv;
  const files = changedFilesBetween(baseSha, headSha);
  process.stdout.write(
    `${formatWorkflowOutputs(classifyWorkflowPaths(files))}\n`,
  );
}
