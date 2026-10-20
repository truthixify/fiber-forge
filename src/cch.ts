/** Standalone Cross-Chain Hub planning, configuration, readiness, and lifecycle boundaries. */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { type UdtScript } from "./ckb.js";
import {
  type ContainerEngine,
  type ContainerSpec,
  type ContainerStatus,
} from "./engine.js";
import { ForgeError, errorDetails } from "./errors.js";
import { CCH_MACAROON_PATH, CCH_TLS_CERT_PATH } from "./lightning.js";
import { cchImages } from "./package-metadata.js";
import { HttpTransport, type RpcTransport } from "./rpc.js";

const MANAGED_LABEL = "fiber-forge";
const COMPONENT_LABEL = "fiber-forge.component";
export const CCH_RPC_PORT = 8_227;
export const DEFAULT_CCH_IMAGE = cchImages.cch;
export const DEFAULT_CCH_OPERATOR_TIMEOUT_MS = 60_000;
export const CCH_IP_SUFFIX = 203;

export interface CchOperatorPlan {
  schemaVersion: 1;
  net: string;
  network: string;
  image: string;
  container: string;
  ip: string;
  rpcHostPort: number;
  dataVolume: string;
  authVolume: string;
  hubFiberIp: string;
  hubLndContainer: string;
  wrappedTypeScript: UdtScript;
}

export interface CchOperatorStartOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface CchOperatorStatus {
  container: ContainerStatus;
  rpcReady: boolean;
  dataVolumePresent: boolean;
}

export interface CchOperatorController {
  start(
    plan: CchOperatorPlan,
    configDir: string,
    options?: CchOperatorStartOptions,
  ): Promise<CchOperatorStatus>;
  status(plan: CchOperatorPlan): Promise<CchOperatorStatus>;
  down(plan: CchOperatorPlan): Promise<void>;
}

export interface CchReadinessClient {
  ready(): Promise<boolean>;
}

export function cchDataVolumeName(net: string): string {
  return `forge-${net}-cch-data`;
}

export function planCchOperator(input: {
  net: string;
  network: string;
  subnetBase: string;
  rpcHostPort: number;
  hubFiberIp: string;
  wrappedTypeScript: UdtScript;
  image?: string;
}): CchOperatorPlan {
  const { net, network, subnetBase, rpcHostPort, hubFiberIp } = input;
  if (!/^\d{1,3}(?:\.\d{1,3}){2}$/.test(subnetBase)) {
    throw new ForgeError(
      "PROVISION_FAILED",
      `cannot plan CCH from subnet base "${subnetBase}"`,
      {
        resource: subnetBase,
        action: "recreate the network with a supported IPv4 /24 subnet",
      },
    );
  }
  const image = input.image ?? DEFAULT_CCH_IMAGE;
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new ForgeError(
      "PROVISION_FAILED",
      "CCH image must be pinned by sha256 digest",
      { resource: "cch", action: "use the reviewed digest-pinned CCH image" },
    );
  }
  return {
    schemaVersion: 1,
    net,
    network,
    image,
    container: `forge-${net}-cch`,
    ip: `${subnetBase}.${CCH_IP_SUFFIX}`,
    rpcHostPort,
    dataVolume: cchDataVolumeName(net),
    authVolume: `forge-${net}-cch-auth`,
    hubFiberIp,
    hubLndContainer: `forge-${net}-lnd-hub`,
    wrappedTypeScript: { ...input.wrappedTypeScript },
  };
}

/** Render only public topology data. LND credentials remain isolated in the auth volume. */
export function cchConfigYaml(plan: CchOperatorPlan): string {
  return stringifyYaml({
    rpc: {
      listening_addr: `${plan.ip}:${CCH_RPC_PORT}`,
      enabled_modules: ["cch"],
    },
    cch: {
      base_dir: "/fiber/cch",
      lnd_rpc_url: `https://${plan.hubLndContainer}:10009`,
      lnd_cert_path: CCH_TLS_CERT_PATH,
      lnd_macaroon_path: CCH_MACAROON_PATH,
      fiber_rpc_url: `http://${plan.hubFiberIp}:8227`,
      wrapped_btc_type_script: JSON.stringify(plan.wrappedTypeScript),
    },
    services: ["rpc", "cch"],
  });
}

export function cchContainerSpec(
  plan: CchOperatorPlan,
  configDir: string,
): ContainerSpec {
  return {
    name: plan.container,
    image: plan.image,
    network: plan.network,
    ip: plan.ip,
    entrypoint: ["/usr/local/bin/fnn"],
    cmd: ["-d", "/fiber", "-c", "/config/config.yml"],
    ports: [{ host: plan.rpcHostPort, container: CCH_RPC_PORT }],
    volumes: [
      { source: plan.dataVolume, target: "/fiber" },
      { source: configDir, target: "/config", readOnly: true },
      { source: plan.authVolume, target: "/cch-auth", readOnly: true },
    ],
    labels: {
      [MANAGED_LABEL]: plan.net,
      [COMPONENT_LABEL]: "cch-operator",
    },
  };
}

