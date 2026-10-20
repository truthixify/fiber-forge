import { describe, expect, it, vi } from "vitest";
import {
  buildPrototypeOutputs,
  simulatePostActionJob,
  validatePrototypeInputs,
} from "../action/prototype.mjs";

describe("GitHub Action lifecycle design", () => {
  it("accepts an exact package version plus presets or workspace topology files", () => {
    expect(
      validatePrototypeInputs(
        {
          packageVersion: "0.3.0-rc.1",
          topology: "trio",
          ckbPort: "18114",
          rpcPortBase: "18300",
          udtPerNode: "10000",
        },
        "/work/repository",
      ),
    ).toMatchObject({
      packageVersion: "0.3.0-rc.1",
      topology: "trio",
      topologyKind: "preset",
      ckbPort: 18114,
      rpcPortBase: 18300,
      udtPerNode: 10000,
      startupTimeoutMs: 600_000,
      diagnostics: "failure",
    });
    expect(
      validatePrototypeInputs(
        { packageVersion: "0.2.9", topology: "fixtures/network.yaml" },
        "/work/repository",
      ),
    ).toMatchObject({
      topology: "/work/repository/fixtures/network.yaml",
      topologyKind: "file",
    });
  });

  it("rejects floating versions and topology paths outside the workspace", () => {
    expect(() =>
      validatePrototypeInputs(
        { packageVersion: "latest", topology: "trio" },
        "/work/repository",
      ),
    ).toThrow(/exact semver/);
    expect(() =>
      validatePrototypeInputs(
        { packageVersion: "^0.2.9", topology: "trio" },
        "/work/repository",
      ),
    ).toThrow(/exact semver/);
    expect(() =>
      validatePrototypeInputs(
        { packageVersion: "0.2.9", topology: "../network.yml" },
        "/work/repository",
      ),
    ).toThrow(/inside GITHUB_WORKSPACE/);
  });

  it("emits loopback-only structured outputs without internal passwords", () => {
    const outputs = buildPrototypeOutputs(
      {
        network: "trio",
        ckbRpc: "http://127.0.0.1:8114",
        nodes: [
          {
            name: "alice",
            pubkey: "02abc",
            rpc: "http://127.0.0.1:8300",
            password: "must-not-leak",
          },
        ],
      },
      { reportPath: "/tmp/report.json", startupDurationMs: 42 },
    );

    expect(JSON.parse(outputs["connection-json"])).toEqual({
      schemaVersion: 1,
      network: "trio",
      ckbRpc: "http://127.0.0.1:8114",
      nodes: [{ name: "alice", pubkey: "02abc", rpc: "http://127.0.0.1:8300" }],
    });
    expect(JSON.stringify(outputs)).not.toContain("must-not-leak");
    expect(() =>
      buildPrototypeOutputs(
        {
          network: "trio",
          ckbRpc: "http://token@127.0.0.1:8114",
          nodes: [],
        },
        { reportPath: "/tmp/report.json", startupDurationMs: 42 },
      ),
    ).toThrow(/http:\/\/127\.0\.0\.1/);
  });

  it("runs post cleanup after a deliberately failing consumer", async () => {
    const resources = new Set();
    const order = [];

    await expect(
      simulatePostActionJob({
        main: async () => {
          order.push("main");
          resources.add("forge-action-trio");
          return { network: "action-trio" };
        },
        consumer: async () => {
          order.push("consumer");
          throw new Error("deliberate consumer failure");
        },
        post: async () => {
          order.push("post");
          resources.clear();
        },
      }),
    ).rejects.toThrow("deliberate consumer failure");

    expect(order).toEqual(["main", "consumer", "post"]);
    expect(resources.size).toBe(0);
  });

  it("runs post cleanup when setup itself fails", async () => {
    const post = vi.fn(async () => {});

    await expect(
      simulatePostActionJob({
        main: async () => {
          throw new Error("setup failed");
        },
        consumer: vi.fn(),
        post,
      }),
    ).rejects.toThrow("setup failed");

    expect(post).toHaveBeenCalledOnce();
  });
});
