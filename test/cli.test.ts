import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCli, main, resolveTopology } from "../src/cli";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("resolveTopology", () => {
  it("resolves a preset name to its topology", async () => {
    const topology = await resolveTopology("trio");
    expect(topology.name).toBe("trio");
    expect(topology.nodes).toHaveLength(3);
  });

  it("rejects an unknown target that is not a file", async () => {
    await expect(
      resolveTopology("does-not-exist-preset-or-file"),
    ).rejects.toThrow();
  });

  it("emits a parseable structured error in JSON mode", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not allocate a TCP port");
    }
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await main([
        "node",
        "fiber-forge",
        "up",
        "duo",
        "--no-gui",
        "--json",
        "--ckb-port",
        String(address.port),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toEqual({
      ok: false,
      error: {
        code: "PORT_IN_USE",
        message: `CKB RPC port ${address.port} is already in use`,
        resource: `127.0.0.1:${address.port}`,
        action: `free port ${address.port} or choose a different port`,
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it("registers node lifecycle commands and preserves structured JSON failures", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await main([
      "node",
      "fiber-forge",
      "node",
      "inspect",
      "cli-node-missing",
      "alice",
      "--json",
    ]);

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
      ok: false,
      error: {
        code: "NETWORK_NOT_FOUND",
        resource: "cli-node-missing",
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it("registers the complete controlled-fault command surface", async () => {
    const fault = buildCli().commands.find(
      (command) => command.name() === "fault",
    );
    expect(fault?.commands.map((command) => command.name()).sort()).toEqual([
      "apply",
      "mine",
      "reset",
      "reset-all",
      "status",
    ]);

    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    await main([
      "node",
      "fiber-forge",
      "fault",
      "status",
      "cli-fault-missing",
      "--json",
    ]);
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
      ok: false,
      error: {
        code: "NETWORK_NOT_FOUND",
        resource: "cli-fault-missing",
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it("registers distinct cooperative, force-close, and settlement commands", () => {
    const channel = buildCli().commands.find(
      (command) => command.name() === "channel",
    );
    expect(channel?.commands.map((command) => command.name()).sort()).toEqual([
      "close",
      "force-close",
      "ls",
      "open",
      "settlement",
    ]);
    const forceClose = channel?.commands.find(
      (command) => command.name() === "force-close",
    );
    expect(
      forceClose?.options.find((option) => option.long === "--confirm")
        ?.mandatory,
    ).toBe(true);
  });

  it("registers export, inert bundle inspection, and replay commands", async () => {
    const cli = buildCli();
    expect(cli.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["export", "bundle", "replay"]),
    );
    const bundle = cli.commands.find((command) => command.name() === "bundle");
    expect(bundle?.commands.map((command) => command.name())).toEqual([
      "inspect",
    ]);

    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    await main([
      "node",
      "fiber-forge",
      "bundle",
      "inspect",
      "docs/examples/export-v1/failure.ffbundle",
      "--json",
    ]);
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
      integrity: "verified",
      redaction: "verified",
      recipe: { network: "bundle-sample", executions: 3 },
    });
  });

  it("registers the optional Lightning backend lifecycle and JSON status", async () => {
    const lightning = buildCli().commands.find(
      (command) => command.name() === "lightning",
    );
    expect(lightning?.commands.map((command) => command.name())).toEqual([
      "up",
      "status",
      "down",
    ]);

    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    await main([
      "node",
      "fiber-forge",
      "lightning",
      "status",
      "missing-lightning",
      "--json",
    ]);
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
      ok: false,
      error: {
        code: "NETWORK_NOT_FOUND",
        resource: "missing-lightning",
      },
    });
  });

  it("emits a structured force-close confirmation failure in JSON mode", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await main([
      "node",
      "fiber-forge",
      "channel",
      "force-close",
      "cli-force-close-missing",
      "alice",
      "0xchannel",
      "--confirm",
      "0xwrong",
      "--json",
    ]);

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
      ok: false,
      error: {
        code: "FORCE_CLOSE_CONFIRMATION_REQUIRED",
        resource: "cli-force-close-missing/alice/0xchannel",
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it("emits a scenario report and exit code 2 for failed assertions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fiber-forge-scenario-"));
    const file = join(directory, "failure.yml");
    await writeFile(
      file,
      [
        "version: 1",
        "steps:",
        "  - assert:",
        "      node_status: { node: alice, equals: running }",
        "      timeout_ms: 0",
      ].join("\n"),
    );
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await main([
        "node",
        "fiber-forge",
        "run",
        "cli-scenario-missing",
        file,
        "--json",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
      format: "fiber-forge-scenario-report",
      version: 1,
      network: "cli-scenario-missing",
      passed: false,
      summary: { total: 1, passed: 0, failed: 1 },
      steps: [
        {
          action: "assert",
          passed: false,
          assertions: [
            {
              type: "node_status",
              passed: false,
              actual: { errorCode: "NETWORK_NOT_FOUND" },
            },
          ],
        },
      ],
    });
    expect(process.exitCode).toBe(2);
  });
});
