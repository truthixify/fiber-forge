import { describe, expect, it } from "vitest";
import { ForgeError } from "../src/errors";
import { type FaultKind, type FaultReport } from "../src/faults";
import { type NodeLifecycleReport } from "../src/orchestrator";
import {
  type ScenarioBackend,
  ScenarioError,
  parseScenario,
  runScenario,
} from "../src/scenario";

function nodeReport(
  node: string,
  status: "running" | "stopped" | "absent" = "running",
): NodeLifecycleReport {
  return {
    net: "test",
    node,
    action: "inspect",
    previousStatus: status,
    status,
    changed: false,
    rpcReady: status === "running",
    identityMatches: status === "running" ? true : null,
    channels: [],
    recovery: status === "running" ? "ready" : "action-required",
    nextAction: null,
  };
}

function faultReport(
  kind: FaultKind,
  target: string | undefined,
  requested: "active" | "reset",
): FaultReport {
  return {
    net: "test",
    id: target ? `${kind}:${target}` : kind,
    kind,
    target: target ?? null,
    requested,
    observed: {
      state: requested === "active" ? "active" : "inactive",
      summary: requested,
    },
    changed: true,
    appliedAt: requested === "active" ? "2026-10-20T00:00:00.000Z" : null,
    survivesProcessRestart: true,
    recovery: requested === "active" ? "not-applicable" : "ready",
    nextAction: null,
  };
}

function backend(overrides: Partial<ScenarioBackend> = {}): ScenarioBackend {
  const defaults: ScenarioBackend = {
    pay: async () => ({ status: "Success", paymentHash: "0xpayment" }),
    openChannelBetween: async () => {},
    closeChannel: async () => {},
    fund: async () => "0xfunding",
    createInvoice: async () => "fibd1invoice",
    inspect: async (net) => ({
      net,
      block: 1,
      nodes: [
        {
          name: "alice",
          container: "alice-container",
          rpcHostPort: 8228,
          pubkey: "alice-key",
          status: "running",
          onchainCkb: 0,
          onchainCkbShannon: "900719925474099312345678",
          udtBalance: 100,
          udtBalanceBaseUnits: "10000000000",
        },
      ],
      channels: [],
    }),
    inspectNode: async (_net, node) => nodeReport(node),
    channels: async () => [
      {
        node: "alice",
        channelId: "0xchannel",
        peer: "bob",
        state: "CHANNEL_READY",
        localCkb: 500,
        remoteCkb: 500,
      },
    ],
    stopNode: async (_net, node) => nodeReport(node, "stopped"),
    startNode: async (_net, node) => nodeReport(node),
    restartNode: async (_net, node) => nodeReport(node),
    applyFault: async (_net, kind, target) =>
      faultReport(kind, target, "active"),
    resetFault: async (_net, kind, target) =>
      faultReport(kind, target, "reset"),
  };
  return { ...defaults, ...overrides };
}

describe("parseScenario", () => {
  it("keeps legacy action-only scenarios compatible", () => {
    const scenario = parseScenario(
      [
        "loop: 2",
        "steps:",
        "  - pay: { from: alice, to: carol, amount: 100 }",
        "  - wait: 500",
        "  - fund: { node: bob, amount: 5000 }",
      ].join("\n"),
    );

    expect(scenario).toMatchObject({ version: 1, legacy: true, loop: 2 });
    expect(scenario.steps[0].action).toMatchObject({
      type: "pay",
      from: "alice",
      to: "carol",
      amount: 100,
    });
    expect(scenario.steps[1].action).toEqual({
      type: "wait",
      durationMs: 500,
    });
  });

  it("parses typed action expectations and standalone assertions", () => {
    const scenario = parseScenario(
      [
        "version: 1",
        "steps:",
        "  - pay: { from: alice, to: bob, amount: 10 }",
        "    expect: { payment_status: Success }",
        "  - assert:",
        "      channel_state: { node: alice, peer: bob, equals: CHANNEL_READY }",
        "      timeout_ms: 2000",
        "      poll_interval_ms: 25",
        "  - assert:",
        "      balance: { node: alice, asset: ckb, operator: gte, amount: '10.00000001' }",
      ].join("\n"),
    );

    expect(scenario.legacy).toBe(false);
    expect(scenario.steps[0].expect).toMatchObject({
      type: "payment_status",
      expected: "Success",
    });
    expect(scenario.steps[1].action).toMatchObject({
      type: "assert",
      assertion: { type: "channel_state", timeoutMs: 2000, pollIntervalMs: 25 },
    });
    expect(scenario.steps[2].action).toMatchObject({
      assertion: {
        type: "balance",
        amount: "10.00000001",
        amountBaseUnits: "1000000001",
      },
    });
  });

  it("rejects unsupported versions and any non-declarative vocabulary", () => {
    expect(() => parseScenario("version: 2\nsteps:\n  - wait: 1")).toThrow(
      /version must be 1; migrate/,
    );
    expect(() =>
      parseScenario("steps:\n  - shell: docker kill everything"),
    ).toThrow(/shell is not supported/);
    expect(() =>
      parseScenario(
        "steps:\n  - pay: { from: alice, to: bob, amount: 1, command: nope }",
      ),
    ).toThrow(/command is not supported/);
  });

  it("rejects ambiguous balance numbers and unbounded execution", () => {
    expect(() =>
      parseScenario(
        [
          "version: 1",
          "steps:",
          "  - assert:",
          "      balance: { node: alice, asset: ckb, operator: eq, amount: 0.1 }",
        ].join("\n"),
      ),
    ).toThrow(/decimal string/);
    expect(() => parseScenario("loop: 10001\nsteps:\n  - wait: 0")).toThrow(
      /loop must be an integer/,
    );
    expect(() => parseScenario("loop: 2\nsteps:\n  - wait: 3600000")).toThrow(
      /expanded waits and polling windows/,
    );
  });

  it("collects useful errors before execution", () => {
    try {
      parseScenario("steps:\n  - pay: { from: alice }");
      throw new Error("expected ScenarioError");
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioError);
      expect((error as ScenarioError).issues.join(" ")).toContain(
        "steps[0].pay.to",
      );
    }
  });
});

