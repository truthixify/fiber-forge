/**
 * Secret-safe Fiber Forge export bundles. The format deliberately contains only canonical recipe
 * inputs, a portable scenario outcome, and optional bounded diagnostics. It never extracts archive
 * paths or accepts executable content.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, open, rm } from "node:fs/promises";
import { arch, homedir, platform, type as osType } from "node:os";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";

import {
  FORGE_ERROR_CODES,
  ForgeError,
  errorDetails,
  type ForgeErrorCode,
} from "./errors.js";
import {
  packageName,
  packageVersion,
  runtimeImages,
} from "./package-metadata.js";
import {
  ScenarioError,
  parseScenario,
  type AssertionResult,
  type Scenario,
  type ScenarioAction,
  type ScenarioReport,
  type ScenarioStep,
} from "./scenario.js";
import {
  isValidNetworkName,
  parseTopology,
  type Topology,
} from "./topology.js";

export const BUNDLE_SCHEMA_VERSION = Object.freeze({ major: 1, minor: 0 });
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
export const MAX_BUNDLE_EXPANDED_BYTES = 2 * 1024 * 1024;
export const MAX_BUNDLE_ENTRIES = 64;
export const MAX_BUNDLE_ENTRY_BYTES = 1024 * 1024;
export const MAX_BUNDLE_MANIFEST_BYTES = 64 * 1024;
export const MAX_BUNDLE_LOG_BYTES = 64 * 1024;
export const MAX_BUNDLE_LOG_TOTAL_BYTES = 512 * 1024;
export const DEFAULT_REPLAY_TIMEOUT_MS = 20 * 60_000;
export const MAX_REPLAY_TIMEOUT_MS = 60 * 60_000;
const MAX_REPLAY_EXECUTIONS = 100;
const MAX_REPLAY_DECLARED_DELAY_MS = 10 * 60_000;

const TAR_BLOCK_BYTES = 512;
const ARTIFACT_PATH =
  /^(?:topology\.json|scenario\.json|report\.json|diagnostics\/(?:network|channels|faults)\.json|diagnostics\/logs\/(?:ckb|node-[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)\.log)$/;
const NODE_LOG_PATH =
  /^diagnostics\/logs\/node-([a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)\.log$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMAGE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const ACTION_TYPES = new Set([
  "pay",
  "open",
  "close",
  "fund",
  "invoice",
  "node",
  "fault",
  "assert",
  "wait",
]);
const ASSERTION_TYPES = new Set([
  "payment_status",
  "node_status",
  "error_code",
  "channel_state",
  "balance",
]);

export type BundleLevel = "recipe" | "diagnostic";
export type BundleArtifactRole =
  | "topology"
  | "scenario"
  | "scenario-report"
  | "network-inspection"
  | "channel-inspection"
  | "fault-inspection"
  | "ckb-log"
  | "node-log";

export interface BundleArtifactManifest {
  path: string;
  role: BundleArtifactRole;
  mediaType: "application/json" | "text/plain";
  bytes: number;
  sha256: string;
}

export interface ExportManifest {
  format: "fiber-forge-export";
  schema: { major: 1; minor: 0 };
  level: BundleLevel;
  createdAt: string;
  generator: { package: string; version: string };
  runtime: { images: { ckb: string; fiber: string } };
  sourceHost: {
    os: string;
    architecture: string;
    node: string;
    docker: string;
  };
  capabilities: { exactStateRestore: false; containsSecrets: false };
  recipeDigest: string;
  artifacts: BundleArtifactManifest[];
}

export interface PortableAssertionResult {
  type: AssertionResult["type"];
  passed: boolean;
  expected: unknown;
}

export interface PortableScenarioReport {
  format: "fiber-forge-scenario-report";
  version: 1;
  scenarioVersion: 1;
  network: string;
  passed: boolean;
  summary: { total: number; passed: number; failed: number };
  steps: {
    index: number;
    iteration: number;
    action: ScenarioAction["type"];
    passed: boolean;
    assertions: PortableAssertionResult[];
    errorCode?: ForgeErrorCode;
  }[];
}

export interface BundleSourceHost {
  os?: string;
  architecture?: string;
  node?: string;
  docker: string;
}

export interface BundleDiagnostics {
  network: unknown;
  channels: unknown;
  faults: unknown;
  logs: Record<string, string>;
  privatePaths?: string[];
}

export interface ExportBundleOptions {
  /** Parsed scenario or its JSON/YAML source. Descriptions are omitted from the bundle. */
  scenario: Scenario | string;
  /** Scenario report object or strict JSON source produced for `scenario`. */
  report: ScenarioReport | string;
  /** Destination path. Existing files are never replaced. */
  output: string;
  /** Required only when exporting a legacy layout that did not persist normalized topology. */
  topology?: Topology | string;
  /** Include bounded, redacted inspection and log artifacts. */
  diagnostics?: boolean;
}

export interface ExportBundleResult {
  output: string;
  bytes: number;
  level: BundleLevel;
  recipeDigest: string;
  artifacts: number;
}

export interface BundleCompatibility {
  package: "supported" | "mismatch";
  images: "supported" | "mismatch";
  host: "supported" | "unsupported";
  replayable: boolean;
  reasons: string[];
}

export interface BundleInspection {
  format: ExportManifest["format"];
  schema: ExportManifest["schema"];
  level: BundleLevel;
  createdAt: string;
  recipeDigest: string;
  generator: ExportManifest["generator"];
  runtime: ExportManifest["runtime"];
  sourceHost: ExportManifest["sourceHost"];
  capabilities: ExportManifest["capabilities"];
  integrity: "verified";
  redaction: "verified";
  artifacts: BundleArtifactManifest[];
  recipe: {
    network: string;
    nodes: string[];
    channels: number;
    executions: number;
    expectedPassed: boolean;
  };
  compatibility: BundleCompatibility;
}

export interface ReplayBundleOptions {
  /** Fresh target network name. A bundle can never choose its own cleanup target. */
  network: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface ReplayBundleResult {
  network: string;
  recipeDigest: string;
  reproduced: boolean;
  differences: string[];
  expected: PortableScenarioReport;
  actual: PortableScenarioReport;
  cleanup: { purged: true };
}

export interface ReplayBundleBackend {
  assertReplayTargetClean(net: string): Promise<void>;
  up(
    topology: Topology,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      requireClean?: boolean;
    },
  ): Promise<unknown>;
  runScenario(
    net: string,
    scenario: Scenario,
    options?: { signal?: AbortSignal },
  ): Promise<ScenarioReport>;
  down(net: string, options: { purge: true }): Promise<void>;
}

interface BundleBuildInput {
  topology: Topology;
  scenario: Scenario | string;
  report: ScenarioReport | string;
  sourceHost: BundleSourceHost;
  diagnostics?: BundleDiagnostics;
  createdAt?: Date;
}

interface LoadedBundle {
  manifest: ExportManifest;
  topology: Topology;
  scenario: Scenario;
  report: PortableScenarioReport;
  inspection: BundleInspection;
}

