import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planLayout } from "../src/config";
import { type ContainerSpec, FakeEngine } from "../src/engine";
import { ForgeError } from "../src/errors";
import {
  FORGE_LABEL,
  Orchestrator,
  ckbContainerSpec,
  nodeContainerSpec,
} from "../src/orchestrator";
import { type Topology } from "../src/topology";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function occupyFreePort(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not allocate a TCP port");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

class FailingRunEngine extends FakeEngine {
  failRuns = false;
  observedPath?: string;
  observedPathPresent?: boolean;

  override async run(spec: ContainerSpec): Promise<void> {
    if (this.failRuns) {
      if (this.observedPath) {
        this.observedPathPresent = await pathExists(this.observedPath);
      }
      throw new ForgeError(
        "CONTAINER_START_FAILED",
        `injected start failure for ${spec.name}`,
        { resource: spec.name, action: "fix the injected failure" },
      );
    }
    await super.run(spec);
  }
}

class RemoveFailureEngine extends FakeEngine {
  override async remove(name: string): Promise<void> {
    if (name === "forge-alpha-ckb") {
      throw new ForgeError(
        "DOCKER_OPERATION_FAILED",
        `injected remove failure for ${name}`,
        { resource: name, action: "test-only injected failure" },
      );
    }
    await super.remove(name);
  }
}

class StopFailureEngine extends FakeEngine {
  override async stop(name: string): Promise<void> {
    throw new ForgeError(
      "DOCKER_OPERATION_FAILED",
      `injected stop failure for ${name}`,
      { resource: name, action: "test-only injected failure" },
    );
  }
}

const duo: Topology = {
  name: "duo",
  nodes: [{ name: "alice" }, { name: "bob" }],
  channels: [{ from: "alice", to: "bob", capacityCkb: 1000 }],
  funding: { perNodeCkb: 100000 },
};

describe("container specs", () => {
  const layout = planLayout(duo, { subnetBase: "10.5.7" });

  it("builds the ckb spec with the entrypoint, static ip, and mounted assets", () => {
    const spec = ckbContainerSpec(layout, "/abs/assets");
    expect(spec.name).toBe("forge-duo-ckb");
    expect(spec.ip).toBe("10.5.7.2");
    expect(spec.user).toBe("0");
    expect(spec.entrypoint).toEqual(["bash", "/assets/ckb-entrypoint.sh"]);
    expect(spec.volumes).toContainEqual({
      source: "/abs/assets",
      target: "/assets",
      readOnly: true,
    });
    expect(spec.labels).toEqual({ [FORGE_LABEL]: "duo" });
  });

  it("builds a node spec with the announce env, private-ip RPC, and mapped port", () => {
    const spec = nodeContainerSpec(layout, layout.nodes[0], "/state/node-1");
    expect(spec.name).toBe("forge-duo-node-1");
    expect(spec.ip).toBe("10.5.7.11");
    expect(spec.user).toBe(
      typeof process.getuid === "function" &&
        typeof process.getgid === "function"
        ? `${process.getuid()}:${process.getgid()}`
        : undefined,
    );
    expect(spec.env?.FIBER_SECRET_KEY_PASSWORD).toBe("forge-duo-alice");
    expect(spec.env?.FIBER_ANNOUNCE_PRIVATE_ADDR).toBe("true");
    expect(spec.env?.FIBER_LISTENING_ADDR).toBe("/ip4/0.0.0.0/tcp/8228");
    expect(spec.ports).toEqual([{ host: 8300, container: 8227 }]);
    expect(spec.volumes).toEqual([
      { source: "/state/node-1", target: "/fiber" },
    ]);
  });
});

describe("Orchestrator.down", () => {
  it("stops and removes every labeled container and the network", async () => {
    const engine = new FakeEngine();
    await engine.run({
      name: "forge-duo-ckb",
      image: "i",
      network: "forge-duo",
      volumes: [{ source: "forge-duo-ckb-data", target: "/data" }],
      labels: { [FORGE_LABEL]: "duo" },
    });
    await engine.run({
      name: "forge-duo-node-1",
      image: "i",
      network: "forge-duo",
      labels: { [FORGE_LABEL]: "duo" },
    });
    await engine.ensureNetwork("forge-duo", "172.30.0.0/16");
    expect(await engine.volumeExists("forge-duo-ckb-data")).toBe(true);

    await new Orchestrator(engine, "/assets").down("duo");

    expect(await engine.status("forge-duo-ckb")).toBe("absent");
    expect(await engine.status("forge-duo-node-1")).toBe("absent");
    expect(engine.networks.has("forge-duo")).toBe(false);
    expect(await engine.volumeExists("forge-duo-ckb-data")).toBe(false);
  });

  it("is idempotent when containers and state are already absent", async () => {
    const engine = new FakeEngine();
    const stateDir = await mkdtemp(join(tmpdir(), "forge-down-test-"));
    await rm(stateDir, { recursive: true, force: true });
    const orchestrator = new Orchestrator(engine, "/assets", stateDir);

    await orchestrator.down("missing", { purge: true });
    await orchestrator.down("missing", { purge: true });

    expect(await engine.status("forge-missing-ckb")).toBe("absent");
  });

  it("rejects an unsafe network name before touching files or Docker", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-name-test-"));
    const stateDir = join(root, "state");
    const outsideFile = join(root, "outside", "keep.txt");
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(outsideFile, "keep");
    const engine = new FakeEngine();

    await expect(
      new Orchestrator(engine, "/assets", stateDir).down("../outside", {
        purge: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_NETWORK_NAME",
      resource: "../outside",
    });

    expect(await pathExists(outsideFile)).toBe(true);
    expect(engine.log).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("tears one network down without touching another", async () => {
    const engine = new FakeEngine();
    for (const net of ["alpha", "beta"]) {
      await engine.ensureNetwork(`forge-${net}`, `10.1.${net.length}.0/24`);
      await engine.run({
        name: `forge-${net}-ckb`,
        image: "i",
        network: `forge-${net}`,
        volumes: [{ source: `forge-${net}-ckb-data`, target: "/data" }],
        labels: { [FORGE_LABEL]: net },
      });
    }

    await new Orchestrator(engine, "/assets").down("alpha");

    expect(await engine.status("forge-alpha-ckb")).toBe("absent");
    expect(await engine.status("forge-beta-ckb")).toBe("running");
    expect(engine.networks.has("forge-beta")).toBe(true);
    expect(await engine.volumeExists("forge-beta-ckb-data")).toBe(true);
  });

  it("continues teardown after a removal error without touching another network", async () => {
    const engine = new RemoveFailureEngine();
    const stateDir = await mkdtemp(join(tmpdir(), "forge-remove-test-"));
    const retainedState = join(stateDir, "alpha", "node", "fiber.db");
    await mkdir(join(stateDir, "alpha", "node"), { recursive: true });
    await writeFile(retainedState, "retain on failed remove");
    for (const net of ["alpha", "beta"]) {
      await engine.ensureNetwork(`forge-${net}`, `10.2.${net.length}.0/24`);
      await engine.run({
        name: `forge-${net}-ckb`,
        image: "i",
        network: `forge-${net}`,
        volumes: [{ source: `forge-${net}-ckb-data`, target: "/data" }],
        labels: { [FORGE_LABEL]: net },
      });
    }

    await expect(
      new Orchestrator(engine, "/assets", stateDir).down("alpha", {
        purge: true,
      }),
    ).rejects.toMatchObject({
      code: "DOCKER_OPERATION_FAILED",
      resource: "alpha",
    });

    expect(await engine.status("forge-alpha-ckb")).toBe("exited");
    expect(engine.networks.has("forge-alpha")).toBe(false);
    expect(await engine.volumeExists("forge-alpha-ckb-data")).toBe(false);
    expect(await pathExists(retainedState)).toBe(true);
    expect(await engine.status("forge-beta-ckb")).toBe("running");
    expect(engine.networks.has("forge-beta")).toBe(true);
    await rm(stateDir, { recursive: true, force: true });
  });

  it("succeeds when forced removal recovers from a stop failure", async () => {
    const engine = new StopFailureEngine();
    await engine.ensureNetwork("forge-alpha", "10.4.5.0/24");
    await engine.run({
      name: "forge-alpha-ckb",
      image: "i",
      network: "forge-alpha",
      labels: { [FORGE_LABEL]: "alpha" },
    });

    await new Orchestrator(engine, "/assets").down("alpha");

    expect(await engine.status("forge-alpha-ckb")).toBe("absent");
    expect(engine.networks.has("forge-alpha")).toBe(false);
  });

  it("discovers and removes an orphan network without a state directory", async () => {
    const engine = new FakeEngine();
    await engine.ensureNetwork("forge-orphan", "10.20.30.0/24");
    const stateDir = join(tmpdir(), `forge-missing-${Date.now()}`);

    const removed = await new Orchestrator(engine, "/assets", stateDir).downAll(
      { purge: true },
    );

    expect(removed).toEqual(["orphan"]);
    expect(engine.networks.has("forge-orphan")).toBe(false);
  });

  it("continues down --all after one network reports a teardown failure", async () => {
    const engine = new RemoveFailureEngine();
    for (const net of ["alpha", "beta"]) {
      await engine.ensureNetwork(`forge-${net}`, `10.3.${net.length}.0/24`);
      await engine.run({
        name: `forge-${net}-ckb`,
        image: "i",
        network: `forge-${net}`,
        labels: { [FORGE_LABEL]: net },
      });
    }

    await expect(
      new Orchestrator(engine, "/assets").downAll(),
    ).rejects.toMatchObject({
      code: "DOCKER_OPERATION_FAILED",
      resource: "alpha",
    });

    expect(await engine.status("forge-alpha-ckb")).toBe("exited");
    expect(await engine.status("forge-beta-ckb")).toBe("absent");
    expect(engine.networks.size).toBe(0);
  });
});

describe("Orchestrator.up preflight and rollback", () => {
  it("rejects an occupied requested port before creating resources", async () => {
    const occupied = await occupyFreePort();
    const engine = new FakeEngine();
    try {
      await expect(
        new Orchestrator(engine, "/assets").up(duo, {
          layout: { ckbHostPort: occupied.port },
        }),
      ).rejects.toMatchObject({
        code: "PORT_IN_USE",
        resource: `127.0.0.1:${occupied.port}`,
      });
      expect(engine.networks.size).toBe(0);
      expect(engine.containers.size).toBe(0);
    } finally {
      await occupied.close();
    }
  });

  it("rejects overlapping requested port ranges", async () => {
    const engine = new FakeEngine();
    await expect(
      new Orchestrator(engine, "/assets").up(duo, {
        layout: { ckbHostPort: 19100, rpcHostPortBase: 19100 },
      }),
    ).rejects.toMatchObject({ code: "PORT_IN_USE" });
    expect(engine.networks.size).toBe(0);
  });

  it("rejects an invalid requested port with a stable code", async () => {
    const engine = new FakeEngine();
    await expect(
      new Orchestrator(engine, "/assets").up(duo, {
        layout: { ckbHostPort: 0 },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_PORT",
      resource: "CKB RPC port",
    });
    expect(engine.networks.size).toBe(0);
  });

  it("does not replace a running network with the same name", async () => {
    const engine = new FakeEngine();
    await engine.ensureNetwork("forge-duo", "10.5.7.0/24");
    await engine.run({
      name: "forge-duo-ckb",
      image: "i",
      network: "forge-duo",
      labels: { [FORGE_LABEL]: "duo" },
    });

    await expect(
      new Orchestrator(engine, "/assets").up(duo),
    ).rejects.toMatchObject({ code: "NETWORK_EXISTS", resource: "duo" });
    expect(await engine.status("forge-duo-ckb")).toBe("running");
  });

  it("cleans stale resources and rolls back a start failure", async () => {
    const engine = new FailingRunEngine();
    await engine.ensureNetwork("forge-duo", "10.5.7.0/24");
    await engine.run({
      name: "forge-duo-stale",
      image: "i",
      network: "forge-duo",
      volumes: [{ source: "forge-duo-ckb-data", target: "/data" }],
      labels: { [FORGE_LABEL]: "duo" },
    });
    await engine.stop("forge-duo-stale");
    const stateDir = await mkdtemp(join(tmpdir(), "forge-rollback-test-"));
    const staleNodeState = join(stateDir, "duo", "forge-duo-node-1", "store");
    await mkdir(staleNodeState, { recursive: true });
    await writeFile(join(staleNodeState, "fiber.db"), "stale");
    engine.observedPath = staleNodeState;
    engine.failRuns = true;
    const orchestrator = new Orchestrator(engine, "/assets", stateDir);

    await expect(orchestrator.up(duo)).rejects.toMatchObject({
      code: "CONTAINER_START_FAILED",
      resource: "forge-duo-ckb",
    });

    expect(engine.containers.size).toBe(0);
    expect(engine.networks.size).toBe(0);
    expect(await engine.volumeExists("forge-duo-ckb-data")).toBe(false);
    expect(engine.observedPathPresent).toBe(false);
    expect(await pathExists(join(stateDir, "duo"))).toBe(false);
    await rm(stateDir, { recursive: true, force: true });
  });
});
