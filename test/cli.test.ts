import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, resolveTopology } from "../src/cli";

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
});