function bundleError(message: string, action: string): ForgeError {
  return new ForgeError("BUNDLE_INVALID", message, {
    resource: "export bundle",
    action,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw bundleError(
      "bundle data contains a value that JSON cannot represent",
      "remove undefined, cyclic, or non-JSON data and retry",
    );
  }
  return encoded;
}

function prettyJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function topologyDocument(topology: Topology): unknown {
  return {
    name: topology.name,
    nodes: topology.nodes.map((node) => ({ name: node.name })),
    channels: topology.channels.map((channel) => ({
      from: channel.from,
      to: channel.to,
      capacity_ckb: channel.capacityCkb,
    })),
    funding: { per_node_ckb: topology.funding.perNodeCkb },
  };
}

function actionDocument(action: ScenarioAction): Record<string, unknown> {
  switch (action.type) {
    case "pay":
      return {
        pay: {
          from: action.from,
          to: action.to,
          amount: action.amount,
          udt: action.udt,
        },
      };
    case "open":
      return {
        open: {
          from: action.from,
          to: action.to,
          capacity: action.capacity,
          udt: action.udt,
        },
      };
    case "close":
      return { close: { node: action.node, channel: action.channel } };
    case "fund":
      return { fund: { node: action.node, amount: action.amount } };
    case "invoice":
      return {
        invoice: { node: action.node, amount: action.amount, udt: action.udt },
      };
    case "node":
      return {
        node: {
          action: action.action,
          node: action.node,
          ...(action.timeoutMs === undefined
            ? {}
            : { timeout_ms: action.timeoutMs }),
        },
      };
    case "fault":
      return {
        fault: {
          action: action.action,
          kind: action.kind,
          ...(action.target ? { target: action.target } : {}),
        },
      };
    case "assert": {
      const assertion = action.assertion;
      const timing = {
        timeout_ms: assertion.timeoutMs,
        poll_interval_ms: assertion.pollIntervalMs,
      };
      if (assertion.type === "node_status") {
        return {
          assert: {
            node_status: {
              node: assertion.node,
              equals: assertion.expected,
            },
            ...timing,
          },
        };
      }
      if (assertion.type === "channel_state") {
        return {
          assert: {
            channel_state: {
              node: assertion.node,
              ...(assertion.channelId
                ? { channel_id: assertion.channelId }
                : {}),
              ...(assertion.peer ? { peer: assertion.peer } : {}),
              equals: assertion.expected,
            },
            ...timing,
          },
        };
      }
      return {
        assert: {
          balance: {
            node: assertion.node,
            asset: assertion.asset,
            operator: assertion.operator,
            amount: assertion.amount,
          },
          ...timing,
        },
      };
    }
    case "wait":
      return { wait: action.durationMs };
  }
}

function expectationDocument(step: ScenarioStep): Record<string, unknown> {
  if (!step.expect) return {};
  const expectation = step.expect;
  const key = expectation.type;
  return {
    expect: {
      [key]: expectation.expected,
      timeout_ms: expectation.timeoutMs,
      poll_interval_ms: expectation.pollIntervalMs,
    },
  };
}

function scenarioDocument(scenario: Scenario): unknown {
  return {
    version: scenario.version,
    loop: scenario.loop,
    steps: scenario.steps.map((step) => ({
      ...actionDocument(step.action),
      ...expectationDocument(step),
    })),
  };
}

function parseScenarioInput(value: Scenario | string): Scenario {
  if (typeof value === "string") return parseScenario(value);
  try {
    return parseScenario(JSON.stringify(scenarioDocument(value)));
  } catch (error) {
    if (error instanceof ForgeError || error instanceof ScenarioError) {
      throw error;
    }
    throw bundleError(
      `scenario object is invalid: ${errorDetails(error).message}`,
      "parse the scenario with parseScenario before exporting it",
    );
  }
}

function strictJson(text: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw bundleError(
      `${label} is not strict JSON: ${errorDetails(error).message}`,
      `replace ${label} with valid JSON and retry`,
    );
  }
  const document = parseDocument(text, {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw bundleError(
      `${label} contains duplicate object keys`,
      `remove duplicate keys from ${label} and retry`,
    );
  }
  return parsed;
}

function keysAre(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw bundleError(
      `${label} contains unknown field${extras.length === 1 ? "" : "s"}: ${extras.join(", ")}`,
      `remove unknown ${label} fields and retry`,
    );
  }
}

function finiteInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw bundleError(
      `${label} must be an integer from ${minimum} to ${maximum}`,
      `fix ${label} and retry`,
    );
  }
  return value as number;
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw bundleError(
      `${label} must be a non-empty string up to ${maximum} characters`,
      `fix ${label} and retry`,
    );
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, 64, label);
  let normalized: string;
  try {
    normalized = new Date(timestamp).toISOString();
  } catch {
    normalized = "";
  }
  if (normalized !== timestamp) {
    throw bundleError(
      `${label} must be a UTC ISO-8601 timestamp`,
      "regenerate the report and retry",
    );
  }
  return timestamp;
}

function validateOptionalTiming(
  value: Record<string, unknown>,
  label: string,
): void {
  const keys = ["startedAt", "finishedAt", "durationMs"] as const;
  const present = keys.filter((key) => value[key] !== undefined);
  if (present.length === 0) return;
  if (present.length !== keys.length) {
    throw bundleError(
      `${label} has incomplete timing metadata`,
      "regenerate the report and retry",
    );
  }
  const startedAt = isoTimestamp(value.startedAt, `${label}.startedAt`);
  const finishedAt = isoTimestamp(value.finishedAt, `${label}.finishedAt`);
  const durationMs = finiteInteger(
    value.durationMs,
    0,
    MAX_REPLAY_TIMEOUT_MS,
    `${label}.durationMs`,
  );
  if (Date.parse(finishedAt) - Date.parse(startedAt) !== durationMs) {
    throw bundleError(
      `${label} timing metadata is inconsistent`,
      "regenerate the report and retry",
    );
  }
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw bundleError(`${label} must be an object`, `fix ${label} and retry`);
  }
  return value;
}

function validateReportInput(value: ScenarioReport | string): ScenarioReport {
  const raw =
    typeof value === "string"
      ? strictJson(value, "scenario report")
      : (value as unknown);
  const root = requiredRecord(raw, "scenario report");
  keysAre(
    root,
    [
      "format",
      "version",
      "scenarioVersion",
      "network",
      "startedAt",
      "finishedAt",
      "durationMs",
      "passed",
      "summary",
      "steps",
    ],
    "scenario report",
  );
  if (
    root.format !== "fiber-forge-scenario-report" ||
    root.version !== 1 ||
    root.scenarioVersion !== 1 ||
    typeof root.network !== "string" ||
    typeof root.passed !== "boolean" ||
    !Array.isArray(root.steps)
  ) {
    throw bundleError(
      "scenario report has an unsupported or incomplete envelope",
      "provide a schema-version-1 Fiber Forge scenario report",
    );
  }
  if (!isValidNetworkName(root.network)) {
    throw bundleError(
      "scenario report network is invalid",
      "regenerate the report for a valid Fiber Forge network",
    );
  }
  validateOptionalTiming(root, "scenario report");
  const summary = requiredRecord(root.summary, "scenario report summary");
  keysAre(summary, ["total", "passed", "failed"], "scenario report summary");
  const total = finiteInteger(summary.total, 0, 10_000, "report summary.total");
  const passed = finiteInteger(
    summary.passed,
    0,
    10_000,
    "report summary.passed",
  );
  const failed = finiteInteger(
    summary.failed,
    0,
    10_000,
    "report summary.failed",
  );
  if (total !== root.steps.length || passed + failed !== total) {
    throw bundleError(
      "scenario report summary does not match its steps",
      "regenerate the report from the supplied scenario",
    );
  }

  let observedPassed = 0;
  root.steps.forEach((rawStep, position) => {
    const step = requiredRecord(rawStep, `scenario report steps[${position}]`);
    keysAre(
      step,
      [
        "index",
        "iteration",
        "action",
        "passed",
        "summary",
        "startedAt",
        "finishedAt",
        "durationMs",
        "actual",
        "assertions",
        "error",
        "errorCode",
      ],
      `scenario report steps[${position}]`,
    );
    if (
      step.index !== position ||
      !Number.isInteger(step.iteration) ||
      (step.iteration as number) < 0 ||
      (step.iteration as number) >= MAX_REPLAY_EXECUTIONS ||
      !ACTION_TYPES.has(String(step.action)) ||
      typeof step.passed !== "boolean" ||
      !Array.isArray(step.assertions)
    ) {
      throw bundleError(
        `scenario report steps[${position}] has invalid identity or result fields`,
        "regenerate the report from the supplied scenario",
      );
    }
    const stepMetadata = ["summary", "startedAt", "finishedAt", "durationMs"];
    const presentStepMetadata = stepMetadata.filter(
      (key) => step[key] !== undefined,
    );
    if (
      presentStepMetadata.length !== 0 &&
      presentStepMetadata.length !== stepMetadata.length
    ) {
      throw bundleError(
        `scenario report steps[${position}] has incomplete runtime metadata`,
        "regenerate the report and retry",
      );
    }
    if (presentStepMetadata.length > 0) {
      boundedString(
        step.summary,
        4096,
        `scenario report steps[${position}].summary`,
      );
      validateOptionalTiming(step, `scenario report steps[${position}]`);
    }
    if (step.passed) observedPassed += 1;
    step.assertions.forEach((rawAssertion, assertionIndex) => {
      const assertion = requiredRecord(
        rawAssertion,
        `scenario report steps[${position}].assertions[${assertionIndex}]`,
      );
      keysAre(
        assertion,
        [
          "type",
          "passed",
          "expected",
          "actual",
          "attempts",
          "durationMs",
          "diagnostic",
        ],
        `scenario report steps[${position}].assertions[${assertionIndex}]`,
      );
      if (
        !ASSERTION_TYPES.has(String(assertion.type)) ||
        typeof assertion.passed !== "boolean" ||
        !("expected" in assertion)
      ) {
        throw bundleError(
          `scenario report steps[${position}].assertions[${assertionIndex}] is invalid`,
          "regenerate the report from the supplied scenario",
        );
      }
      const assertionMetadata = ["attempts", "durationMs"];
      const presentAssertionMetadata = assertionMetadata.filter(
        (key) => assertion[key] !== undefined,
      );
      if (
        presentAssertionMetadata.length !== 0 &&
        presentAssertionMetadata.length !== assertionMetadata.length
      ) {
        throw bundleError(
          `scenario report steps[${position}].assertions[${assertionIndex}] has incomplete runtime metadata`,
          "regenerate the report and retry",
        );
      }
      if (presentAssertionMetadata.length > 0) {
        finiteInteger(
          assertion.attempts,
          1,
          1_000_000,
          `scenario report steps[${position}].assertions[${assertionIndex}].attempts`,
        );
        finiteInteger(
          assertion.durationMs,
          0,
          MAX_REPLAY_TIMEOUT_MS,
          `scenario report steps[${position}].assertions[${assertionIndex}].durationMs`,
        );
      }
      if (assertion.diagnostic !== undefined) {
        boundedString(
          assertion.diagnostic,
          4096,
          `scenario report steps[${position}].assertions[${assertionIndex}].diagnostic`,
        );
      }
    });
    if (step.error !== undefined) {
      const error = requiredRecord(
        step.error,
        `scenario report steps[${position}].error`,
      );
      keysAre(
        error,
        ["code", "message", "resource", "action"],
        `scenario report steps[${position}].error`,
      );
      if (!(FORGE_ERROR_CODES as readonly unknown[]).includes(error.code)) {
        throw bundleError(
          `scenario report steps[${position}].error has an unknown code`,
          "regenerate the report with this Fiber Forge version",
        );
      }
      boundedString(
        error.message,
        4096,
        `scenario report steps[${position}].error.message`,
      );
      for (const key of ["resource", "action"] as const) {
        if (error[key] !== undefined) {
          boundedString(
            error[key],
            4096,
            `scenario report steps[${position}].error.${key}`,
          );
        }
      }
    }
    if (
      step.errorCode !== undefined &&
      !(FORGE_ERROR_CODES as readonly unknown[]).includes(step.errorCode)
    ) {
      throw bundleError(
        `scenario report steps[${position}].errorCode is unknown`,
        "regenerate the report with this Fiber Forge version",
      );
    }
    if (
      step.error !== undefined &&
      step.errorCode !== undefined &&
      (step.error as Record<string, unknown>).code !== step.errorCode
    ) {
      throw bundleError(
        `scenario report steps[${position}] has conflicting error codes`,
        "regenerate the report and retry",
      );
    }
  });
  if (observedPassed !== passed || root.passed !== (failed === 0)) {
    throw bundleError(
      "scenario report aggregate outcome does not match its steps",
      "regenerate the report from the supplied scenario",
    );
  }
  return raw as ScenarioReport;
}