/** Minimal CCH client; transfer methods are added by the end-to-end proof task. */
export class CchRpc {
  constructor(private readonly transport: RpcTransport) {}

  static at(hostPort: number): CchRpc {
    return new CchRpc(new HttpTransport(`http://127.0.0.1:${hostPort}`, 5_000));
  }

  async ready(): Promise<boolean> {
    try {
      await this.transport.call("get_cch_order", [
        { payment_hash: `0x${"00".repeat(32)}` },
      ]);
      return true;
    } catch (error) {
      // An unknown key is the release's expected application response and proves RPC transport.
      return /key not found/i.test(errorDetails(error).message);
    }
  }
}

export class CchOperator implements CchOperatorController {
  constructor(
    private readonly engine: ContainerEngine,
    private readonly makeRpc: (
      hostPort: number,
    ) => CchReadinessClient = CchRpc.at,
  ) {}

  async start(
    plan: CchOperatorPlan,
    configDir: string,
    options: CchOperatorStartOptions = {},
  ): Promise<CchOperatorStatus> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CCH_OPERATOR_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ForgeError(
        "INVALID_TIMEOUT",
        "CCH operator timeout must be a positive finite number",
        { resource: "CCH timeout", action: "provide a positive timeout" },
      );
    }
    const deadline = Date.now() + timeoutMs;
    const progress = options.onProgress ?? (() => {});
    const check = () => {
      if (options.signal?.aborted) {
        throw new ForgeError(
          "OPERATION_ABORTED",
          `CCH operator provisioning for "${plan.net}" was aborted`,
          {
            resource: plan.container,
            action: "retry with a fresh AbortSignal when ready",
            cause: options.signal.reason,
          },
        );
      }
      if (Date.now() >= deadline) {
        throw new ForgeError(
          "OPERATION_TIMEOUT",
          `CCH operator "${plan.container}" did not become ready in ${timeoutMs}ms`,
          {
            resource: plan.container,
            action: "inspect the CCH container and its Fiber/LND dependencies",
          },
        );
      }
    };

    try {
      check();
      await rm(configDir, { recursive: true, force: true });
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "config.yml"), cchConfigYaml(plan), {
        mode: 0o600,
      });
      check();
      progress(`cch operator ${plan.container}`);
      await this.engine.run(cchContainerSpec(plan, configDir));
      const rpc = this.makeRpc(plan.rpcHostPort);
      for (;;) {
        check();
        if (await rpc.ready()) break;
        await wait(250, options.signal);
      }
      const status = await this.status(plan);
      if (!status.rpcReady) throw new Error("CCH RPC lost readiness");
      progress("cch operator ready");
      return status;
    } catch (error) {
      const primary =
        error instanceof ForgeError
          ? error
          : new ForgeError(
              "PROVISION_FAILED",
              `failed to provision CCH operator "${plan.container}"`,
              {
                resource: plan.container,
                action: "inspect the operator and its named dependencies",
                cause: error,
              },
            );
      try {
        await this.down(plan);
        await rm(configDir, { recursive: true, force: true });
      } catch (rollbackError) {
        throw new ForgeError(
          "ROLLBACK_FAILED",
          `${primary.message}; CCH rollback was incomplete: ${errorDetails(rollbackError).message}`,
          {
            resource: plan.net,
            action: `run "fiber-forge down ${plan.net} --purge"`,
            cause: new AggregateError([primary, rollbackError]),
          },
        );
      }
      throw primary;
    }
  }

  async status(plan: CchOperatorPlan): Promise<CchOperatorStatus> {
    const container = await this.engine.status(plan.container);
    return {
      container,
      rpcReady:
        container === "running"
          ? await this.makeRpc(plan.rpcHostPort)
              .ready()
              .catch(() => false)
          : false,
      dataVolumePresent: await this.engine.volumeExists(plan.dataVolume),
    };
  }

  async down(plan: CchOperatorPlan): Promise<void> {
    const failures: string[] = [];
    try {
      await this.engine.stop(plan.container);
    } catch (error) {
      failures.push(`stop ${plan.container}: ${errorDetails(error).message}`);
    }
    try {
      await this.engine.remove(plan.container);
    } catch (error) {
      failures.push(`remove ${plan.container}: ${errorDetails(error).message}`);
    }
    try {
      await this.engine.removeVolume(plan.dataVolume);
    } catch (error) {
      failures.push(
        `remove ${plan.dataVolume}: ${errorDetails(error).message}`,
      );
    }
    if (failures.length > 0) {
      throw new ForgeError(
        "DOCKER_OPERATION_FAILED",
        `CCH operator teardown for "${plan.net}" was incomplete: ${failures.join("; ")}`,
        {
          resource: plan.net,
          action: "fix the reported Docker resources and retry teardown",
        },
      );
    }
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("operation aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("operation aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
