/**
 * Declarative, bounded scenario specifications for live Fiber Forge networks.
 * The parser deliberately exposes a closed vocabulary: scenarios cannot run code or shell commands.
 */

import { parse as parseYaml } from "yaml";
import {
  errorDetails,
  FORGE_ERROR_CODES,
  type ForgeErrorCode,
  type ForgeErrorDetails,
} from "./errors.js";
import {
  FAULT_KINDS,
  faultNeedsTarget,
  type FaultKind,
  type FaultReport,
} from "./faults.js";
import type {
  ChannelRow,
  NetworkView,
  NodeLifecycleOptions,
  NodeLifecycleReport,
} from "./orchestrator.js";

export const SCENARIO_SCHEMA_VERSION = 1 as const;
export const SCENARIO_REPORT_VERSION = 1 as const;

const MAX_SOURCE_BYTES = 1_048_576;
const MAX_STEPS = 1_000;
const MAX_EXECUTIONS = 10_000;
const MAX_WAIT_MS = 3_600_000;
const MAX_TOTAL_DECLARED_DELAY_MS = 3_600_000;
const MAX_ASSERTION_TIMEOUT_MS = 300_000;
const DEFAULT_ASSERTION_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_TEXT_LENGTH = 512;
const ASSET_DECIMALS = 8;

const ACTION_NAMES = [
  "pay",
  "open",
  "close",
  "fund",
  "invoice",
  "node",
  "fault",
  "assert",
  "wait",
] as const;
const EXPECTATION_NAMES = [
  "payment_status",
  "node_status",
  "error_code",
] as const;
export type ScenarioNodeStatus = "running" | "stopped" | "unhealthy" | "absent";
export type BalanceAsset = "ckb" | "udt";
export type BalanceOperator = "eq" | "gte" | "lte";

export interface ScenarioTiming {
  timeoutMs: number;
  pollIntervalMs: number;
}

export type ScenarioExpectation = ScenarioTiming &
  (
    | { type: "payment_status"; expected: string }
    | { type: "node_status"; expected: ScenarioNodeStatus }
    | { type: "error_code"; expected: ForgeErrorCode }
  );

export type ScenarioAssertion = ScenarioTiming &
  (
    | { type: "node_status"; node: string; expected: ScenarioNodeStatus }
    | {
        type: "channel_state";
        node: string;
        channelId?: string;
        peer?: string;
        expected: string;
      }
    | {
        type: "balance";
        node: string;
        asset: BalanceAsset;
        operator: BalanceOperator;
        amount: string;
        amountBaseUnits: string;
      }
  );

export type ScenarioAction =
  | {
      type: "pay";
      from: string;
      to: string;
      amount: number;
      description?: string;
      udt: boolean;
    }
  | { type: "open"; from: string; to: string; capacity: number; udt: boolean }
  | { type: "close"; node: string; channel: string }
  | { type: "fund"; node: string; amount: number }
  | {
      type: "invoice";
      node: string;
      amount: number;
      description?: string;
      udt: boolean;
    }
  | {
      type: "node";
      action: "inspect" | "stop" | "start" | "restart";
      node: string;
      timeoutMs?: number;
    }
  | {
      type: "fault";
      action: "apply" | "reset";
      kind: FaultKind;
      target?: string;
    }
  | { type: "assert"; assertion: ScenarioAssertion }
  | { type: "wait"; durationMs: number };

export interface ScenarioStep {
  action: ScenarioAction;
  expect?: ScenarioExpectation;
}

/** Missing `version` is accepted as the legacy form of schema version 1. */
export interface Scenario {
  version: typeof SCENARIO_SCHEMA_VERSION;
  legacy: boolean;
  loop: number;
  steps: ScenarioStep[];
}

export interface AssertionResult {
  type:
    | "payment_status"
    | "node_status"
    | "error_code"
    | "channel_state"
    | "balance";
  passed: boolean;
  expected: unknown;
  actual: unknown;
  attempts: number;
  durationMs: number;
  diagnostic?: string;
}

export interface StepResult {
  index: number;
  iteration: number;
  action: ScenarioAction["type"];
  passed: boolean;
  summary: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  actual?: unknown;
  assertions: AssertionResult[];
  error?: ForgeErrorDetails;
}

export interface ScenarioReport {
  format: "fiber-forge-scenario-report";
  version: typeof SCENARIO_REPORT_VERSION;
  scenarioVersion: typeof SCENARIO_SCHEMA_VERSION;
  network: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: boolean;
  summary: { total: number; passed: number; failed: number };
  steps: StepResult[];
}