function expectedAssertions(
  step: ScenarioStep,
): { type: string; expected: unknown }[] {
  if (step.action.type === "assert") {
    const assertion = step.action.assertion;
    return [
      {
        type: assertion.type,
        expected:
          assertion.type === "balance"
            ? {
                asset: assertion.asset,
                operator: assertion.operator,
                amount: assertion.amount,
              }
            : assertion.expected,
      },
    ];
  }
  return step.expect
    ? [{ type: step.expect.type, expected: step.expect.expected }]
    : [];
}

function portableReport(
  reportValue: ScenarioReport | string,
  scenario: Scenario,
  network: string,
): PortableScenarioReport {
  const report = validateReportInput(reportValue);
  if (report.network !== network) {
    throw bundleError(
      `scenario report network "${report.network}" does not match "${network}"`,
      "use the report produced against the exported network",
    );
  }
  const expectedCount = scenario.steps.length * scenario.loop;
  if (report.steps.length !== expectedCount) {
    throw bundleError(
      `scenario report has ${report.steps.length} steps but the expanded scenario has ${expectedCount}`,
      "use the report produced from the supplied scenario",
    );
  }

  const steps = report.steps.map((result, index) => {
    const iteration = Math.floor(index / scenario.steps.length);
    const source = scenario.steps[index % scenario.steps.length];
    const expected = expectedAssertions(source);
    if (
      result.index !== index ||
      result.iteration !== iteration ||
      result.action !== source.action.type ||
      result.assertions.length !== expected.length
    ) {
      throw bundleError(
        `scenario report step ${index} does not match the supplied scenario`,
        "use the report produced from the supplied scenario",
      );
    }
    const assertions = result.assertions.map((assertion, assertionIndex) => {
      const wanted = expected[assertionIndex];
      if (
        assertion.type !== wanted.type ||
        !isDeepStrictEqual(assertion.expected, wanted.expected)
      ) {
        throw bundleError(
          `scenario report step ${index} assertion ${assertionIndex} does not match the supplied scenario`,
          "use the report produced from the supplied scenario",
        );
      }
      return {
        type: assertion.type,
        passed: assertion.passed,
        expected: wanted.expected,
      };
    });
    const errorCode =
      (result as unknown as { errorCode?: ForgeErrorCode }).errorCode ??
      result.error?.code;
    const stepShouldPass =
      assertions.length > 0
        ? assertions.every((assertion) => assertion.passed)
        : errorCode === undefined;
    if (result.passed !== stepShouldPass) {
      throw bundleError(
        `scenario report step ${index} outcome is inconsistent with its assertions and error`,
        "regenerate the report from the supplied scenario",
      );
    }
    return {
      index,
      iteration,
      action: result.action,
      passed: result.passed,
      assertions,
      ...(errorCode ? { errorCode } : {}),
    };
  });
  return {
    format: "fiber-forge-scenario-report",
    version: 1,
    scenarioVersion: 1,
    network,
    passed: report.passed,
    summary: { ...report.summary },
    steps,
  };
}

function assertPortableScenario(scenario: Scenario, topology: Topology): void {
  const names = new Set(topology.nodes.map((node) => node.name));
  const requireNode = (name: string, label: string) => {
    if (!names.has(name)) {
      throw bundleError(
        `${label} references node "${name}" outside the bundled topology`,
        "fix the scenario node reference and retry",
      );
    }
  };
  let declaredDelayMs = 0;
  for (const [index, step] of scenario.steps.entries()) {
    const action = step.action;
    if (action.type === "close") {
      throw bundleError(
        `scenario step ${index} closes a source-specific channel id`,
        "replace the close with a portable node/peer workflow before export",
      );
    }
    if (action.type === "assert" && action.assertion.type === "channel_state") {
      throw bundleError(
        `scenario step ${index} uses a source-specific channel selector`,
        "use portable node, payment, error, or balance assertions in replay bundles",
      );
    }
    switch (action.type) {
      case "pay":
      case "open":
        requireNode(action.from, `scenario step ${index}`);
        requireNode(action.to, `scenario step ${index}`);
        break;
      case "fund":
      case "invoice":
      case "node":
        requireNode(action.node, `scenario step ${index}`);
        break;
      case "fault":
        if (action.target) requireNode(action.target, `scenario step ${index}`);
        break;
      case "assert":
        requireNode(action.assertion.node, `scenario step ${index}`);
        declaredDelayMs += action.assertion.timeoutMs;
        break;
      case "wait":
        declaredDelayMs += action.durationMs;
        break;
    }
    if (step.expect?.type === "node_status") {
      declaredDelayMs += step.expect.timeoutMs;
    }
  }
  const executions = scenario.steps.length * scenario.loop;
  if (executions > MAX_REPLAY_EXECUTIONS) {
    throw bundleError(
      `replay scenario expands to ${executions} steps; the limit is ${MAX_REPLAY_EXECUTIONS}`,
      "reduce the scenario loop or number of steps",
    );
  }
  if (declaredDelayMs * scenario.loop > MAX_REPLAY_DECLARED_DELAY_MS) {
    throw bundleError(
      `replay scenario declares more than ${MAX_REPLAY_DECLARED_DELAY_MS}ms of waits and polling`,
      "reduce waits and assertion timeouts",
    );
  }
}

