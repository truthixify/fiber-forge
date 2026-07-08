import { describe, expect, it } from "vitest";
import {
  type ScenarioBackend,
  ScenarioError,
  parseScenario,
  runScenario,
} from "../src/scenario";

describe("parseScenario", () => {
  it("parses a valid scenario with a loop and mixed steps", () => {
    const scenario = parseScenario(
      [
        "loop: 2",
        "steps:",
        "  - pay: { from: alice, to: carol, amount: 100 }",
        "  - wait: 500",
        "  - fund: { node: bob, amount: 5000 }",
      ].join("\n"),
    );
    expect(scenario.loop).toBe(2);
    expect(scenario.steps).toHaveLength(3);
    expect(scenario.steps[0].pay).toEqual({
      from: "alice",
      to: "carol",
      amount: 100,
      description: undefined,
    });
    expect(scenario.steps[1].wait).toBe(500);
  });

  it("rejects a step with more than one action", () => {
    expect(() =>
      parseScenario(
        "steps:\n  - pay: { from: a, to: b, amount: 1 }\n    wait: 5",
      ),
    ).toThrow(ScenarioError);
  });

  it("collects missing-field issues", () => {
    try {
      parseScenario("steps:\n  - pay: { from: alice }");
      throw new Error("expected ScenarioError");
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioError);
      expect((error as ScenarioError).issues.join(" ")).toContain(
        "to is required",
      );
    }
  });

  it("requires at least one step", () => {
    expect(() => parseScenario("steps: []")).toThrow(ScenarioError);
  });
});

describe("runScenario", () => {
  it("drives each step through the backend, honoring loop", async () => {
    const calls: string[] = [];
    const backend: ScenarioBackend = {
      pay: async (_n, from, to, amount) => {
        calls.push(`pay ${from} ${to} ${amount}`);
        return { status: "Success", paymentHash: "0x1" };
      },
      openChannelBetween: async (_n, from, to, cap) => {
        calls.push(`open ${from} ${to} ${cap}`);
      },
      closeChannel: async () => {},
      fund: async (_n, node, amount) => {
        calls.push(`fund ${node} ${amount}`);
        return "0xtx";
      },
      createInvoice: async () => "fibd1inv",
    };
    const scenario = parseScenario(
      [
        "loop: 2",
        "steps:",
        "  - pay: { from: alice, to: bob, amount: 10 }",
        "  - fund: { node: bob, amount: 100 }",
      ].join("\n"),
    );
    const results = await runScenario(backend, "duo", scenario);
    expect(results).toHaveLength(4);
    expect(calls).toEqual([
      "pay alice bob 10",
      "fund bob 100",
      "pay alice bob 10",
      "fund bob 100",
    ]);
    expect(results[0].summary).toContain("Success");
  });
});
