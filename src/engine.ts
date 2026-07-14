/**
 * The container engine: the small surface of Docker operations the orchestrator needs, behind an
 * interface so the orchestration logic is testable against {@link FakeEngine} without Docker.
 * {@link DockerEngine} is the real implementation over `dockerode`.
 */

import Docker from "dockerode";

export type ContainerStatus = "running" | "exited" | "absent";

export interface PortBinding {
  host: number;
  container: number;
}

export interface VolumeBinding {
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface ContainerSpec {
  name: string;
  image: string;
  network: string;
  /** Static IP within the network's subnet. */
  ip?: string;
  /** Run-as user (e.g. `"0"` for root — a fresh named volume mounts root-owned). */
  user?: string;
  env?: Record<string, string>;
  ports?: PortBinding[];
  volumes?: VolumeBinding[];
  entrypoint?: string[];
  cmd?: string[];
  labels?: Record<string, string>;
}

export interface ContainerEngine {
  /** Create the network with the given subnet if it does not already exist. */
  ensureNetwork(name: string, subnet: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  /** Remove a named volume if it exists. */
  removeVolume(name: string): Promise<void>;
  /** Create and start a container from the spec (removing any prior container of that name). */
  run(spec: ContainerSpec): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  status(name: string): Promise<ContainerStatus>;
  logs(name: string, tailLines: number): Promise<string>;
  /** Names of containers carrying `label=value`. */
  listByLabel(label: string, value: string): Promise<string[]>;
  /** Net names (with the `forge-` prefix stripped) of every forge docker network, so a full
   * teardown can also remove networks whose state dir was already deleted. */
  forgeNets(): Promise<string[]>;
  /** The subnets (CIDR) of every existing network, so a new one can avoid overlaps. */
  usedSubnets(): Promise<string[]>;
}

/** An in-memory engine for unit tests and dry runs; records every spec and models status. */
export class FakeEngine implements ContainerEngine {
  readonly networks = new Map<string, string>();
  readonly containers = new Map<
    string,
    { spec: ContainerSpec; status: ContainerStatus }
  >();
  readonly log: string[] = [];

  async ensureNetwork(name: string, subnet: string): Promise<void> {
    if (!this.networks.has(name)) {
      this.networks.set(name, subnet);
      this.log.push(`network ${name} ${subnet}`);
    }
  }

  async removeNetwork(name: string): Promise<void> {
    this.networks.delete(name);
    this.log.push(`rm-network ${name}`);
  }

  async removeVolume(name: string): Promise<void> {
    this.log.push(`rm-volume ${name}`);
  }

  async run(spec: ContainerSpec): Promise<void> {
    this.containers.set(spec.name, { spec, status: "running" });
    this.log.push(
      `run ${spec.name} ${spec.image}${spec.ip ? " @" + spec.ip : ""}`,
    );
  }

  async stop(name: string): Promise<void> {
    const entry = this.containers.get(name);
    if (entry) {
      entry.status = "exited";
    }
    this.log.push(`stop ${name}`);
  }

  async remove(name: string): Promise<void> {
    this.containers.delete(name);
    this.log.push(`rm ${name}`);
  }

  async status(name: string): Promise<ContainerStatus> {
    return this.containers.get(name)?.status ?? "absent";
  }

  async logs(name: string): Promise<string> {
    return this.containers.has(name) ? `logs for ${name}` : "";
  }

  async listByLabel(label: string, value: string): Promise<string[]> {
    return [...this.containers.values()]
      .filter((c) => c.spec.labels?.[label] === value)
      .map((c) => c.spec.name);
  }

  async forgeNets(): Promise<string[]> {
    return [...this.networks.keys()]
      .filter((name) => name.startsWith("forge-"))
      .map((name) => name.slice("forge-".length));
  }

  async usedSubnets(): Promise<string[]> {
    return [...this.networks.values()];
  }
}

/** The real container engine over dockerode. */
export class DockerEngine implements ContainerEngine {
  private readonly docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  async ensureNetwork(name: string, subnet: string): Promise<void> {
    const existing = await this.docker.listNetworks({
      filters: { name: [name] },
    });
    const match = existing.find((n) => n.Name === name);
    if (match) {
      // Reuse only if the subnet matches; a stale network with a different subnet (left by a
      // crashed run) can't host the planned IPs, so tear it down and recreate it clean.
      const current = (match as { IPAM?: { Config?: { Subnet?: string }[] } })
        .IPAM?.Config?.[0]?.Subnet;
      if (current === subnet) {
        return;
      }
      await this.removeNetwork(name);
    }
    await this.docker.createNetwork({
      Name: name,
      IPAM: { Config: [{ Subnet: subnet }] },
    });
  }