function sanitizeText(value: string, privatePaths: string[] = []): string {
  let text = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const replacements: [RegExp, string][] = [
    [
      /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi,
      "[REDACTED PRIVATE KEY]",
    ],
    [/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]"],
    [
      /\b([A-Za-z0-9_]*(?:password|passwd|private[_ -]?key|secret|token)[A-Za-z0-9_]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "[REDACTED CREDENTIAL]",
    ],
    [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}\b/g, "[REDACTED TOKEN]"],
    [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
    [/\b0x[0-9a-f]{64,}\b/gi, "[REDACTED HEX]"],
    [/\b[0-9a-f]{64,}\b/gi, "[REDACTED HEX]"],
    [/\b[A-Za-z0-9+/]{48,}={0,2}\b/g, "[REDACTED BASE64]"],
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  for (const path of [homedir(), process.cwd(), ...privatePaths]) {
    const absolute = resolve(path);
    if (absolute.length > 1)
      text = text.replaceAll(absolute, "[REDACTED PATH]");
  }
  return text;
}

function truncateTailUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return value;
  const marker = "[truncated]\n";
  const tail = bytes.subarray(
    bytes.length - (limit - Buffer.byteLength(marker)),
  );
  return marker + tail.toString("utf8").replace(/^\uFFFD+/, "");
}

function sanitizeUnknown(value: unknown, privatePaths: string[]): unknown {
  if (typeof value === "string") return sanitizeText(value, privatePaths);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknown(entry, privatePaths));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /(?:password|passwd|private[_ -]?key|secret|token)/i.test(key)
          ? "[REDACTED CREDENTIAL]"
          : sanitizeUnknown(entry, privatePaths),
      ]),
    );
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  return String(value);
}

