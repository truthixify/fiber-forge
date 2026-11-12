import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  classifyWorkflowPaths,
  formatWorkflowOutputs,
} from "../scripts/workflow-paths.mjs";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

async function workflow(name) {
  return parseYaml(
    await readFile(join(repoDir, ".github", "workflows", name), "utf8"),
  );
}

describe("live workflow path policy", () => {
  it("skips live suites for unrelated documentation", () => {
    expect(classifyWorkflowPaths(["docs/spec.md", "README.md"])).toEqual({
      ordinary: false,
      cch: false,
      action: false,
    });
  });

  it("selects focused and shared runtime suites", () => {
    expect(classifyWorkflowPaths(["assets/gui/index.html"])).toEqual({
      ordinary: true,
      cch: true,
      action: true,
    });
    expect(classifyWorkflowPaths(["scripts/cch-runner-state.mjs"])).toEqual({
      ordinary: false,
      cch: true,
      action: false,
    });
    expect(classifyWorkflowPaths(["action/main.mjs"])).toEqual({
      ordinary: false,
      cch: false,
      action: true,
    });
    expect(classifyWorkflowPaths(["src/orchestrator.ts"])).toEqual({
      ordinary: true,
      cch: true,
      action: true,
    });
    expect(classifyWorkflowPaths(["package-lock.json"])).toEqual({
      ordinary: true,
      cch: true,
      action: true,
    });
  });

  it("emits stable GitHub output values", () => {
    expect(
      formatWorkflowOutputs({ ordinary: true, cch: false, action: true }),
    ).toBe("ordinary=true\ncch=false\naction=true");
  });
});

describe("merge and release workflow contracts", () => {
  it("reports one stable required source result", async () => {
    const ci = await workflow("ci.yml");

    expect(ci.jobs.required.name).toBe("ci / required");
    expect(ci.jobs.required.if).toBe("always()");
    expect(ci.jobs.required.needs).toEqual(["ci", "runtime-compatibility"]);
  });

  it("always creates one pull-request gate and conditionally calls live suites", async () => {
    const gate = await workflow("merge-gate.yml");

    expect(gate.on.pull_request).toEqual({ branches: ["main"] });
    expect(gate.jobs.changes.outputs).toEqual({
      ordinary: "${{ steps.paths.outputs.ordinary }}",
      cch: "${{ steps.paths.outputs.cch }}",
      action: "${{ steps.paths.outputs.action }}",
    });
    expect(gate.jobs["ordinary-live"].uses).toBe("./.github/workflows/e2e.yml");
    expect(gate.jobs["cch-live"].uses).toBe("./.github/workflows/cch-e2e.yml");
    expect(gate.jobs["action-live"].uses).toBe(
      "./.github/workflows/action-e2e.yml",
    );
    expect(gate.jobs.required.name).toBe("merge-gate / required");
    expect(gate.jobs.required.if).toBe("always()");
    expect(gate.jobs.required.needs).toEqual([
      "changes",
      "ordinary-live",
      "cch-live",
      "action-live",
    ]);
  });

  it("keeps called workflows reusable without path-filtered pull requests", async () => {
    const workflows = await Promise.all([
      workflow("e2e.yml"),
      workflow("cch-e2e.yml"),
      workflow("action-e2e.yml"),
    ]);

    for (const value of workflows) {
      expect(Object.hasOwn(value.on, "workflow_call")).toBe(true);
      expect(Object.hasOwn(value.on, "pull_request")).toBe(false);
    }
  });

  it("runs bounded weekly CCH drift detection", async () => {
    const cch = await workflow("cch-e2e.yml");

    expect(cch.on.schedule).toEqual([{ cron: "37 5 * * 4" }]);
    expect(cch.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
    expect(cch.jobs["cch-proof"]["timeout-minutes"]).toBe(45);
    const upload = cch.jobs["cch-proof"].steps.find(
      (step) => step.uses === "actions/upload-artifact@v7",
    );
    expect(upload.with["retention-days"]).toBe(14);
  });

  it("requires source, ordinary live, and CCH gates for publication", async () => {
    const [publish, guide] = await Promise.all([
      workflow("publish.yml"),
      readFile(join(repoDir, "docs", "verification.md"), "utf8"),
    ]);

    expect(publish.jobs["live-e2e"].uses).toBe("./.github/workflows/e2e.yml");
    expect(publish.jobs["cch-e2e"].uses).toBe(
      "./.github/workflows/cch-e2e.yml",
    );
    expect(publish.jobs.publish.needs).toEqual([
      "metadata",
      "source-ci",
      "live-e2e",
      "cch-e2e",
    ]);
    expect(guide).toContain("`ci / required`");
    expect(guide).toContain("`merge-gate / required`");
    expect(guide).toContain("ordinary live E2E never substitutes for CCH");
    expect(guide).toContain(
      "npm view @truthixify/fiber-forge@<version> version",
    );
    expect(guide).toContain("must be inspected and enabled separately");
  });
});
