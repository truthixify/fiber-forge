import type Docker from "dockerode";
import { PassThrough } from "node:stream";
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
    await e.ensureNetwork("forge-x", "172.30.0.0/16", {
      labels: { "fiber-forge": "x" },
    });
    await e.ensureNetwork("forge-x", "172.30.0.0/16", {
      labels: { "fiber-forge": "x" },
    });
    expect(e.networks.get("forge-x")).toBe("172.30.0.0/16");
    expect(await e.getNetworkLabels("forge-x")).toEqual({
      "fiber-forge": "x",
    });
    expect(e.log.filter((l) => l.startsWith("network")).length).toBe(1);
  });

  it("does not claim a same-named network with different labels", async () => {
    const e = new FakeEngine();
    await e.ensureNetwork("ffault-x-1", "172.30.0.0/16", {
      labels: { owner: "external" },
    });

    await expect(
      e.ensureNetwork("ffault-x-1", "172.31.0.0/16", {
        labels: { "fiber-forge": "x" },
      }),
    ).rejects.toMatchObject({
      code: "DOCKER_OPERATION_FAILED",
      resource: "ffault-x-1",
    });
    expect(await e.getNetworkLabels("ffault-x-1")).toEqual({
      owner: "external",
    });
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

  it("models abrupt termination and scoped network attachments", async () => {
    const e = new FakeEngine();
    await e.ensureNetwork("forge-x", "172.30.0.0/24");
    await e.ensureNetwork("ffault-x-1", "172.31.0.0/24");
    await e.run({
      name: "n1",
      image: "img",
      network: "forge-x",
      ip: "172.30.0.11",
    });

    await e.connectNetwork("ffault-x-1", "n1", { ip: "172.31.0.11" });
    await e.disconnectNetwork("forge-x", "n1");
    expect(await e.networkConnected("forge-x", "n1")).toBe(false);
    expect(await e.networkConnected("ffault-x-1", "n1")).toBe(true);
    expect(await e.networkExists("ffault-x-1")).toBe(true);

    await expect(e.removeNetwork("ffault-x-1")).rejects.toMatchObject({
      code: "DOCKER_OPERATION_FAILED",
      resource: "ffault-x-1",
    });
    expect(await e.networkConnected("ffault-x-1", "n1")).toBe(true);

    await e.kill("n1");
    expect(await e.status("n1")).toBe("exited");
    expect(await e.faultCapabilities()).toEqual({
      abruptKill: true,
      networkIsolation: true,
    });
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

  it("executes through a fixture without recording command arguments", async () => {
    const e = new FakeEngine();
    await e.run({ name: "n1", image: "img", network: "forge-x" });
    e.execHandler = async (_name, command) => ({
      exitCode: 0,
      stdout: command.at(-1) ?? "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });

    const secret = "runtime-secret-value";
    expect(
      await e.exec("n1", ["client", `--password=${secret}`]),
    ).toMatchObject({
      exitCode: 0,
      stdout: `--password=${secret}`,
    });
    expect(e.log).toContain("exec n1 client");
    expect(e.log.join("\n")).not.toContain(secret);
  });

  it("rejects exec against an absent or stopped container", async () => {
    const e = new FakeEngine();
    await expect(e.exec("missing", ["true"])).rejects.toMatchObject({
      code: "CONTAINER_NOT_FOUND",
    });
    await e.run({ name: "n1", image: "img", network: "forge-x" });
    await e.stop("n1");
    await expect(e.exec("n1", ["true"])).rejects.toMatchObject({
      code: "DOCKER_OPERATION_FAILED",
    });
  });
});

describe("DockerEngine errors", () => {
  it("labels newly created managed networks", async () => {
    const createNetwork = vi.fn().mockResolvedValue({});
    const docker = {
      listNetworks: vi.fn().mockResolvedValue([]),
      createNetwork,
    } as unknown as Docker;

    await new DockerEngine(docker).ensureNetwork(
      "ffault-x-1",
      "172.31.0.0/24",
      {
        labels: { "fiber-forge": "x", "fiber-forge.fault": "true" },
      },
    );

    expect(createNetwork).toHaveBeenCalledWith({
      Name: "ffault-x-1",
      Labels: { "fiber-forge": "x", "fiber-forge.fault": "true" },
      IPAM: { Config: [{ Subnet: "172.31.0.0/24" }] },
    });
  });

  it("publishes container RPC ports on IPv4 loopback only", async () => {
    const createContainer = vi.fn().mockResolvedValue({ start: vi.fn() });
    const docker = {
      getContainer: vi.fn(() => removableContainer()),
      listImages: vi.fn().mockResolvedValue([{}]),
      createContainer,
    } as unknown as Docker;

    await new DockerEngine(docker).run({
      name: "n1",
      image: "fnn:test",
      network: "forge-test",
      ports: [{ host: 8300, container: 8227 }],
    });

    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        HostConfig: expect.objectContaining({
          PortBindings: {
            "8227/tcp": [{ HostIp: "127.0.0.1", HostPort: "8300" }],
          },
        }),
      }),
    );
  });

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

  it("captures bounded exec output and preserves the exit code", async () => {
    const stream = new PassThrough();
    stream.end("abcdef");
    const inspect = vi.fn().mockResolvedValue({ ExitCode: 7 });
    const start = vi.fn().mockResolvedValue(stream);
    const exec = vi.fn().mockResolvedValue({ start, inspect });
    const docker = {
      getContainer: vi.fn(() => ({ exec })),
      modem: {
        demuxStream: vi.fn(
          (source: PassThrough, stdout: PassThrough, _stderr: PassThrough) =>
            source.on("data", (chunk) => stdout.write(chunk)),
        ),
      },
    } as unknown as Docker;

    const result = await new DockerEngine(docker).exec(
      "n1",
      ["client", "sensitive-argument"],
      { maxOutputBytes: 3 },
    );

    expect(result).toEqual({
      exitCode: 7,
      stdout: "abc",
      stderr: "",
      stdoutTruncated: true,
      stderrTruncated: false,
    });
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ Cmd: ["client", "sensitive-argument"] }),
    );
  });

  it("does not expose exec arguments in wrapped Docker errors", async () => {
    const secret = "do-not-report-this";
    const docker = {
      getContainer: vi.fn(() => ({
        exec: vi.fn().mockRejectedValue(new Error(`bad argument ${secret}`)),
      })),
    } as unknown as Docker;

    await expect(
      new DockerEngine(docker).exec("n1", ["client", secret]),
    ).rejects.toMatchObject({
      code: "DOCKER_OPERATION_FAILED",
      message: 'could not execute a command in container "n1"',
      resource: "n1",
    });
  });
});