function assertNoSecrets(path: string, bytes: Buffer): void {
  const value = bytes.toString("utf8");
  const patterns: [RegExp, string][] = [
    [/-----BEGIN [^-\n]*PRIVATE KEY-----/i, "private-key block"],
    [/FIBER_SECRET_KEY_PASSWORD/i, "Fiber key password"],
    [
      /"(?:password|passwd|privateKey|private_key|secret|token)"\s*:\s*"(?!\[REDACTED)[^"]+"/i,
      "credential field",
    ],
    [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}\b/, "GitHub token"],
    [/\bBearer\s+(?!\[REDACTED\])[^\s,;]+/i, "bearer token"],
    [/\b0x[0-9a-f]{64,}\b/i, "long hexadecimal value"],
    [
      /(?:^|[\s="'(])\/(?:Users|home|private|run\/user|var\/lib)\//m,
      "absolute host path",
    ],
    [/(?:ckb\/key|fiber\/sk|fiber\/store)/i, "private persisted-state path"],
    [
      /\b([A-Za-z0-9_]*(?:password|passwd|private[_ -]?key|secret|token)[A-Za-z0-9_]*)(\s*[:=]\s*)(?!(?:["']?)\[REDACTED)(?:"[^"]*"|'[^']*'|[^\s,;]+)/i,
      "credential value",
    ],
    [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/i, "URL credentials"],
    [/\b[0-9a-f]{64,}\b/i, "long hexadecimal value"],
    [/\b[A-Za-z0-9+/]{48,}={0,2}\b/, "long base64 value"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(value)) {
      throw bundleError(
        `${path} still contains a ${label} after sanitization`,
        "remove or redact the sensitive value before exporting",
      );
    }
  }
}

function artifactRole(path: string): {
  role: BundleArtifactRole;
  mediaType: BundleArtifactManifest["mediaType"];
} {
  const fixed: Record<
    string,
    {
      role: BundleArtifactRole;
      mediaType: BundleArtifactManifest["mediaType"];
    }
  > = {
    "topology.json": { role: "topology", mediaType: "application/json" },
    "scenario.json": { role: "scenario", mediaType: "application/json" },
    "report.json": {
      role: "scenario-report",
      mediaType: "application/json",
    },
    "diagnostics/network.json": {
      role: "network-inspection",
      mediaType: "application/json",
    },
    "diagnostics/channels.json": {
      role: "channel-inspection",
      mediaType: "application/json",
    },
    "diagnostics/faults.json": {
      role: "fault-inspection",
      mediaType: "application/json",
    },
    "diagnostics/logs/ckb.log": { role: "ckb-log", mediaType: "text/plain" },
  };
  if (fixed[path]) return fixed[path];
  if (NODE_LOG_PATH.test(path)) {
    return { role: "node-log", mediaType: "text/plain" };
  }
  throw bundleError(
    `archive path "${path}" is not allowed`,
    "remove the unexpected archive entry",
  );
}

function buildDiagnostics(input: BundleDiagnostics): Map<string, Buffer> {
  const privatePaths = input.privatePaths ?? [];
  const files = new Map<string, Buffer>([
    [
      "diagnostics/network.json",
      prettyJson(sanitizeUnknown(input.network, privatePaths)),
    ],
    [
      "diagnostics/channels.json",
      prettyJson(sanitizeUnknown(input.channels, privatePaths)),
    ],
    [
      "diagnostics/faults.json",
      prettyJson(sanitizeUnknown(input.faults, privatePaths)),
    ],
  ]);
  let totalLogBytes = 0;
  for (const [name, raw] of Object.entries(input.logs).sort(([a], [b]) =>
    compareAscii(a, b),
  )) {
    const path = `diagnostics/logs/${name}.log`;
    artifactRole(path);
    const sanitized = sanitizeText(raw, privatePaths);
    const bounded = Buffer.from(
      truncateTailUtf8(sanitized, MAX_BUNDLE_LOG_BYTES),
      "utf8",
    );
    totalLogBytes += bounded.length;
    if (totalLogBytes > MAX_BUNDLE_LOG_TOTAL_BYTES) {
      throw bundleError(
        `diagnostic logs exceed the ${MAX_BUNDLE_LOG_TOTAL_BYTES}-byte aggregate limit`,
        "reduce the diagnostic log set and retry",
      );
    }
    files.set(path, bounded.length > 0 ? bounded : Buffer.from("[no logs]\n"));
  }
  return files;
}

function sourceHost(input: BundleSourceHost): ExportManifest["sourceHost"] {
  return {
    os: input.os ?? osType(),
    architecture: input.architecture ?? arch(),
    node: input.node ?? process.version,
    docker: input.docker || "unknown",
  };
}

function recipeDigest(
  artifacts: BundleArtifactManifest[],
  images: ExportManifest["runtime"]["images"],
): string {
  const byRole = new Map(
    artifacts.map((artifact) => [artifact.role, artifact]),
  );
  return sha256(
    canonicalJson({
      schemaMajor: BUNDLE_SCHEMA_VERSION.major,
      images,
      topology: byRole.get("topology")?.sha256,
      scenario: byRole.get("scenario")?.sha256,
    }),
  );
}

function artifactManifests(
  files: Map<string, Buffer>,
): BundleArtifactManifest[] {
  return [...files.entries()]
    .sort(([left], [right]) => compareAscii(left, right))
    .map(([path, bytes]) => {
      if (bytes.length < 1 || bytes.length > MAX_BUNDLE_ENTRY_BYTES) {
        throw bundleError(
          `${path} has ${bytes.length} bytes; entries must contain 1-${MAX_BUNDLE_ENTRY_BYTES} bytes`,
          "reduce the artifact size and retry",
        );
      }
      const identity = artifactRole(path);
      assertNoSecrets(path, bytes);
      return {
        path,
        role: identity.role,
        mediaType: identity.mediaType,
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
    });
}

function writeString(
  target: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.length > length) {
    throw bundleError(
      `tar field "${value}" exceeds ${length} bytes`,
      "use shorter bundle artifact names",
    );
  }
  bytes.copy(target, offset);
}

function writeOctal(
  target: Buffer,
  value: number,
  offset: number,
  length: number,
): void {
  const octal = value.toString(8).padStart(length - 1, "0") + "\0";
  if (octal.length > length) {
    throw bundleError(
      `tar numeric value ${value} exceeds its field`,
      "reduce the bundle size and retry",
    );
  }
  writeString(target, octal, offset, length);
}

function tarHeader(path: string, bytes: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  writeString(header, path, 0, 100);
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, bytes, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  writeString(header, "0", 156, 1);
  writeString(header, "ustar\0", 257, 6);
  writeString(header, "00", 263, 2);
  const sum = header.reduce((total, byte) => total + byte, 0);
  writeString(header, sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return header;
}

/** Build the deterministic gzip/USTAR bytes for a manifest and its declared artifact files. */
export function buildBundleArchive(
  manifest: ExportManifest,
  artifactFiles: ReadonlyMap<string, Buffer>,
): Buffer {
  const entries = new Map<string, Buffer>([
    ["manifest.json", prettyJson(manifest)],
    ...[...artifactFiles.entries()].sort(([left], [right]) =>
      compareAscii(left, right),
    ),
  ]);
  const blocks: Buffer[] = [];
  for (const [path, content] of entries) {
    blocks.push(tarHeader(path, content.length), content);
    const padding =
      (TAR_BLOCK_BYTES - (content.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  const tar = Buffer.concat(blocks);
  if (tar.length > MAX_BUNDLE_EXPANDED_BYTES) {
    throw bundleError(
      `expanded bundle has ${tar.length} bytes; the limit is ${MAX_BUNDLE_EXPANDED_BYTES}`,
      "reduce diagnostics and retry",
    );
  }
  const archive = gzipSync(tar, { level: 9 });
  if (archive.length > MAX_BUNDLE_BYTES) {
    throw bundleError(
      `compressed bundle has ${archive.length} bytes; the limit is ${MAX_BUNDLE_BYTES}`,
      "reduce diagnostics and retry",
    );
  }
  return archive;
}

export function createExportBundle(input: BundleBuildInput): {
  archive: Buffer;
  manifest: ExportManifest;
} {
  const scenario = parseScenarioInput(input.scenario);
  assertPortableScenario(scenario, input.topology);
  const report = portableReport(input.report, scenario, input.topology.name);
  const files = new Map<string, Buffer>([
    ["topology.json", prettyJson(topologyDocument(input.topology))],
    ["scenario.json", prettyJson(scenarioDocument(scenario))],
    ["report.json", prettyJson(report)],
  ]);
  if (input.diagnostics) {
    for (const [path, bytes] of buildDiagnostics(input.diagnostics)) {
      files.set(path, bytes);
    }
  }
  const artifacts = artifactManifests(files);
  const images = { ...runtimeImages };
  const manifest = validateManifest({
    format: "fiber-forge-export",
    schema: { ...BUNDLE_SCHEMA_VERSION },
    level: input.diagnostics ? "diagnostic" : "recipe",
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    generator: { package: packageName, version: packageVersion },
    runtime: { images },
    sourceHost: sourceHost(input.sourceHost),
    capabilities: { exactStateRestore: false, containsSecrets: false },
    recipeDigest: recipeDigest(artifacts, images),
    artifacts,
  });
  return { archive: buildBundleArchive(manifest, files), manifest };
}

export async function writeExportBundle(
  input: BundleBuildInput & { output: string },
): Promise<ExportBundleResult> {
  const { archive, manifest } = createExportBundle(input);
  const output = resolve(input.output);
  let created = false;
  let createdIdentity: { dev: number; ino: number } | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(output, "wx", 0o644);
    created = true;
    const createdInfo = await handle.stat();
    createdIdentity = { dev: createdInfo.dev, ino: createdInfo.ino };
    await handle.writeFile(archive);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (created) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      const current = await lstat(output).catch(() => undefined);
      if (
        current &&
        current.dev === createdIdentity?.dev &&
        current.ino === createdIdentity?.ino
      ) {
        await rm(output, { force: true }).catch(() => undefined);
      }
    }
    throw new ForgeError(
      code === "EEXIST" ? "BUNDLE_OUTPUT_EXISTS" : "BUNDLE_INVALID",
      code === "EEXIST"
        ? `bundle output already exists at "${output}"`
        : `could not write bundle output at "${output}": ${errorDetails(error).message}`,
      {
        resource: output,
        action:
          code === "EEXIST"
            ? "choose a new output path or remove the existing file explicitly"
            : "fix the output directory permissions and retry",
        cause: error,
      },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return {
    output,
    bytes: archive.length,
    level: manifest.level,
    recipeDigest: manifest.recipeDigest,
    artifacts: manifest.artifacts.length,
  };
}

function fieldString(
  header: Buffer,
  offset: number,
  length: number,
  label: string,
): string {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const content = nul === -1 ? field : field.subarray(0, nul);
  const remainder = nul === -1 ? Buffer.alloc(0) : field.subarray(nul + 1);
  if ([...remainder].some((byte) => byte !== 0)) {
    throw bundleError(
      `tar ${label} contains data after its NUL terminator`,
      "recreate the bundle with the Fiber Forge exporter",
    );
  }
  if ([...content].some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw bundleError(
      `tar ${label} is not printable ASCII`,
      "recreate the bundle with ASCII artifact names",
    );
  }
  return content.toString("ascii");
}

function octalField(
  header: Buffer,
  offset: number,
  length: number,
  label: string,
): number {
  const raw = header
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/[\0 ]+$/g, "")
    .replace(/^ +/g, "");
  if (!/^[0-7]+$/.test(raw)) {
    throw bundleError(
      `tar ${label} is not a valid octal field`,
      "recreate the bundle with the Fiber Forge exporter",
    );
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) {
    throw bundleError(
      `tar ${label} exceeds the safe integer range`,
      "reduce the archive entry size",
    );
  }
  return value;
}

function zeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function validateArchivePath(path: string): void {
  if (
    path.length === 0 ||
    Buffer.byteLength(path, "ascii") !== Buffer.byteLength(path, "utf8") ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..") ||
    (path !== "manifest.json" && !ARTIFACT_PATH.test(path))
  ) {
    throw bundleError(
      `archive path "${path}" is unsafe or unsupported`,
      "remove traversal, alternate separators, or unexpected entries",
    );
  }
}

function readTarEntries(tar: Buffer): Map<string, Buffer> {
  if (tar.length > MAX_BUNDLE_EXPANDED_BYTES) {
    throw bundleError(
      `expanded archive exceeds ${MAX_BUNDLE_EXPANDED_BYTES} bytes`,
      "use a smaller Fiber Forge bundle",
    );
  }
  if (tar.length % TAR_BLOCK_BYTES !== 0) {
    throw bundleError(
      "tar length is not aligned to a 512-byte block",
      "recreate the bundle with the Fiber Forge exporter",
    );
  }
  const entries = new Map<string, Buffer>();
  const folded = new Set<string>();
  let offset = 0;
  let terminators = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (zeroBlock(header)) {
      terminators += 1;
      offset += TAR_BLOCK_BYTES;
      if (terminators === 2) break;
      continue;
    }
    if (terminators > 0) {
      throw bundleError(
        "tar contains an entry after an end marker",
        "recreate the bundle with the Fiber Forge exporter",
      );
    }
    if (entries.size >= MAX_BUNDLE_ENTRIES) {
      throw bundleError(
        `archive contains more than ${MAX_BUNDLE_ENTRIES} entries`,
        "reduce the bundle entry count",
      );
    }
    const checksum = octalField(header, 148, 8, "checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const observed = checksumHeader.reduce((total, byte) => total + byte, 0);
    if (checksum !== observed) {
      throw bundleError(
        "tar header checksum is invalid",
        "download or export the bundle again",
      );
    }
    const path = fieldString(header, 0, 100, "name");
    validateArchivePath(path);
    const lower = path.toLowerCase();
    if (entries.has(path) || folded.has(lower)) {
      throw bundleError(
        `archive contains a duplicate or case-colliding path "${path}"`,
        "remove duplicate entries and retry",
      );
    }
    if (fieldString(header, 345, 155, "prefix") !== "") {
      throw bundleError(
        `archive entry "${path}" uses an unsupported tar prefix`,
        "recreate the bundle with short Fiber Forge artifact names",
      );
    }
    if (
      fieldString(header, 257, 6, "magic") !== "ustar" ||
      fieldString(header, 263, 2, "version") !== "00"
    ) {
      throw bundleError(
        `archive entry "${path}" is not POSIX USTAR`,
        "recreate the bundle with the Fiber Forge exporter",
      );
    }
    const type = fieldString(header, 156, 1, "type");
    if (type !== "0") {
      throw bundleError(
        `archive entry "${path}" is not a regular file`,
        "remove links, devices, directories, and tar extensions",
      );
    }
    if (fieldString(header, 157, 100, "link name") !== "") {
      throw bundleError(
        `archive entry "${path}" contains a link target`,
        "remove links from the archive",
      );
    }
    const mode = octalField(header, 100, 8, "mode");
    if ((mode & 0o111) !== 0) {
      throw bundleError(
        `archive entry "${path}" has executable mode bits`,
        "store bundle artifacts as non-executable regular files",
      );
    }
    for (const [fieldOffset, fieldLength, fieldLabel] of [
      [108, 8, "uid"],
      [116, 8, "gid"],
      [136, 12, "mtime"],
    ] as const) {
      if (octalField(header, fieldOffset, fieldLength, fieldLabel) !== 0) {
        throw bundleError(
          `archive entry "${path}" has unsupported ${fieldLabel} metadata`,
          "recreate the bundle with the Fiber Forge exporter",
        );
      }
    }
    if (!zeroBlock(header.subarray(329, 345))) {
      throw bundleError(
        `archive entry "${path}" has unsupported device metadata`,
        "recreate the bundle with the Fiber Forge exporter",
      );
    }
    for (const [fieldOffset, fieldLength, fieldLabel] of [
      [265, 32, "user name"],
      [297, 32, "group name"],
    ] as const) {
      if (fieldString(header, fieldOffset, fieldLength, fieldLabel) !== "") {
        throw bundleError(
          `archive entry "${path}" has unsupported ${fieldLabel} metadata`,
          "recreate the bundle with the Fiber Forge exporter",
        );
      }
    }
    if (!zeroBlock(header.subarray(500))) {
      throw bundleError(
        `archive entry "${path}" has unsupported tar header data`,
        "recreate the bundle with the Fiber Forge exporter",
      );
    }
    const size = octalField(header, 124, 12, "size");
    if (size < 1 || size > MAX_BUNDLE_ENTRY_BYTES) {
      throw bundleError(
        `archive entry "${path}" has unsupported size ${size}`,
        "reduce the entry to the documented limit",
      );
    }
    if (path === "manifest.json" && size > MAX_BUNDLE_MANIFEST_BYTES) {
      throw bundleError(
        `manifest exceeds ${MAX_BUNDLE_MANIFEST_BYTES} bytes`,
        "reduce the manifest to the version-1 schema",
      );
    }
    const start = offset + TAR_BLOCK_BYTES;
    const end = start + size;
    if (end > tar.length) {
      throw bundleError(
        `archive entry "${path}" is truncated`,
        "download or export the bundle again",
      );
    }
    entries.set(path, Buffer.from(tar.subarray(start, end)));
    folded.add(lower);
    const paddedEnd =
      start + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (!zeroBlock(tar.subarray(end, paddedEnd))) {
      throw bundleError(
        `archive entry "${path}" has non-zero padding data`,
        "recreate the bundle with the Fiber Forge exporter",
      );
    }
    offset = paddedEnd;
  }
  if (terminators !== 2) {
    throw bundleError(
      "tar archive does not end with two zero blocks",
      "recreate the bundle with the Fiber Forge exporter",
    );
  }
  if (!zeroBlock(tar.subarray(offset))) {
    throw bundleError(
      "tar archive contains non-zero trailing data",
      "remove appended data and retry",
    );
  }
  return entries;
}

function readBoundedString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  maximum = 128,
): string {
  return boundedString(record[key], maximum, `${label}.${key}`);
}

function validateArtifactManifest(
  value: unknown,
  index: number,
): BundleArtifactManifest {
  const label = `manifest.artifacts[${index}]`;
  const artifact = requiredRecord(value, label);
  keysAre(artifact, ["path", "role", "mediaType", "bytes", "sha256"], label);
  const path = readBoundedString(artifact, "path", label, 240);
  validateArchivePath(path);
  if (path === "manifest.json") {
    throw bundleError(
      "manifest.json cannot declare itself as an artifact",
      "remove manifest.json from the artifact list",
    );
  }
  const identity = artifactRole(path);
  if (
    artifact.role !== identity.role ||
    artifact.mediaType !== identity.mediaType
  ) {
    throw bundleError(
      `${label} role or media type does not match "${path}"`,
      "use the fixed version-1 role and media type for that path",
    );
  }
  const bytes = finiteInteger(
    artifact.bytes,
    1,
    MAX_BUNDLE_ENTRY_BYTES,
    `${label}.bytes`,
  );
  const digest = readBoundedString(artifact, "sha256", label, 71);
  if (!DIGEST_PATTERN.test(digest)) {
    throw bundleError(
      `${label}.sha256 is not a lowercase SHA-256 digest`,
      "recompute the artifact hash",
    );
  }
  return {
    path,
    role: identity.role,
    mediaType: identity.mediaType,
    bytes,
    sha256: digest,
  };
}

function validateManifest(value: unknown): ExportManifest {
  const root = requiredRecord(value, "manifest");
  keysAre(
    root,
    [
      "format",
      "schema",
      "level",
      "createdAt",
      "generator",
      "runtime",
      "sourceHost",
      "capabilities",
      "recipeDigest",
      "artifacts",
    ],
    "manifest",
  );
  if (root.format !== "fiber-forge-export") {
    throw bundleError(
      "manifest format is not fiber-forge-export",
      "select a Fiber Forge .ffbundle file",
    );
  }
  const schema = requiredRecord(root.schema, "manifest.schema");
  keysAre(schema, ["major", "minor"], "manifest.schema");
  if (schema.major !== 1) {
    throw new ForgeError(
      "BUNDLE_INCOMPATIBLE",
      `bundle schema major ${String(schema.major)} is unsupported; this release supports major 1`,
      {
        resource: "manifest.schema.major",
        action: "use a compatible Fiber Forge release or re-export the bundle",
      },
    );
  }
  if (schema.minor !== 0) {
    throw new ForgeError(
      "BUNDLE_INCOMPATIBLE",
      `bundle schema minor ${String(schema.minor)} is newer than supported minor 0`,
      {
        resource: "manifest.schema.minor",
        action: "upgrade Fiber Forge or re-export with schema 1.0",
      },
    );
  }
  if (root.level !== "recipe" && root.level !== "diagnostic") {
    throw bundleError(
      "manifest.level must be recipe or diagnostic",
      "use a supported bundle level",
    );
  }
  const createdAt = boundedString(root.createdAt, 64, "manifest.createdAt");
  let normalizedCreatedAt = "";
  try {
    normalizedCreatedAt = new Date(createdAt).toISOString();
  } catch {
    // Report the stable bundle validation error below.
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
    normalizedCreatedAt !== createdAt
  ) {
    throw bundleError(
      "manifest.createdAt must be a UTC ISO-8601 timestamp",
      "recreate the bundle with the Fiber Forge exporter",
    );
  }
  const generator = requiredRecord(root.generator, "manifest.generator");
  keysAre(generator, ["package", "version"], "manifest.generator");
  const generatorPackage = readBoundedString(
    generator,
    "package",
    "manifest.generator",
    128,
  );
  const generatorVersion = readBoundedString(
    generator,
    "version",
    "manifest.generator",
    64,
  );
  if (!VERSION_PATTERN.test(generatorVersion)) {
    throw bundleError(
      "manifest.generator.version is not a supported semantic version",
      "recreate the bundle with a released Fiber Forge version",
    );
  }
  const runtime = requiredRecord(root.runtime, "manifest.runtime");
  keysAre(runtime, ["images"], "manifest.runtime");
  const images = requiredRecord(runtime.images, "manifest.runtime.images");
  keysAre(images, ["ckb", "fiber"], "manifest.runtime.images");
  const ckb = readBoundedString(images, "ckb", "manifest.runtime.images", 256);
  const fiber = readBoundedString(
    images,
    "fiber",
    "manifest.runtime.images",
    256,
  );
  if (!IMAGE_PATTERN.test(ckb) || !IMAGE_PATTERN.test(fiber)) {
    throw bundleError(
      "manifest runtime image references are invalid",
      "use exact tagged image references without commands or whitespace",
    );
  }
  const host = requiredRecord(root.sourceHost, "manifest.sourceHost");
  keysAre(
    host,
    ["os", "architecture", "node", "docker"],
    "manifest.sourceHost",
  );
  const validatedHost = {
    os: readBoundedString(host, "os", "manifest.sourceHost"),
    architecture: readBoundedString(
      host,
      "architecture",
      "manifest.sourceHost",
    ),
    node: readBoundedString(host, "node", "manifest.sourceHost"),
    docker: readBoundedString(host, "docker", "manifest.sourceHost"),
  };
  const capabilities = requiredRecord(
    root.capabilities,
    "manifest.capabilities",
  );
  keysAre(
    capabilities,
    ["exactStateRestore", "containsSecrets"],
    "manifest.capabilities",
  );
  if (
    capabilities.exactStateRestore !== false ||
    capabilities.containsSecrets !== false
  ) {
    throw bundleError(
      "manifest requests unsupported secrets or exact-state capabilities",
      "use a recipe or bounded diagnostic bundle without node state",
    );
  }
  const digest = boundedString(root.recipeDigest, 71, "manifest.recipeDigest");
  if (!DIGEST_PATTERN.test(digest)) {
    throw bundleError(
      "manifest.recipeDigest is invalid",
      "recompute the recipe digest",
    );
  }
  if (!Array.isArray(root.artifacts)) {
    throw bundleError(
      "manifest.artifacts must be an array",
      "recreate the manifest with the Fiber Forge exporter",
    );
  }
  if (root.artifacts.length < 3 || root.artifacts.length > 63) {
    throw bundleError(
      "manifest must declare 3-63 artifacts",
      "include the required recipe files and reduce diagnostics",
    );
  }
  const artifacts = root.artifacts.map(validateArtifactManifest);
  const paths = artifacts.map((artifact) => artifact.path);
  if (!isDeepStrictEqual(paths, [...paths].sort(compareAscii))) {
    throw bundleError(
      "manifest artifacts are not ordered by path",
      "recreate the bundle with deterministic artifact ordering",
    );
  }
  if (new Set(paths).size !== paths.length) {
    throw bundleError(
      "manifest declares a duplicate artifact path",
      "remove duplicate artifact declarations",
    );
  }
  for (const role of ["topology", "scenario", "scenario-report"] as const) {
    if (artifacts.filter((artifact) => artifact.role === role).length !== 1) {
      throw bundleError(
        `manifest must contain exactly one ${role} artifact`,
        "include one complete recipe in the bundle",
      );
    }
  }
  if (
    root.level === "recipe" &&
    artifacts.some((artifact) => artifact.path.startsWith("diagnostics/"))
  ) {
    throw bundleError(
      "recipe-level manifest declares diagnostic artifacts",
      "set level to diagnostic or remove diagnostics",
    );
  }
  if (
    root.level === "diagnostic" &&
    !artifacts.some((artifact) => artifact.path.startsWith("diagnostics/"))
  ) {
    throw bundleError(
      "diagnostic-level manifest contains no diagnostic artifact",
      "include bounded diagnostics or set level to recipe",
    );
  }
  const manifest: ExportManifest = {
    format: "fiber-forge-export",
    schema: { major: 1, minor: 0 },
    level: root.level,
    createdAt,
    generator: { package: generatorPackage, version: generatorVersion },
    runtime: { images: { ckb, fiber } },
    sourceHost: validatedHost,
    capabilities: { exactStateRestore: false, containsSecrets: false },
    recipeDigest: digest,
    artifacts,
  };
  const manifestForScan = JSON.stringify(manifest).replace(
    /sha256:[0-9a-f]{64}/g,
    "sha256:[digest]",
  );
  assertNoSecrets("manifest.json", Buffer.from(manifestForScan));
  return manifest;
}

function assertTopologyShape(value: unknown): void {
  const root = requiredRecord(value, "topology.json");
  keysAre(root, ["name", "nodes", "channels", "funding"], "topology.json");
  if (!Array.isArray(root.nodes) || !Array.isArray(root.channels)) {
    throw bundleError(
      "topology.json nodes and channels must be arrays",
      "recreate the bundle with a validated topology",
    );
  }
  root.nodes.forEach((node, index) => {
    keysAre(
      requiredRecord(node, `topology.nodes[${index}]`),
      ["name"],
      `topology.nodes[${index}]`,
    );
  });
  root.channels.forEach((channel, index) => {
    keysAre(
      requiredRecord(channel, `topology.channels[${index}]`),
      ["from", "to", "capacity_ckb"],
      `topology.channels[${index}]`,
    );
  });
  keysAre(
    requiredRecord(root.funding, "topology.funding"),
    ["per_node_ckb"],
    "topology.funding",
  );
}

function compatibility(manifest: ExportManifest): BundleCompatibility {
  const reasons: string[] = [];
  const packageStatus =
    manifest.generator.package === packageName &&
    manifest.generator.version === packageVersion
      ? "supported"
      : "mismatch";
  if (packageStatus === "mismatch") {
    reasons.push(
      `bundle requires ${manifest.generator.package}@${manifest.generator.version}; installed package is ${packageName}@${packageVersion}`,
    );
  }
  const imageStatus = isDeepStrictEqual(manifest.runtime.images, runtimeImages)
    ? "supported"
    : "mismatch";
  if (imageStatus === "mismatch") {
    reasons.push(
      "bundle image references do not match the installed package pins",
    );
  }
  const hostSupported =
    (platform() === "darwin" && arch() === "arm64") ||
    (platform() === "linux" && ["x64", "amd64"].includes(arch()));
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const hostStatus =
    hostSupported && nodeMajor >= 20 ? "supported" : "unsupported";
  if (hostStatus === "unsupported") {
    reasons.push(
      `target ${platform()}/${arch()} on Node ${process.versions.node} is outside the supported replay hosts`,
    );
  }
  return {
    package: packageStatus,
    images: imageStatus,
    host: hostStatus,
    replayable:
      packageStatus === "supported" &&
      imageStatus === "supported" &&
      hostStatus === "supported",
    reasons,
  };
}

async function readArchive(path: string): Promise<Map<string, Buffer>> {
  const absolute = resolve(path);
  let pathInfo;
  try {
    pathInfo = await lstat(absolute);
  } catch (error) {
    throw bundleError(
      `could not read bundle "${absolute}": ${errorDetails(error).message}`,
      "choose an existing regular .ffbundle file",
    );
  }
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw bundleError(
      `bundle input "${absolute}" is not a regular file`,
      "replace links and special files with a regular .ffbundle file",
    );
  }
  if (pathInfo.size < 1 || pathInfo.size > MAX_BUNDLE_BYTES) {
    throw bundleError(
      `bundle input has ${pathInfo.size} bytes; the limit is ${MAX_BUNDLE_BYTES}`,
      "choose a bounded Fiber Forge bundle",
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, "r");
  } catch (error) {
    throw bundleError(
      `could not open bundle "${absolute}": ${errorDetails(error).message}`,
      "choose a readable regular .ffbundle file",
    );
  }
  let compressed: Buffer;
  try {
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== pathInfo.dev ||
      openedInfo.ino !== pathInfo.ino ||
      openedInfo.size !== pathInfo.size
    ) {
      throw bundleError(
        `bundle input "${absolute}" changed while it was being opened`,
        "retry with a stable regular .ffbundle file",
      );
    }
    compressed = Buffer.alloc(openedInfo.size);
    let readOffset = 0;
    while (readOffset < compressed.length) {
      const { bytesRead } = await handle.read(
        compressed,
        readOffset,
        compressed.length - readOffset,
        readOffset,
      );
      if (bytesRead === 0) break;
      readOffset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(
      extra,
      0,
      1,
      compressed.length,
    );
    const finalInfo = await handle.stat();
    if (
      readOffset !== compressed.length ||
      extraBytes !== 0 ||
      finalInfo.size !== openedInfo.size
    ) {
      throw bundleError(
        `bundle input "${absolute}" changed while it was being read`,
        "retry with a stable regular .ffbundle file",
      );
    }
  } finally {
    await handle.close();
  }
  if (
    compressed.length < 18 ||
    compressed[0] !== 0x1f ||
    compressed[1] !== 0x8b ||
    compressed[2] !== 8 ||
    compressed[3] !== 0
  ) {
    throw bundleError(
      "bundle is not a canonical gzip stream",
      "recreate the bundle with the Fiber Forge exporter",
    );
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(compressed, {
      maxOutputLength: MAX_BUNDLE_EXPANDED_BYTES,
    });
  } catch (error) {
    throw bundleError(
      `bundle gzip stream is invalid or expands past ${MAX_BUNDLE_EXPANDED_BYTES} bytes: ${errorDetails(error).message}`,
      "download or export the bundle again",
    );
  }
  return readTarEntries(tar);
}

export async function loadBundle(path: string): Promise<LoadedBundle> {
  const entries = await readArchive(path);
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) {
    throw bundleError(
      "archive does not contain manifest.json",
      "select a complete Fiber Forge bundle",
    );
  }
  const manifest = validateManifest(
    strictJson(manifestBytes.toString("utf8"), "manifest.json"),
  );
  const declared = new Set(manifest.artifacts.map((artifact) => artifact.path));
  const archived = [...entries.keys()].filter(
    (entry) => entry !== "manifest.json",
  );
  if (
    archived.length !== declared.size ||
    archived.some((entry) => !declared.has(entry))
  ) {
    throw bundleError(
      "archive entries do not exactly match the manifest artifact list",
      "remove undeclared entries and restore every declared artifact",
    );
  }
  let logBytes = 0;
  for (const artifact of manifest.artifacts) {
    const bytes = entries.get(artifact.path);
    if (!bytes) {
      throw bundleError(
        `declared artifact "${artifact.path}" is missing`,
        "download or export the bundle again",
      );
    }
    if (bytes.length !== artifact.bytes) {
      throw bundleError(
        `artifact "${artifact.path}" byte count does not match its manifest`,
        "download or export the bundle again",
      );
    }
    const observed = sha256(bytes);
    if (!digestMatches(observed, artifact.sha256)) {
      throw bundleError(
        `artifact "${artifact.path}" failed its SHA-256 check`,
        "download or export the bundle again",
      );
    }
    if (artifact.mediaType === "application/json") {
      strictJson(bytes.toString("utf8"), artifact.path);
    }
    if (artifact.mediaType === "text/plain") {
      if (bytes.length > MAX_BUNDLE_LOG_BYTES) {
        throw bundleError(
          `log artifact "${artifact.path}" exceeds ${MAX_BUNDLE_LOG_BYTES} bytes`,
          "reduce the diagnostic log tail",
        );
      }
      logBytes += bytes.length;
    }
    assertNoSecrets(artifact.path, bytes);
  }
  if (logBytes > MAX_BUNDLE_LOG_TOTAL_BYTES) {
    throw bundleError(
      `diagnostic logs exceed ${MAX_BUNDLE_LOG_TOTAL_BYTES} bytes in aggregate`,
      "reduce the diagnostic log set",
    );
  }
  const expectedRecipeDigest = recipeDigest(
    manifest.artifacts,
    manifest.runtime.images,
  );
  if (!digestMatches(expectedRecipeDigest, manifest.recipeDigest)) {
    throw bundleError(
      "manifest recipeDigest does not match its topology and scenario hashes",
      "download or export the bundle again",
    );
  }

  const topologyRaw = strictJson(
    entries.get("topology.json")!.toString("utf8"),
    "topology.json",
  );
  assertTopologyShape(topologyRaw);
  const topology = parseTopology(JSON.stringify(topologyRaw));
  const scenarioRaw = strictJson(
    entries.get("scenario.json")!.toString("utf8"),
    "scenario.json",
  );
  const scenario = parseScenario(JSON.stringify(scenarioRaw));
  if (
    scenario.steps.some(
      (step) =>
        (step.action.type === "pay" || step.action.type === "invoice") &&
        step.action.description !== undefined,
    )
  ) {
    throw bundleError(
      "scenario.json contains a description that export must omit",
      "remove free-form descriptions and re-export",
    );
  }
  assertPortableScenario(scenario, topology);
  const report = portableReport(
    entries.get("report.json")!.toString("utf8"),
    scenario,
    topology.name,
  );
  const bundleCompatibility = compatibility(manifest);
  const inspection: BundleInspection = {
    format: manifest.format,
    schema: manifest.schema,
    level: manifest.level,
    createdAt: manifest.createdAt,
    recipeDigest: manifest.recipeDigest,
    generator: manifest.generator,
    runtime: manifest.runtime,
    sourceHost: manifest.sourceHost,
    capabilities: manifest.capabilities,
    integrity: "verified",
    redaction: "verified",
    artifacts: manifest.artifacts,
    recipe: {
      network: topology.name,
      nodes: topology.nodes.map((node) => node.name),
      channels: topology.channels.length,
      executions: scenario.steps.length * scenario.loop,
      expectedPassed: report.passed,
    },
    compatibility: bundleCompatibility,
  };
  return { manifest, topology, scenario, report, inspection };
}

/** Inspect and fully validate a bundle without contacting Docker or creating files. */
export async function inspectBundleFile(
  path: string,
): Promise<BundleInspection> {
  return (await loadBundle(path)).inspection;
}

function comparisonView(report: PortableScenarioReport): unknown {
  return {
    passed: report.passed,
    summary: report.summary,
    steps: report.steps.map((step) => ({
      index: step.index,
      iteration: step.iteration,
      action: step.action,
      passed: step.passed,
      assertions: step.assertions,
      ...(step.errorCode ? { errorCode: step.errorCode } : {}),
    })),
  };
}

function compareReports(
  expected: PortableScenarioReport,
  actual: PortableScenarioReport,
): string[] {
  const differences: string[] = [];
  if (expected.passed !== actual.passed) {
    differences.push(
      `aggregate passed expected ${expected.passed} but observed ${actual.passed}`,
    );
  }
  if (expected.steps.length !== actual.steps.length) {
    differences.push(
      `step count expected ${expected.steps.length} but observed ${actual.steps.length}`,
    );
  }
  const count = Math.min(expected.steps.length, actual.steps.length);
  for (let index = 0; index < count; index += 1) {
    const wanted = expected.steps[index];
    const observed = actual.steps[index];
    if (!isDeepStrictEqual(wanted, observed)) {
      differences.push(
        `step ${index} outcome differs from the recorded report`,
      );
    }
  }
  if (
    differences.length === 0 &&
    !isDeepStrictEqual(comparisonView(expected), comparisonView(actual))
  ) {
    differences.push(
      "aggregate report summary differs from the recorded report",
    );
  }
  return differences;
}

function throwIfAborted(signal: AbortSignal, net: string): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof ForgeError) throw signal.reason;
  throw new ForgeError(
    "OPERATION_ABORTED",
    `replay network "${net}" was aborted`,
    {
      resource: net,
      action: "retry replay with a fresh AbortSignal when ready",
      cause: signal.reason,
    },
  );
}

/** Validate, provision, run, compare, and unconditionally purge a replay network. */
export async function replayBundleFile(
  backend: ReplayBundleBackend,
  path: string,
  options: ReplayBundleOptions,
): Promise<ReplayBundleResult> {
  const loaded = await loadBundle(path);
  if (!loaded.inspection.compatibility.replayable) {
    throw new ForgeError(
      "BUNDLE_INCOMPATIBLE",
      `bundle cannot replay on this installation: ${loaded.inspection.compatibility.reasons.join("; ")}`,
      {
        resource: loaded.manifest.recipeDigest,
        action:
          "use the exact exporter package, pinned images, and a supported host",
      },
    );
  }
  if (!isValidNetworkName(options.network)) {
    throw new ForgeError(
      "INVALID_NETWORK_NAME",
      `network name "${options.network}" must be lowercase alphanumeric/hyphen (1-30 chars)`,
      {
        resource: options.network,
        action: "choose a fresh network name such as replay-case",
      },
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_REPLAY_TIMEOUT_MS
  ) {
    throw new ForgeError(
      "INVALID_TIMEOUT",
      `replay timeout must be an integer from 1 to ${MAX_REPLAY_TIMEOUT_MS}ms`,
      {
        resource: "ReplayBundleOptions.timeoutMs",
        action: "choose a bounded replay timeout",
      },
    );
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new ForgeError(
          "OPERATION_TIMEOUT",
          `replay network "${options.network}" exceeded ${timeoutMs}ms`,
          {
            resource: options.network,
            action: "increase the bounded timeout or simplify the scenario",
          },
        ),
      ),
    timeoutMs,
  );
  timer.unref();

  let provisioned = false;
  let result: ReplayBundleResult | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    throwIfAborted(controller.signal, options.network);
    options.onProgress?.(`validate ${loaded.manifest.recipeDigest}`);
    await backend.assertReplayTargetClean(options.network);
    throwIfAborted(controller.signal, options.network);
    options.onProgress?.(`provision ${options.network}`);
    await backend.up(
      { ...loaded.topology, name: options.network },
      { signal: controller.signal, timeoutMs, requireClean: true },
    );
    provisioned = true;
    throwIfAborted(controller.signal, options.network);
    options.onProgress?.(
      `run ${loaded.scenario.steps.length * loaded.scenario.loop} steps`,
    );
    const actualReport = await backend.runScenario(
      options.network,
      loaded.scenario,
      { signal: controller.signal },
    );
    throwIfAborted(controller.signal, options.network);
    const actual = portableReport(
      actualReport,
      loaded.scenario,
      options.network,
    );
    const expected = { ...loaded.report, network: options.network };
    const differences = compareReports(expected, actual);
    result = {
      network: options.network,
      recipeDigest: loaded.manifest.recipeDigest,
      reproduced: differences.length === 0,
      differences,
      expected,
      actual,
      cleanup: { purged: true },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (provisioned) {
      options.onProgress?.(`purge ${options.network}`);
      try {
        await backend.down(options.network, { purge: true });
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (cleanupError) {
    const primaryMessage = primaryError
      ? `${errorDetails(primaryError).message}; `
      : "";
    throw new ForgeError(
      "ROLLBACK_FAILED",
      `${primaryMessage}replay cleanup failed: ${errorDetails(cleanupError).message}`,
      {
        resource: options.network,
        action: `run "fiber-forge down ${options.network} --purge" after fixing Docker`,
        cause: new AggregateError(
          [primaryError, cleanupError].filter((error) => error !== undefined),
        ),
      },
    );
  }
  if (primaryError) throw primaryError;
  return result as ReplayBundleResult;
}