/** The live operations used by the scenario runner. Orchestrator satisfies this interface. */
export interface ScenarioBackend {
  pay(
    net: string,
    from: string,
    to: string,
    amount: number,
    description?: string,
    udt?: boolean,
  ): Promise<{ status: string; paymentHash: string }>;
  openChannelBetween(
    net: string,
    from: string,
    to: string,
    capacity: number,
    onProgress?: (message: string) => void,
    udt?: boolean,
  ): Promise<void>;
  closeChannel(net: string, node: string, channelId: string): Promise<void>;
  fund(net: string, node: string, amount: number): Promise<string>;
  createInvoice(
    net: string,
    node: string,
    amount: number,
    description?: string,
    udt?: boolean,
  ): Promise<string>;
  inspect(net: string): Promise<NetworkView>;
  inspectNode(net: string, node: string): Promise<NodeLifecycleReport>;
  channels(net: string, node?: string): Promise<ChannelRow[]>;
  stopNode(net: string, node: string): Promise<NodeLifecycleReport>;
  startNode(
    net: string,
    node: string,
    options?: NodeLifecycleOptions,
  ): Promise<NodeLifecycleReport>;
  restartNode(
    net: string,
    node: string,
    options?: NodeLifecycleOptions,
  ): Promise<NodeLifecycleReport>;
  applyFault(
    net: string,
    kind: FaultKind,
    target?: string,
  ): Promise<FaultReport>;
  resetFault(
    net: string,
    kind: FaultKind,
    target?: string,
    options?: NodeLifecycleOptions,
  ): Promise<FaultReport>;
}

