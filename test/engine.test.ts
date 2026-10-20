import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { DockerEngine, FakeEngine } from "../src/engine";

function dockerError(message: string, fields: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), fields);
}

function removableContainer() {
  return {
    remove: vi
      .fn()
      .mockRejectedValue(dockerError("missing", { statusCode: 404 })),
  };
}

describe("FakeEngine", () => {
  it("creates a network idempotently", async () => {
    const e = new FakeEngine();
    await e.ensureNetwork("forge-x", "172.30.0.0/16");
    await e.ensureNetwork("forge-x", "172.30.0.0/16");
    expect(e.networks.get("forge-x")).toBe("172.30.0.0/16");
    expect(e.log.filter((l) => l.startsWith("network")).length).toBe(1);
  });

  it("models the container lifecycle", async () => {
    const e = new FakeEngine();
    expect(await e.status("n1")).toBe("absent");
    await e.run({
      name: "n1",
      image: "img",
      network: "forge-x",
      ip: "172.30.0.11",
      labels: { forge: "x" },
    });
    expect(await e.status("n1")).toBe("running");
    await e.stop("n1");
    expect(await e.status("n1")).toBe("exited");
    await e.start("n1");
    expect(await e.status("n1")).toBe("running");
    await e.remove("n1");
    expect(await e.status("n1")).toBe("absent");
  });

  it("rejects starting a container that no longer exists", async () => {
    const e = new FakeEngine();
    await expect(e.start("missing")).rejects.toMatchObject({
      code: "CONTAINER_NOT_FOUND",
      resource: "missing",
    });
  });

  it("lists containers by label", async () => {
    const e = new FakeEngine();
    await e.run({
      name: "a",
      image: "i",
      network: "n",
      labels: { forge: "x" },
    });
    await e.run({
      name: "b",
      image: "i",
      network: "n",
      labels: { forge: "y" },
    });
    expect(await e.listByLabel("forge", "x")).toEqual(["a"]);
  });
});

describe("DockerEngine errors", () => {
  it("classifies an unavailable Docker daemon", async () => {
    const docker = {
      listNetworks: vi.fn().mockRejectedValue(
        dockerError("connect ENOENT /var/run/docker.sock", {
          code: "ENOENT",
        }),
      ),
    } as unknown as Docker;

    await expect(new DockerEngine(docker).usedSubnets()).rejects.toMatchObject({
      code: "DOCKER_UNAVAILABLE",
      resource: "Docker daemon",
      action: "start Docker and retry",
    });
  });

  it("classifies image pull failures with the image name", async () => {
    const docker = {
      getContainer: vi.fn(() => removableContainer()),
      listImages: vi.fn().mockResolvedValue([]),
      pull: vi.fn(
        (
          _image: string,
          callback: (error: Error, stream?: NodeJS.ReadableStream) => void,
        ) => callback(new Error("registry denied")),
      ),
      modem: { followProgress: vi.fn() },
    } as unknown as Docker;
    const engine = new DockerEngine(docker);

    await expect(
      engine.run({ name: "n1", image: "registry/fnn:test", network: "n" }),
    ).rejects.toMatchObject({
      code: "IMAGE_PULL_FAILED",
      resource: "registry/fnn:test",
    });
  });

  it("classifies container start failures with the container name", async () => {
    const docker = {
      getContainer: vi.fn(() => removableContainer()),
      listImages: vi.fn().mockResolvedValue([{}]),
      createContainer: vi.fn().mockResolvedValue({
        start: vi
          .fn()
          .mockRejectedValue(new Error("port is already allocated")),
      }),
    } as unknown as Docker;
    const engine = new DockerEngine(docker);

    await expect(
      engine.run({ name: "n1", image: "fnn:test", network: "n" }),
    ).rejects.toMatchObject({
      code: "CONTAINER_START_FAILED",
      resource: "n1",
    });
  });
});
