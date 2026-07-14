/**
 * Scenario scripts: a small YAML traffic-generator for a running network. A scenario is an
 * ordered list of steps (pay / open / close / fund / invoice / wait), optionally looped, driven
 * against the orchestrator by `fiber-forge run`. Parsing validates with actionable errors up front
 * (same discipline as topologies) so a bad script fails before it touches a live node.
 */

import { parse as parseYaml } from "yaml";

export interface PayStep {
  from: string;
  to: string;
  amount: number;
  description?: string;
}
export interface OpenStep {
  from: string;
  to: string;
  capacity: number;
}
export interface CloseStep {
  node: string;
  channel: string;
}
export interface FundStep {
  node: string;
  amount: number;
}
export interface InvoiceStep {
  node: string;
  amount: number;
}

/** One step of a scenario: exactly one action key is set. */
export interface ScenarioStep {
  pay?: PayStep;
  open?: OpenStep;
  close?: CloseStep;
  fund?: FundStep;
  invoice?: InvoiceStep;
  wait?: number;
}

/** A validated scenario: an ordered step list, optionally repeated `loop` times. */
export interface Scenario {
  loop: number;
  steps: ScenarioStep[];
}

const ACTIONS = ["pay", "open", "close", "fund", "invoice", "wait"] as const;

/** Thrown when a scenario is invalid; carries every issue found. */
export class ScenarioError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid scenario:\n  - ${issues.join("\n  - ")}`);
    this.name = "ScenarioError";
  }
}

/** The orchestrator operations a scenario drives (the Orchestrator implements these). */
export interface ScenarioBackend {
  pay(
    net: string,
    from: string,
    to: string,
    amountCkb: number,
    description?: string,
  ): Promise<{ status: string; paymentHash: string }>;
  openChannelBetween(
    net: string,
    from: string,
    to: string,
    capacityCkb: number,
  ): Promise<void>;
  closeChannel(net: string, node: string, channelId: string): Promise<void>;
  fund(net: string, node: string, amountCkb: number): Promise<string>;
  createInvoice(net: string, node: string, amountCkb: number): Promise<string>;
}

/** The outcome of running one step. */
export interface StepResult {
  index: number;
  action: string;
  summary: string;
}

/** Parse and validate a scenario from YAML. Throws {@link ScenarioError} on any issue. */
export function parseScenario(yamlText: string): Scenario {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new ScenarioError([`not valid YAML: ${(error as Error).message}`]);
  }
  const issues: string[] = [];
  const root = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) {
    issues.push("top level must be a mapping with a steps list");
  }

  let loop = 1;
  if (root.loop !== undefined) {
    if (typeof root.loop !== "number" || root.loop < 1) {
      issues.push("loop must be a positive number");
    } else {
      loop = Math.floor(root.loop);
    }
  }

  const steps: ScenarioStep[] = [];
  if (!Array.isArray(root.steps)) {
    issues.push("steps must be a list");
  } else {
    root.steps.forEach((entry, i) => {
      const step = parseStep(entry, i, issues);
      if (step) {
        steps.push(step);
      }
    });
    if (root.steps.length === 0) {
      issues.push("steps must have at least one entry");
    }
  }

  if (issues.length > 0) {
    throw new ScenarioError(issues);
  }
  return { loop, steps };
}

function parseStep(
  entry: unknown,
  i: number,
  issues: string[],
): ScenarioStep | undefined {
  const rec = isRecord(entry) ? entry : {};
  const keys = ACTIONS.filter((a) => rec[a] !== undefined);
  if (keys.length !== 1) {
    issues.push(
      `steps[${i}] must have exactly one of ${ACTIONS.join("/")} (got ${keys.length})`,
    );
    return undefined;
  }
  const action = keys[0];
  const value = rec[action];

  if (action === "wait") {
    if (typeof value !== "number" || value < 0) {
      issues.push(`steps[${i}].wait must be a non-negative number of ms`);
      return undefined;
    }
    return { wait: value };
  }

  const v = isRecord(value) ? value : {};
  const str = (k: string): string => (typeof v[k] === "string" ? v[k] : "");
  const numOf = (k: string): number => (typeof v[k] === "number" ? v[k] : NaN);
  const need = (present: boolean, message: string) => {
    if (!present) issues.push(`steps[${i}].${action}: ${message}`);
  };

  switch (action) {
    case "pay": {
      need(!!str("from"), "from is required");
      need(!!str("to"), "to is required");
      need(Number.isFinite(numOf("amount")), "amount must be a number");
      return {
        pay: {
          from: str("from"),
          to: str("to"),
          amount: numOf("amount"),
          description:
            typeof v.description === "string" ? v.description : undefined,
        },
      };
    }
    case "open": {
      need(!!str("from"), "from is required");
      need(!!str("to"), "to is required");
      need(Number.isFinite(numOf("capacity")), "capacity must be a number");
      return {
        open: {
          from: str("from"),
          to: str("to"),
          capacity: numOf("capacity"),
        },
      };
    }
    case "close": {
      need(!!str("node"), "node is required");
      need(!!str("channel"), "channel (id) is required");
      return { close: { node: str("node"), channel: str("channel") } };
    }
    case "fund": {
      need(!!str("node"), "node is required");
      need(Number.isFinite(numOf("amount")), "amount must be a number");
      return { fund: { node: str("node"), amount: numOf("amount") } };
    }
    case "invoice": {
      need(!!str("node"), "node is required");
      need(Number.isFinite(numOf("amount")), "amount must be a number");
      return { invoice: { node: str("node"), amount: numOf("amount") } };
    }
    default:
      return undefined;
  }
}

/** Run a scenario against a live network, invoking `onStep` before each step. */
export async function runScenario(
  backend: ScenarioBackend,
  net: string,
  scenario: Scenario,
  onStep: (result: StepResult) => void = () => {},
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let index = 0;
  for (let iteration = 0; iteration < scenario.loop; iteration += 1) {
    for (const step of scenario.steps) {
      const result = await runStep(backend, net, step, index);
      results.push(result);
      onStep(result);
      index += 1;
    }
  }
  return results;
}

async function runStep(
  backend: ScenarioBackend,
  net: string,
  step: ScenarioStep,
  index: number,
): Promise<StepResult> {
  if (step.wait !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, step.wait));
    return { index, action: "wait", summary: `waited ${step.wait}ms` };
  }
  if (step.pay) {
    const { from, to, amount, description } = step.pay;
    const report = await backend.pay(net, from, to, amount, description);
    return {
      index,
      action: "pay",
      summary: `${from} → ${to} ${amount} CKB — ${report.status}`,
    };
  }
  if (step.open) {
    const { from, to, capacity } = step.open;
    await backend.openChannelBetween(net, from, to, capacity);
    return {
      index,
      action: "open",
      summary: `${from} ⇄ ${to} ${capacity} CKB — ready`,
    };
  }
  if (step.close) {
    await backend.closeChannel(net, step.close.node, step.close.channel);
    return {
      index,
      action: "close",
      summary: `${step.close.node} closed ${step.close.channel}`,
    };
  }
  if (step.fund) {
    await backend.fund(net, step.fund.node, step.fund.amount);
    return {
      index,
      action: "fund",
      summary: `${step.fund.node} +${step.fund.amount} CKB`,
    };
  }
  if (step.invoice) {
    const invoice = await backend.createInvoice(
      net,
      step.invoice.node,
      step.invoice.amount,
    );
    return {
      index,
      action: "invoice",
      summary: `${step.invoice.node} ${step.invoice.amount} CKB — ${invoice}`,
    };
  }
  return { index, action: "noop", summary: "" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