/** Thrown before execution when a scenario has any schema error. */
export class ScenarioError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid scenario:\n  - ${issues.join("\n  - ")}`);
    this.name = "ScenarioError";
  }
}

/** Parse and fully validate a scenario before any live operation runs. */
export function parseScenario(yamlText: string): Scenario {
  if (Buffer.byteLength(yamlText, "utf8") > MAX_SOURCE_BYTES) {
    throw new ScenarioError([
      `scenario source exceeds the ${MAX_SOURCE_BYTES}-byte limit`,
    ]);
  }

  let raw: unknown;
  try {
    raw = parseYaml(yamlText, { maxAliasCount: 50 });
  } catch (error) {
    throw new ScenarioError([`not valid YAML: ${(error as Error).message}`]);
  }

  const issues: string[] = [];
  if (!isRecord(raw)) {
    throw new ScenarioError(["top level must be a mapping with a steps list"]);
  }
  rejectUnknown(raw, ["version", "loop", "steps"], "top level", issues);

  const legacy = raw.version === undefined;
  if (!legacy && raw.version !== SCENARIO_SCHEMA_VERSION) {
    issues.push(
      `version must be ${SCENARIO_SCHEMA_VERSION}; migrate this scenario before running it`,
    );
  }

  let loop = 1;
  if (raw.loop !== undefined) {
    if (!isIntegerInRange(raw.loop, 1, MAX_EXECUTIONS)) {
      issues.push(`loop must be an integer from 1 to ${MAX_EXECUTIONS}`);
    } else {
      loop = raw.loop;
    }
  }

  const steps: ScenarioStep[] = [];
  if (!Array.isArray(raw.steps)) {
    issues.push("steps must be a list");
  } else {
    if (raw.steps.length === 0) {
      issues.push("steps must have at least one entry");
    }
    if (raw.steps.length > MAX_STEPS) {
      issues.push(`steps must contain at most ${MAX_STEPS} entries`);
    }
    raw.steps.slice(0, MAX_STEPS).forEach((entry, index) => {
      const step = parseStep(entry, index, issues);
      if (step) steps.push(step);
    });
    if (raw.steps.length * loop > MAX_EXECUTIONS) {
      issues.push(
        `loop and steps produce more than ${MAX_EXECUTIONS} executions`,
      );
    }
    const declaredDelayMs =
      steps.reduce((total, step) => total + declaredDelay(step), 0) * loop;
    if (declaredDelayMs > MAX_TOTAL_DECLARED_DELAY_MS) {
      issues.push(
        `expanded waits and polling windows must total at most ${MAX_TOTAL_DECLARED_DELAY_MS}ms`,
      );
    }
  }

  if (issues.length > 0) throw new ScenarioError(issues);
  return {
    version: SCENARIO_SCHEMA_VERSION,
    legacy,
    loop,
    steps,
  };
}

function declaredDelay(step: ScenarioStep): number {
  if (step.action.type === "wait") return step.action.durationMs;
  if (step.action.type === "assert") return step.action.assertion.timeoutMs;
  return step.expect?.type === "node_status" ? step.expect.timeoutMs : 0;
}

function parseStep(
  entry: unknown,
  index: number,
  issues: string[],
): ScenarioStep | undefined {
  const path = `steps[${index}]`;
  if (!isRecord(entry)) {
    issues.push(`${path} must be a mapping`);
    return undefined;
  }
  rejectUnknown(entry, [...ACTION_NAMES, "expect"], path, issues);
  const actions = ACTION_NAMES.filter((name) => entry[name] !== undefined);
  if (actions.length !== 1) {
    issues.push(
      `${path} must have exactly one of ${ACTION_NAMES.join("/")} (got ${actions.length})`,
    );
    return undefined;
  }

  const action = parseAction(actions[0], entry[actions[0]], path, issues);
  if (!action) return undefined;
  let expect: ScenarioExpectation | undefined;
  if (entry.expect !== undefined) {
    if (action.type === "assert" || action.type === "wait") {
      issues.push(`${path}.expect is not supported for ${action.type} steps`);
    } else {
      expect = parseExpectation(entry.expect, action, `${path}.expect`, issues);
    }
  }
  return { action, ...(expect ? { expect } : {}) };
}

function parseAction(
  name: (typeof ACTION_NAMES)[number],
  value: unknown,
  stepPath: string,
  issues: string[],
): ScenarioAction | undefined {
  const path = `${stepPath}.${name}`;
  if (name === "wait") {
    if (!isIntegerInRange(value, 0, MAX_WAIT_MS)) {
      issues.push(`${path} must be an integer from 0 to ${MAX_WAIT_MS} ms`);
      return undefined;
    }
    return { type: "wait", durationMs: value };
  }
  if (!isRecord(value)) {
    issues.push(`${path} must be a mapping`);
    return undefined;
  }

  switch (name) {
    case "pay": {
      rejectUnknown(
        value,
        ["from", "to", "amount", "description", "udt"],
        path,
        issues,
      );
      const from = requiredText(value.from, `${path}.from`, issues);
      const to = requiredText(value.to, `${path}.to`, issues);
      const amount = positiveNumber(value.amount, `${path}.amount`, issues);
      const description = optionalText(
        value.description,
        `${path}.description`,
        issues,
      );
      const udt = optionalBoolean(value.udt, `${path}.udt`, issues);
      return { type: "pay", from, to, amount, description, udt };
    }
    case "open": {
      rejectUnknown(value, ["from", "to", "capacity", "udt"], path, issues);
      return {
        type: "open",
        from: requiredText(value.from, `${path}.from`, issues),
        to: requiredText(value.to, `${path}.to`, issues),
        capacity: positiveNumber(value.capacity, `${path}.capacity`, issues),
        udt: optionalBoolean(value.udt, `${path}.udt`, issues),
      };
    }
    case "close": {
      rejectUnknown(value, ["node", "channel"], path, issues);
      return {
        type: "close",
        node: requiredText(value.node, `${path}.node`, issues),
        channel: requiredText(value.channel, `${path}.channel`, issues),
      };
    }
    case "fund": {
      rejectUnknown(value, ["node", "amount"], path, issues);
      return {
        type: "fund",
        node: requiredText(value.node, `${path}.node`, issues),
        amount: positiveNumber(value.amount, `${path}.amount`, issues),
      };
    }
    case "invoice": {
      rejectUnknown(
        value,
        ["node", "amount", "description", "udt"],
        path,
        issues,
      );
      return {
        type: "invoice",
        node: requiredText(value.node, `${path}.node`, issues),
        amount: positiveNumber(value.amount, `${path}.amount`, issues),
        description: optionalText(
          value.description,
          `${path}.description`,
          issues,
        ),
        udt: optionalBoolean(value.udt, `${path}.udt`, issues),
      };
    }
    case "node":
      return parseNodeAction(value, path, issues);
    case "fault":
      return parseFaultAction(value, path, issues);
    case "assert":
      return {
        type: "assert",
        assertion: parseAssertion(value, path, issues),
      };
  }
}

function parseNodeAction(
  value: Record<string, unknown>,
  path: string,
  issues: string[],
): ScenarioAction {
  rejectUnknown(value, ["action", "node", "timeout_ms"], path, issues);
  const action = requiredText(value.action, `${path}.action`, issues);
  if (!["inspect", "stop", "start", "restart"].includes(action)) {
    issues.push(`${path}.action must be inspect, stop, start, or restart`);
  }
  const timeoutMs = optionalDuration(
    value.timeout_ms,
    `${path}.timeout_ms`,
    issues,
  );
  if (timeoutMs !== undefined && (action === "inspect" || action === "stop")) {
    issues.push(`${path}.timeout_ms is only valid for start or restart`);
  }
  return {
    type: "node",
    action: action as "inspect" | "stop" | "start" | "restart",
    node: requiredText(value.node, `${path}.node`, issues),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function parseFaultAction(
  value: Record<string, unknown>,
  path: string,
  issues: string[],
): ScenarioAction {
  rejectUnknown(value, ["action", "kind", "target"], path, issues);
  const action = requiredText(value.action, `${path}.action`, issues);
  if (action !== "apply" && action !== "reset") {
    issues.push(`${path}.action must be apply or reset`);
  }
  const rawKind = requiredText(value.kind, `${path}.kind`, issues);
  if (!(FAULT_KINDS as readonly string[]).includes(rawKind)) {
    issues.push(`${path}.kind must be one of ${FAULT_KINDS.join(", ")}`);
  }
  const kind = rawKind as FaultKind;
  const target = optionalText(value.target, `${path}.target`, issues);
  if ((FAULT_KINDS as readonly string[]).includes(rawKind)) {
    if (faultNeedsTarget(kind) && !target) {
      issues.push(`${path}.target is required for ${kind}`);
    }
    if (!faultNeedsTarget(kind) && target) {
      issues.push(`${path}.target is not valid for ${kind}`);
    }
  }
  return {
    type: "fault",
    action: action as "apply" | "reset",
    kind,
    ...(target ? { target } : {}),
  };
}

function parseExpectation(
  value: unknown,
  action: ScenarioAction,
  path: string,
  issues: string[],
): ScenarioExpectation | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be a mapping`);
    return undefined;
  }
  rejectUnknown(
    value,
    [...EXPECTATION_NAMES, "timeout_ms", "poll_interval_ms"],
    path,
    issues,
  );
  const names = EXPECTATION_NAMES.filter((name) => value[name] !== undefined);
  if (names.length !== 1) {
    issues.push(
      `${path} must have exactly one of ${EXPECTATION_NAMES.join("/")} (got ${names.length})`,
    );
    return undefined;
  }
  const timing = parseTiming(value, path, issues);
  const name = names[0];

  if (name === "payment_status") {
    if (action.type !== "pay") {
      issues.push(`${path}.payment_status is only valid for pay steps`);
    }
    return {
      type: "payment_status",
      expected: requiredText(value[name], `${path}.${name}`, issues),
      ...timing,
    };
  }
  if (name === "node_status") {
    if (
      action.type !== "node" &&
      !(action.type === "fault" && action.target !== undefined)
    ) {
      issues.push(
        `${path}.node_status requires a node step or a targeted fault step`,
      );
    }
    return {
      type: "node_status",
      expected: parseNodeStatus(value[name], `${path}.${name}`, issues),
      ...timing,
    };
  }

  const code = requiredText(value[name], `${path}.${name}`, issues);
  if (!(FORGE_ERROR_CODES as readonly string[]).includes(code)) {
    issues.push(`${path}.${name} is not a supported Fiber Forge error code`);
  }
  return {
    type: "error_code",
    expected: code as ForgeErrorCode,
    ...timing,
  };
}

