import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  SANDBOX_GUI_PORT,
  SANDBOX_NET,
  SANDBOX_TTL_MS,
  createSandboxBackend,
  formatStatus,
  safeMessage,
  waitForStopOrExpiry,
} from "../scripts/sandbox.mjs";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

describe("hosted sandbox definition", () => {
  it("pins an isolated Docker-in-Docker environment and forwards only the GUI", async () => {
    const raw = await readFile(
      join(repoDir, ".devcontainer", "devcontainer.json"),
      "utf8",
    );
    const definition = JSON.parse(raw);
    const lock = JSON.parse(
      await readFile(
        join(repoDir, ".devcontainer", "devcontainer-lock.json"),
        "utf8",
      ),
    );

    expect(definition.image).toMatch(
      /^mcr\.microsoft\.com\/devcontainers\/javascript-node:3-22-bookworm@sha256:[a-f0-9]{64}$/,
    );
    expect(Object.keys(definition.features)).toEqual([
      "ghcr.io/devcontainers/features/docker-in-docker:4.1.3",
    ]);
    expect(
      definition.features[Object.keys(definition.features)[0]],
    ).toMatchObject({
      version: "29.3.1",
      dockerDashComposeVersion: "none",
      installDockerBuildx: false,
    });
    expect(
      lock.features["ghcr.io/devcontainers/features/docker-in-docker:4.1.3"],
    ).toEqual({
      version: "4.1.3",
      resolved:
        "ghcr.io/devcontainers/features/docker-in-docker@sha256:fae40f3c8be5a7c3b0db344c1d30341bc2c91ba38d1d5b14cd2ad72e6d65d084",
      integrity:
        "sha256:fae40f3c8be5a7c3b0db344c1d30341bc2c91ba38d1d5b14cd2ad72e6d65d084",
    });
    expect(definition.forwardPorts).toEqual([SANDBOX_GUI_PORT]);
    expect(definition.otherPortsAttributes).toEqual({
      onAutoForward: "ignore",
    });
    expect(definition.postStartCommand).toBe("npm run sandbox:start");
    expect(definition.waitFor).toBe("postStartCommand");
    expect(definition.hostRequirements).toEqual({
      cpus: 4,
      memory: "8gb",
      storage: "32gb",
    });
    expect(definition.runArgs).toEqual([
      "--cpus=4",
      "--memory=8g",
      "--pids-limit=4096",
    ]);
    expect(definition.mounts).toEqual([
      "source=${localWorkspaceFolderBasename}-node_modules,target=${containerWorkspaceFolder}/node_modules,type=volume",
    ]);
    expect(definition.postCreateCommand).toContain(
      "sudo chown node:node node_modules",
    );
    expect(raw).not.toContain("/var/run/docker.sock");
    expect(raw).not.toContain("docker-outside-of-docker");
  });

  it("uses one fixed funded trio without production credentials", async () => {
    const raw = await readFile(
      join(repoDir, ".devcontainer", "sandbox.yml"),
      "utf8",
    );
    const topology = YAML.parse(raw);

    expect(topology).toEqual({
      name: SANDBOX_NET,
      nodes: [{ name: "alice" }, { name: "bob" }, { name: "carol" }],
      channels: [
        { from: "alice", to: "bob", capacity_ckb: 1000 },
        { from: "bob", to: "carol", capacity_ckb: 1000 },
      ],
      funding: { per_node_ckb: 100000 },
    });
    expect(raw).not.toMatch(/mainnet|private[_ -]?key|seed|token/i);
    expect(SANDBOX_TTL_MS).toBe(4 * 60 * 60 * 1000);
  });
});

describe("hosted sandbox control boundary", () => {
  it("allows operations only against the fixed network and blocks new topologies", async () => {
    const forge = {
      inspect: vi.fn(async (net) => ({ net })),
      inspectNode: vi.fn(async (net, node) => ({ net, node })),
      stopNode: vi.fn(async (net, node) => ({ net, node, action: "stop" })),
      startNode: vi.fn(async (net, node) => ({ net, node, action: "start" })),
      restartNode: vi.fn(async (net, node) => ({
        net,
        node,
        action: "restart",
      })),
      list: vi.fn(async () => [{ net: SANDBOX_NET }, { net: "unrelated" }]),
      channels: vi.fn(),
      pay: vi.fn(),
      openChannelBetween: vi.fn(),
      issueUdt: vi.fn(),
      closeChannel: vi.fn(),
      fund: vi.fn(),
      createInvoice: vi.fn(),
      logs: vi.fn(),
      down: vi.fn(),
    };
    const backend = createSandboxBackend(forge);

    await expect(backend.inspect(SANDBOX_NET)).resolves.toEqual({
      net: SANDBOX_NET,
    });
    expect(() => backend.inspect("other")).toThrow(
      'only permits network "sandbox"',
    );
    await expect(backend.list()).resolves.toEqual([{ net: SANDBOX_NET }]);
    await expect(backend.stopNode(SANDBOX_NET, "bob")).resolves.toMatchObject({
      action: "stop",
    });
    expect(() => backend.restartNode("other", "bob")).toThrow(
      'only permits network "sandbox"',
    );
    await expect(backend.up()).rejects.toThrow("topology is fixed");
    await expect(backend.openChannelBetween(SANDBOX_NET)).rejects.toThrow(
      "channel topology is fixed",
    );
    await expect(backend.issueUdt(SANDBOX_NET)).rejects.toThrow(
      "does not permit additional asset issuance",
    );
    await expect(backend.fund(SANDBOX_NET)).rejects.toThrow(
      "fixed funding allocation",
    );
    await backend.down(SANDBOX_NET, { keep: true });
    expect(forge.down).toHaveBeenCalledWith(SANDBOX_NET, {
      purge: true,
      keep: false,
    });
  });

  it("shows version, build, run, expiry, and payment identity", () => {
    const output = formatStatus({
      state: "ready",
      package: { name: "@truthixify/fiber-forge", version: "0.4.0-rc.1" },
      build: { commit: "abc123", dirty: true },
      runId: "space-run",
      expiresAt: "2026-10-20T12:00:00.000Z",
      payment: { amountCkb: 1, status: "Success", paymentHash: "0xproof" },
    });

    expect(output).toContain(
      "@truthixify/fiber-forge@0.4.0-rc.1 (abc123+dirty)",
    );
    expect(output).toContain("Run: space-run");
    expect(output).toContain("Expires: 2026-10-20T12:00:00.000Z");
    expect(output).toContain("alice -> carol, 1 CKB, Success (0xproof)");
  });

  it("redacts key-shaped data from persisted errors", () => {
    const secret = "a".repeat(64);
    const message = safeMessage(
      new Error(`private_key=${secret} payment=0x${secret}`),
    );

    expect(message).not.toContain(secret);
    expect(message).toContain("private_key=[REDACTED]");
    expect(message).toContain("payment=[REDACTED HEX]");
  });

  it("expires on schedule and cancels the pending timer after a manual stop", async () => {
    vi.useFakeTimers();
    try {
      const neverStops = new Promise(() => {});
      const expiry = waitForStopOrExpiry(1_000, neverStops);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(expiry).resolves.toBe("expired");

      let requestStop;
      const stopRequested = new Promise((resolvePromise) => {
        requestStop = resolvePromise;
      });
      const stopped = waitForStopOrExpiry(1_000, stopRequested);
      requestStop();
      await expect(stopped).resolves.toBe("stopped");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
