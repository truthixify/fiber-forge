import { type Server, createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { findFreePort, findFreePortBlock, isPortFree } from "../src/ports";

function occupy(port: number, host = "0.0.0.0"): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, host, () => resolve(server));
  });
}

describe("ports", () => {
  it("detects a free vs occupied port", async () => {
    const port = await findFreePort(8500);
    expect(await isPortFree(port)).toBe(true);
    const server = await occupy(port);
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      server.close();
    }
  });

  it("finds the next free port past an occupied one", async () => {
    const port = await findFreePort(8600);
    const server = await occupy(port);
    try {
      const next = await findFreePort(port);
      expect(next).toBeGreaterThan(port);
      expect(await isPortFree(next)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("finds a block of consecutive free ports", async () => {
    const base = await findFreePortBlock(8700, 3);
    for (let i = 0; i < 3; i += 1) {
      expect(await isPortFree(base + i)).toBe(true);
    }
  });

  it("counts a port held only on loopback as occupied", async () => {
    const port = await findFreePort(8800);
    const server = await occupy(port, "127.0.0.1");
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      server.close();
    }
  });

  it("skips past a port held only on loopback", async () => {
    const port = await findFreePort(8900);
    const server = await occupy(port, "127.0.0.1");
    try {
      expect(await findFreePort(port)).toBeGreaterThan(port);
    } finally {
      server.close();
    }
  });
});