describe("runScenario", () => {
  it("drives legacy steps through the backend and reports every loop", async () => {
    const calls: string[] = [];
    const fake = backend({
      pay: async (_net, from, to, amount) => {
        calls.push(`pay ${from} ${to} ${amount}`);
        return { status: "Success", paymentHash: "0x1" };
      },
      fund: async (_net, node, amount) => {
        calls.push(`fund ${node} ${amount}`);
        return "0xtx";
      },
    });
    const scenario = parseScenario(
      [
        "loop: 2",
        "steps:",
        "  - pay: { from: alice, to: bob, amount: 10 }",
        "  - fund: { node: bob, amount: 100 }",
      ].join("\n"),
    );

    const report = await runScenario(fake, "duo", scenario);

    expect(report).toMatchObject({
      format: "fiber-forge-scenario-report",
      version: 1,
      scenarioVersion: 1,
      network: "duo",
      passed: true,
      summary: { total: 4, passed: 4, failed: 0 },
    });
    expect(calls).toEqual([
      "pay alice bob 10",
      "fund bob 100",
      "pay alice bob 10",
      "fund bob 100",
    ]);
  });

  it("polls typed node, channel, and exact balance assertions", async () => {
    let inspections = 0;
    const fake = backend({
      inspectNode: async (_net, node) => {
        inspections += 1;
        return nodeReport(node, inspections === 1 ? "stopped" : "running");
      },
    });
    const scenario = parseScenario(
      [
        "version: 1",
        "steps:",
        "  - assert:",
        "      node_status: { node: alice, equals: running }",
        "      timeout_ms: 50",
        "      poll_interval_ms: 1",
        "  - assert:",
        "      channel_state: { node: alice, peer: bob, equals: CHANNEL_READY }",
        "      timeout_ms: 0",
        "  - assert:",
        "      balance: { node: alice, asset: ckb, operator: eq, amount: '9007199254740993.12345678' }",
        "      timeout_ms: 0",
      ].join("\n"),
    );

    const report = await runScenario(fake, "test", scenario);

    expect(report.passed).toBe(true);
    expect(report.steps[0].assertions[0].attempts).toBe(2);
    expect(report.steps[2].assertions[0]).toMatchObject({
      passed: true,
      expected: {
        asset: "ckb",
        operator: "eq",
        amount: "9007199254740993.12345678",
      },
      actual: { asset: "ckb", amount: "9007199254740993.12345678" },
    });
  });

  it("sanitizes an expected failure and continues to a reset step", async () => {
    const resets: string[] = [];
    const fake = backend({
      pay: async () => {
        throw new ForgeError(
          "PAYMENT_FAILED",
          "invoice fibabcdefghijklmnopqrstuvwxyz123456 token=secret private_key=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
      },
      resetFault: async (_net, kind, target) => {
        resets.push(`${kind}:${target}`);
        return faultReport(kind, target, "reset");
      },
    });
    const scenario = parseScenario(
      [
        "version: 1",
        "steps:",
        "  - pay: { from: alice, to: bob, amount: 1 }",
        "    expect: { error_code: PAYMENT_FAILED }",
        "  - fault: { action: reset, kind: node-kill, target: bob }",
      ].join("\n"),
    );

    const report = await runScenario(fake, "test", scenario);

    expect(report.passed).toBe(true);
    expect(resets).toEqual(["node-kill:bob"]);
    expect(report.steps[0].error?.message).toContain("[redacted-invoice]");
    expect(report.steps[0].error?.message).not.toContain("secret");
    expect(report.steps[0].error?.message).not.toContain("aaaaaaaaaaaaaaaa");
  });

  it("reports a failed assertion without preventing later cleanup", async () => {
    let reset = false;
    const fake = backend({
      resetFault: async (_net, kind, target) => {
        reset = true;
        return faultReport(kind, target, "reset");
      },
    });
    const scenario = parseScenario(
      [
        "version: 1",
        "steps:",
        "  - assert:",
        "      node_status: { node: alice, equals: stopped }",
        "      timeout_ms: 0",
        "  - fault: { action: reset, kind: node-kill, target: alice }",
      ].join("\n"),
    );

    const report = await runScenario(fake, "test", scenario);

    expect(reset).toBe(true);
    expect(report).toMatchObject({
      passed: false,
      summary: { total: 2, passed: 1, failed: 1 },
    });
    expect(report.steps[0].assertions[0]).toMatchObject({
      passed: false,
      expected: "stopped",
      actual: "running",
    });
    expect(report.steps[1].passed).toBe(true);
  });
});