  async removeNetwork(name: string): Promise<void> {
    try {
      const network = this.docker.getNetwork(name);
      const info = (await network.inspect()) as {
        Containers?: Record<string, unknown>;
      };
      for (const id of Object.keys(info.Containers ?? {})) {
        try {
          await network.disconnect({ Container: id, Force: true });
        } catch {
          // container already gone
        }
      }
      await network.remove();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).remove({ force: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async run(spec: ContainerSpec): Promise<void> {
    await this.remove(spec.name);
    await this.ensureImage(spec.image);

    const exposedPorts: Record<string, object> = {};
    const portBindings: Record<string, { HostPort: string }[]> = {};
    for (const p of spec.ports ?? []) {
      const key = `${p.container}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(p.host) }];
    }

    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      User: spec.user,
      Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      Entrypoint: spec.entrypoint,
      Cmd: spec.cmd,
      Labels: spec.labels,
      ExposedPorts: exposedPorts,
      HostConfig: {
        NetworkMode: spec.network,
        PortBindings: portBindings,
        Binds: (spec.volumes ?? []).map(
          (v) => `${v.source}:${v.target}${v.readOnly ? ":ro" : ""}`,
        ),
      },
      NetworkingConfig: spec.ip
        ? {
            EndpointsConfig: {
              [spec.network]: { IPAMConfig: { IPv4Address: spec.ip } },
            },
          }
        : undefined,
    });
    await container.start();
  }

  async stop(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).stop({ t: 3 });
    } catch (error) {
      if (!isNotFound(error) && !isNotRunning(error)) throw error;
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).remove({ force: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async status(name: string): Promise<ContainerStatus> {
    try {
      const info = await this.docker.getContainer(name).inspect();
      return info.State.Running ? "running" : "exited";
    } catch (error) {
      if (isNotFound(error)) return "absent";
      throw error;
    }
  }

  async logs(name: string, tailLines: number): Promise<string> {
    try {
      const buffer = (await this.docker.getContainer(name).logs({
        stdout: true,
        stderr: true,
        tail: tailLines,
      })) as unknown as Buffer;
      return demuxDockerLogs(buffer);
    } catch (error) {
      if (isNotFound(error)) return "";
      throw error;
    }
  }

  async listByLabel(label: string, value: string): Promise<string[]> {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: [`${label}=${value}`] },
    });
    return list.flatMap((c) => c.Names.map((n) => n.replace(/^\//, "")));
  }

  async forgeNets(): Promise<string[]> {
    const networks = await this.docker.listNetworks();
    return networks
      .map((n) => n.Name)
      .filter(
        (name): name is string => Boolean(name) && name.startsWith("forge-"),
      )
      .map((name) => name.slice("forge-".length));
  }

  async usedSubnets(): Promise<string[]> {
    const networks = await this.docker.listNetworks();
    return networks.flatMap((network) =>
      (network.IPAM?.Config ?? [])
        .map((config) => config.Subnet)
        .filter((subnet): subnet is string => Boolean(subnet)),
    );
  }

  private async ensureImage(image: string): Promise<void> {
    const images = await this.docker.listImages({
      filters: { reference: [image] },
    });
    if (images.length > 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err as Error);
        this.docker.modem.followProgress(stream, (done: unknown) =>
          done ? reject(done as Error) : resolve(),
        );
      });
    });
  }
}

/**
 * Decode Docker's multiplexed log stream into plain text. Non-TTY container logs arrive framed:
 * each chunk is an 8-byte header (stream id + big-endian payload length) followed by the payload.
 * Unframed (TTY) output is returned unchanged.
 */
function demuxDockerLogs(buffer: Buffer): string {
  const framed =
    buffer.length >= 8 &&
    buffer[0] <= 2 &&
    buffer[1] === 0 &&
    buffer[2] === 0 &&
    buffer[3] === 0;
  if (!framed) {
    return buffer.toString("utf8");
  }
  let out = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    out += buffer.toString(
      "utf8",
      start,
      Math.min(start + size, buffer.length),
    );
    offset = start + size;
  }
  return out;
}

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number })?.statusCode === 404;
}

function isNotRunning(error: unknown): boolean {
  return (error as { statusCode?: number })?.statusCode === 304;
}