function parseAssertion(
  value: Record<string, unknown>,
  path: string,
  issues: string[],
): ScenarioAssertion {
  const names = ["node_status", "channel_state", "balance"] as const;
  rejectUnknown(
    value,
    [...names, "timeout_ms", "poll_interval_ms"],
    path,
    issues,
  );
  const present = names.filter((name) => value[name] !== undefined);
  if (present.length !== 1) {
    issues.push(
      `${path} must have exactly one of ${names.join("/")} (got ${present.length})`,
    );
  }
  const name = present[0] ?? "node_status";
  const timing = parseTiming(value, path, issues);
  const predicatePath = `${path}.${name}`;
  const predicate = isRecord(value[name]) ? value[name] : {};
  if (!isRecord(value[name])) {
    issues.push(`${predicatePath} must be a mapping`);
  }

  if (name === "node_status") {
    rejectUnknown(predicate, ["node", "equals"], predicatePath, issues);
    return {
      type: "node_status",
      node: requiredText(predicate.node, `${predicatePath}.node`, issues),
      expected: parseNodeStatus(
        predicate.equals,
        `${predicatePath}.equals`,
        issues,
      ),
      ...timing,
    };
  }
  if (name === "channel_state") {
    rejectUnknown(
      predicate,
      ["node", "channel_id", "peer", "equals"],
      predicatePath,
      issues,
    );
    const channelId = optionalText(
      predicate.channel_id,
      `${predicatePath}.channel_id`,
      issues,
    );
    const peer = optionalText(predicate.peer, `${predicatePath}.peer`, issues);
    if (!channelId && !peer) {
      issues.push(`${predicatePath} requires channel_id or peer`);
    }
    return {
      type: "channel_state",
      node: requiredText(predicate.node, `${predicatePath}.node`, issues),
      ...(channelId ? { channelId } : {}),
      ...(peer ? { peer } : {}),
      expected: requiredText(
        predicate.equals,
        `${predicatePath}.equals`,
        issues,
      ),
      ...timing,
    };
  }

  rejectUnknown(
    predicate,
    ["node", "asset", "operator", "amount"],
    predicatePath,
    issues,
  );
  const asset = requiredText(predicate.asset, `${predicatePath}.asset`, issues);
  if (asset !== "ckb" && asset !== "udt") {
    issues.push(`${predicatePath}.asset must be ckb or udt`);
  }
  const operator = requiredText(
    predicate.operator,
    `${predicatePath}.operator`,
    issues,
  );
  if (operator !== "eq" && operator !== "gte" && operator !== "lte") {
    issues.push(`${predicatePath}.operator must be eq, gte, or lte`);
  }
  const amount = parseAssetAmount(
    predicate.amount,
    `${predicatePath}.amount`,
    issues,
  );
  return {
    type: "balance",
    node: requiredText(predicate.node, `${predicatePath}.node`, issues),
    asset: asset as BalanceAsset,
    operator: operator as BalanceOperator,
    amount: amount.decimal,
    amountBaseUnits: amount.baseUnits.toString(),
    ...timing,
  };
}

function parseTiming(
  value: Record<string, unknown>,
  path: string,
  issues: string[],
): ScenarioTiming {
  let timeoutMs = DEFAULT_ASSERTION_TIMEOUT_MS;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  if (value.timeout_ms !== undefined) {
    if (!isIntegerInRange(value.timeout_ms, 0, MAX_ASSERTION_TIMEOUT_MS)) {
      issues.push(
        `${path}.timeout_ms must be an integer from 0 to ${MAX_ASSERTION_TIMEOUT_MS}`,
      );
    } else {
      timeoutMs = value.timeout_ms;
    }
  }
  if (value.poll_interval_ms !== undefined) {
    if (
      !isIntegerInRange(value.poll_interval_ms, 1, MAX_ASSERTION_TIMEOUT_MS)
    ) {
      issues.push(
        `${path}.poll_interval_ms must be an integer from 1 to ${MAX_ASSERTION_TIMEOUT_MS}`,
      );
    } else {
      pollIntervalMs = value.poll_interval_ms;
    }
  }
  return { timeoutMs, pollIntervalMs };
}

function parseAssetAmount(
  value: unknown,
  path: string,
  issues: string[],
): { decimal: string; baseUnits: bigint } {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : "";
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,8}))?$/.exec(raw);
  if (!match) {
    issues.push(
      `${path} must be a non-negative decimal string with at most ${ASSET_DECIMALS} places (safe integers are also accepted)`,
    );
    return { decimal: "0", baseUnits: 0n };
  }
  const fraction = (match[2] ?? "").padEnd(ASSET_DECIMALS, "0");
  const baseUnits = BigInt(match[1]) * 100_000_000n + BigInt(fraction || "0");
  return { decimal: formatBaseUnits(baseUnits), baseUnits };
}

function parseNodeStatus(
  value: unknown,
  path: string,
  issues: string[],
): ScenarioNodeStatus {
  if (
    value !== "running" &&
    value !== "stopped" &&
    value !== "unhealthy" &&
    value !== "absent"
  ) {
    issues.push(`${path} must be running, stopped, unhealthy, or absent`);
    return "unhealthy";
  }
  return value;
}

function requiredText(value: unknown, path: string, issues: string[]): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_TEXT_LENGTH
  ) {
    issues.push(
      `${path} must be a non-empty string up to ${MAX_TEXT_LENGTH} characters`,
    );
    return "";
  }
  return value;
}

function optionalText(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, path, issues);
}

function optionalBoolean(
  value: unknown,
  path: string,
  issues: string[],
): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    issues.push(`${path} must be true or false`);
    return false;
  }
  return value;
}

function positiveNumber(
  value: unknown,
  path: string,
  issues: string[],
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isSafeInteger(value * 100_000_000)
  ) {
    issues.push(
      `${path} must be a positive number with a safe 8-decimal base-unit value`,
    );
    return 0;
  }
  return value;
}

function optionalDuration(
  value: unknown,
  path: string,
  issues: string[],
): number | undefined {
  if (value === undefined) return undefined;
  if (!isIntegerInRange(value, 1, MAX_ASSERTION_TIMEOUT_MS)) {
    issues.push(
      `${path} must be an integer from 1 to ${MAX_ASSERTION_TIMEOUT_MS}`,
    );
    return undefined;
  }
  return value;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key} is not supported`);
  }
}

function isIntegerInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

/** Run every step and always return a complete report, even after failed actions or assertions. */
export async function runScenario(
  backend: ScenarioBackend,
  net: string,
  scenario: Scenario,
  onStep: (result: StepResult) => void = () => {},
): Promise<ScenarioReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const steps: StepResult[] = [];
  let index = 0;

  for (let iteration = 0; iteration < scenario.loop; iteration += 1) {
    for (const step of scenario.steps) {
      const result = await runStep(backend, net, step, index, iteration);
      steps.push(result);
      onStep(result);
      index += 1;
    }
  }

  const finished = Date.now();
  const passed = steps.filter((step) => step.passed).length;
  return {
    format: "fiber-forge-scenario-report",
    version: SCENARIO_REPORT_VERSION,
    scenarioVersion: scenario.version,
    network: net,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    passed: passed === steps.length,
    summary: {
      total: steps.length,
      passed,
      failed: steps.length - passed,
    },
    steps,
  };
}

interface ActionExecution {
  summary: string;
  actual?: unknown;
  paymentStatus?: string;
}

async function runStep(
  backend: ScenarioBackend,
  net: string,
  step: ScenarioStep,
  index: number,
  iteration: number,
): Promise<StepResult> {
  const started = Date.now();
  let execution: ActionExecution | undefined;
  let failure: ForgeErrorDetails | undefined;
  const assertions: AssertionResult[] = [];

  if (step.action.type === "assert") {
    assertions.push(
      await runDeclarativeAssertion(backend, net, step.action.assertion),
    );
    execution = {
      summary: assertionSummary(assertions[0]),
      actual: assertions[0].actual,
    };
  } else {
    try {
      execution = await executeAction(backend, net, step.action);
    } catch (error) {
      failure = safeErrorDetails(error);
    }

    if (step.expect?.type === "error_code") {
      assertions.push(
        immediateAssertion(
          "error_code",
          step.expect.expected,
          failure?.code ?? null,
          failure?.code === step.expect.expected,
          failure
            ? undefined
            : `action completed without the expected ${step.expect.expected} error`,
        ),
      );
    } else if (failure) {
      if (step.expect) {
        assertions.push(
          immediateAssertion(
            step.expect.type,
            step.expect.expected,
            null,
            false,
            `${failure.code}: ${failure.message}`,
          ),
        );
      }
    } else if (step.expect?.type === "payment_status") {
      assertions.push(
        immediateAssertion(
          "payment_status",
          step.expect.expected,
          execution?.paymentStatus ?? null,
          execution?.paymentStatus === step.expect.expected,
        ),
      );
    } else if (step.expect?.type === "node_status") {
      const node = actionNode(step.action);
      assertions.push(
        await pollAssertion(
          "node_status",
          step.expect.expected,
          step.expect,
          async () => {
            const actual = observedNodeStatus(
              await backend.inspectNode(net, node ?? ""),
            );
            return { actual, passed: actual === step.expect?.expected };
          },
        ),
      );
    }
  }

  const passed =
    failure === undefined
      ? assertions.every((assertion) => assertion.passed)
      : step.expect?.type === "error_code" &&
        assertions.every((assertion) => assertion.passed);
  const finished = Date.now();
  const matchedExpectedError =
    failure !== undefined &&
    step.expect?.type === "error_code" &&
    assertions.every((assertion) => assertion.passed);
  return {
    index,
    iteration,
    action: step.action.type,
    passed,
    summary:
      execution?.summary ??
      (matchedExpectedError
        ? `${step.action.type} produced expected ${failure?.code}`
        : `${step.action.type} failed: ${failure?.code ?? "UNEXPECTED"}`),
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    ...(execution?.actual === undefined ? {} : { actual: execution.actual }),
    assertions,
    ...(failure ? { error: failure } : {}),
  };
}

async function executeAction(
  backend: ScenarioBackend,
  net: string,
  action: Exclude<ScenarioAction, { type: "assert" }>,
): Promise<ActionExecution> {
  switch (action.type) {
    case "wait":
      await delay(action.durationMs);
      return {
        summary: `waited ${action.durationMs}ms`,
        actual: { durationMs: action.durationMs },
      };
    case "pay": {
      const report = await backend.pay(
        net,
        action.from,
        action.to,
        action.amount,
        action.description,
        action.udt,
      );
      return {
        summary: `${action.from} -> ${action.to} ${action.amount} ${action.udt ? "UDT" : "CKB"}: ${report.status}`,
        actual: {
          status: report.status,
          paymentHash: report.paymentHash,
        },
        paymentStatus: report.status,
      };
    }
    case "open":
      await backend.openChannelBetween(
        net,
        action.from,
        action.to,
        action.capacity,
        undefined,
        action.udt,
      );
      return {
        summary: `${action.from} <-> ${action.to} ${action.capacity} ${action.udt ? "UDT" : "CKB"}: ready`,
        actual: { opened: true },
      };
    case "close":
      await backend.closeChannel(net, action.node, action.channel);
      return {
        summary: `${action.node} closed ${action.channel}`,
        actual: { closed: true, channelId: action.channel },
      };
    case "fund": {
      const txHash = await backend.fund(net, action.node, action.amount);
      return {
        summary: `${action.node} +${action.amount} CKB`,
        actual: { funded: true, txHash },
      };
    }
    case "invoice":
      await backend.createInvoice(
        net,
        action.node,
        action.amount,
        action.description,
        action.udt,
      );
      return {
        summary: `${action.node} created ${action.amount} ${action.udt ? "UDT" : "CKB"} invoice`,
        actual: { created: true },
      };
    case "node": {
      const options = action.timeoutMs
        ? { timeoutMs: action.timeoutMs }
        : undefined;
      const report =
        action.action === "inspect"
          ? await backend.inspectNode(net, action.node)
          : action.action === "stop"
            ? await backend.stopNode(net, action.node)
            : action.action === "start"
              ? await backend.startNode(net, action.node, options)
              : await backend.restartNode(net, action.node, options);
      return {
        summary: `${action.node} ${action.action}: ${observedNodeStatus(report)}`,
        actual: report,
      };
    }
    case "fault": {
      const report =
        action.action === "apply"
          ? await backend.applyFault(net, action.kind, action.target)
          : await backend.resetFault(net, action.kind, action.target);
      return {
        summary: `${action.kind}${action.target ? ` ${action.target}` : ""} ${action.action}: ${report.observed.state}`,
        actual: report,
      };
    }
  }
}

function actionNode(action: ScenarioAction): string | undefined {
  if (action.type === "node") return action.node;
  if (action.type === "fault") return action.target;
  return undefined;
}

async function runDeclarativeAssertion(
  backend: ScenarioBackend,
  net: string,
  assertion: ScenarioAssertion,
): Promise<AssertionResult> {
  if (assertion.type === "node_status") {
    return pollAssertion(
      assertion.type,
      assertion.expected,
      assertion,
      async () => {
        const actual = observedNodeStatus(
          await backend.inspectNode(net, assertion.node),
        );
        return { actual, passed: actual === assertion.expected };
      },
    );
  }
  if (assertion.type === "channel_state") {
    return pollAssertion(
      assertion.type,
      assertion.expected,
      assertion,
      async () => {
        const rows = await backend.channels(net, assertion.node);
        const channel = rows.find(
          (row) =>
            (assertion.channelId === undefined ||
              row.channelId === assertion.channelId) &&
            (assertion.peer === undefined || row.peer === assertion.peer),
        );
        const actual = channel
          ? {
              node: channel.node,
              channelId: channel.channelId,
              peer: channel.peer,
              state: channel.state,
            }
          : null;
        return { actual, passed: channel?.state === assertion.expected };
      },
    );
  }

  const expected = {
    asset: assertion.asset,
    operator: assertion.operator,
    amount: assertion.amount,
  };
  return pollAssertion(assertion.type, expected, assertion, async () => {
    const view = await backend.inspect(net);
    const node = view.nodes.find(
      (candidate) => candidate.name === assertion.node,
    );
    if (!node) return { actual: null, passed: false };
    const baseUnits = exactBalance(node, assertion.asset);
    const wanted = BigInt(assertion.amountBaseUnits);
    const passed =
      assertion.operator === "eq"
        ? baseUnits === wanted
        : assertion.operator === "gte"
          ? baseUnits >= wanted
          : baseUnits <= wanted;
    return {
      actual: { asset: assertion.asset, amount: formatBaseUnits(baseUnits) },
      passed,
    };
  });
}

async function pollAssertion(
  type: AssertionResult["type"],
  expected: unknown,
  timing: ScenarioTiming,
  probe: () => Promise<{ actual: unknown; passed: boolean }>,
): Promise<AssertionResult> {
  const started = Date.now();
  let attempts = 0;
  let actual: unknown = null;
  let diagnostic: string | undefined;

  while (true) {
    attempts += 1;
    try {
      const observation = await probe();
      actual = observation.actual;
      diagnostic = undefined;
      if (observation.passed) {
        return {
          type,
          passed: true,
          expected,
          actual,
          attempts,
          durationMs: Date.now() - started,
        };
      }
    } catch (error) {
      const details = safeErrorDetails(error);
      actual = { errorCode: details.code };
      diagnostic = `${details.code}: ${details.message}`;
    }

    const elapsed = Date.now() - started;
    if (elapsed >= timing.timeoutMs) {
      return {
        type,
        passed: false,
        expected,
        actual,
        attempts,
        durationMs: elapsed,
        diagnostic:
          diagnostic ?? `expectation was not met within ${timing.timeoutMs}ms`,
      };
    }
    await delay(Math.min(timing.pollIntervalMs, timing.timeoutMs - elapsed));
  }
}

function immediateAssertion(
  type: AssertionResult["type"],
  expected: unknown,
  actual: unknown,
  passed: boolean,
  diagnostic?: string,
): AssertionResult {
  return {
    type,
    passed,
    expected,
    actual,
    attempts: 1,
    durationMs: 0,
    ...(!passed && diagnostic ? { diagnostic: sanitizeText(diagnostic) } : {}),
  };
}

function observedNodeStatus(report: NodeLifecycleReport): ScenarioNodeStatus {
  if (report.status !== "running") return report.status;
  return report.rpcReady && report.identityMatches !== false
    ? "running"
    : "unhealthy";
}

type NetworkNode = NetworkView["nodes"][number];

function exactBalance(node: NetworkNode, asset: BalanceAsset): bigint {
  const exact =
    asset === "ckb" ? node.onchainCkbShannon : node.udtBalanceBaseUnits;
  if (exact !== undefined && /^\d+$/.test(exact)) return BigInt(exact);
  throw new Error(`exact ${asset.toUpperCase()} balance is unavailable`);
}

function formatBaseUnits(value: bigint): string {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n)
    .toString()
    .padStart(ASSET_DECIMALS, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function assertionSummary(assertion: AssertionResult): string {
  return `${assertion.type}: ${assertion.passed ? "passed" : "failed"}`;
}

function safeErrorDetails(error: unknown): ForgeErrorDetails {
  const details = errorDetails(error);
  return {
    code: details.code,
    message: sanitizeText(details.message),
    ...(details.resource ? { resource: sanitizeText(details.resource) } : {}),
    ...(details.action ? { action: sanitizeText(details.action) } : {}),
  };
}

function sanitizeText(value: string): string {
  return value
    .replace(/\b(fib[a-z0-9]{20,})\b/gi, "[redacted-invoice]")
    .replace(
      /\b(seed|mnemonic|private[_ -]?key|password|token)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b0x[0-9a-f]{64,}\b/gi,
      (hex) => `${hex.slice(0, 10)}...[${hex.length - 2} hex chars]`,
    )
    .slice(0, MAX_TEXT_LENGTH);
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
