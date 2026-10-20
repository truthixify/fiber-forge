/**
 * Disposable Bitcoin regtest and two-node LND backend used by the local CCH topology. The module
 * owns only Lightning-side resources on an existing managed Docker network; Fiber orchestration
 * remains independent and does not load these images unless this backend is explicitly started.
 */

import {
  type ContainerEngine,
  type ContainerSpec,
  type ContainerStatus,
} from "./engine.js";
import { ForgeError, errorDetails } from "./errors.js";
import { cchImages } from "./package-metadata.js";

const MANAGED_LABEL = "fiber-forge";
const COMPONENT_LABEL = "fiber-forge.component";
const BITCOIN_DATA_DIR = "/home/bitcoin/.bitcoin";
const LND_DATA_DIR = "/root/.lnd";
const BITCOIN_RPC_PORT = 18_443;
const BITCOIN_ZMQ_BLOCK_PORT = 28_332;
const BITCOIN_ZMQ_TX_PORT = 28_333;
const LND_P2P_PORT = 9_735;
const LND_RPC_PORT = 10_009;

export const DEFAULT_BITCOIN_IMAGE = cchImages.bitcoin;
export const DEFAULT_LND_IMAGE = cchImages.lnd;
export const DEFAULT_LIGHTNING_BACKEND_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_LIGHTNING_CHANNEL_SATS = 1_000_000;
export const CCH_MACAROON_PATH = "/cch-auth/cch.macaroon";
export const CCH_TLS_CERT_PATH = "/cch-auth/tls.cert";

export interface LightningBackendImages {
  bitcoin: string;
  lnd: string;
}

export interface LightningBackendPlan {
  schemaVersion: 1;
  net: string;
  network: string;
  subnet: string;
  images: LightningBackendImages;
  containers: {
    bitcoin: string;
    hub: string;
    user: string;
  };
  ips: {
    bitcoin: string;
    hub: string;
    user: string;
  };
  volumes: {
    bitcoin: string;
    hub: string;
    user: string;
    cchAuth: string;
  };
  channelCapacitySats: number;
}

export interface LightningBackendStartOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface LightningComponentStatus {
  container: ContainerStatus;
  syncedToChain: boolean | null;
  blockHeight: number | null;
  activeChannels: number | null;
  localBalanceSats: number | null;
}

export interface LightningBackendStatus {
  schemaVersion: 1;
  kind: "lightning-backend";
  net: string;
  state: "ready" | "degraded" | "absent";
  bitcoin: {
    container: ContainerStatus;
    blockHeight: number | null;
  };
  hub: LightningComponentStatus;
  user: LightningComponentStatus;
  channel: {
    active: boolean;
    capacitySats: number;
    hubLocalSats: number;
    userLocalSats: number;
  } | null;
  dataVolumesPresent: boolean;
}

/** Narrow backend contract used by the CCH orchestrator. */
export interface LightningBackendController {
  start(
    plan: LightningBackendPlan,
    options?: LightningBackendStartOptions,
  ): Promise<LightningBackendStatus>;
  status(plan: LightningBackendPlan): Promise<LightningBackendStatus>;
  down(plan: LightningBackendPlan): Promise<void>;
}

interface BitcoinBlockchainInfo {
  blocks: number;
}

interface LndInfo {
  identity_pubkey?: string;
  block_height?: number | string;
  synced_to_chain?: boolean;
}

interface LndChannel {
  active?: boolean;
  capacity?: number | string;
  local_balance?: number | string;
}

interface LndChannels {
  channels?: LndChannel[];
}

interface InternalLndStatus extends LightningComponentStatus {
  channels: Array<{
    active: boolean;
    capacitySats: number;
    localBalanceSats: number;
  }>;
}

/** Deterministic names and private addresses for a backend on an existing /24 forge network. */
export function planLightningBackend(
  net: string,
  network: string,
  subnetBase: string,
  images: LightningBackendImages = {
    bitcoin: DEFAULT_BITCOIN_IMAGE,
    lnd: DEFAULT_LND_IMAGE,
  },
): LightningBackendPlan {
  if (!/^\d{1,3}(?:\.\d{1,3}){2}$/.test(subnetBase)) {
    throw new ForgeError(
      "PROVISION_FAILED",
      `cannot plan the Lightning backend from subnet base "${subnetBase}"`,
      {
        resource: subnetBase,
        action: "recreate the Fiber network with a supported IPv4 /24 subnet",
      },
    );
  }
  const octets = subnetBase.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    throw new ForgeError(
      "PROVISION_FAILED",
      `cannot plan the Lightning backend from subnet base "${subnetBase}"`,
      {
        resource: subnetBase,
        action: "recreate the Fiber network with a supported IPv4 /24 subnet",
      },
    );
  }
  for (const [component, image] of Object.entries(images)) {
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
      throw new ForgeError(
        "PROVISION_FAILED",
        `${component} backend image must be pinned by sha256 digest`,
        {
          resource: component,
          action: "use the reviewed digest-pinned CCH image",
        },
      );
    }
  }

  return {
    schemaVersion: 1,
    net,
    network,
    subnet: `${subnetBase}.0/24`,
    images: { ...images },
    containers: {
      bitcoin: `forge-${net}-bitcoin`,
      hub: `forge-${net}-lnd-hub`,
      user: `forge-${net}-lnd-user`,
    },
    ips: {
      bitcoin: `${subnetBase}.200`,
      hub: `${subnetBase}.201`,
      user: `${subnetBase}.202`,
    },
    volumes: lightningVolumeNames(net),
    channelCapacitySats: DEFAULT_LIGHTNING_CHANNEL_SATS,
  };
}

export function lightningVolumeNames(
  net: string,
): LightningBackendPlan["volumes"] {
  return {
    bitcoin: `forge-${net}-bitcoin-data`,
    hub: `forge-${net}-lnd-hub-data`,
    user: `forge-${net}-lnd-user-data`,
    cchAuth: `forge-${net}-cch-auth`,
  };
}

export function bitcoinContainerSpec(
  plan: LightningBackendPlan,
): ContainerSpec {
  return {
    name: plan.containers.bitcoin,
    image: plan.images.bitcoin,
    network: plan.network,
    ip: plan.ips.bitcoin,
    cmd: [
      "-regtest=1",
      "-server=1",
      "-txindex=1",
      "-fallbackfee=0.0002",
      `-rpcbind=0.0.0.0:${BITCOIN_RPC_PORT}`,
      `-rpcallowip=${plan.subnet}`,
      `-zmqpubrawblock=tcp://0.0.0.0:${BITCOIN_ZMQ_BLOCK_PORT}`,
      `-zmqpubrawtx=tcp://0.0.0.0:${BITCOIN_ZMQ_TX_PORT}`,
      "-printtoconsole=1",
    ],
    volumes: [{ source: plan.volumes.bitcoin, target: BITCOIN_DATA_DIR }],
    labels: {
      [MANAGED_LABEL]: plan.net,
      [COMPONENT_LABEL]: "bitcoin-regtest",
    },
  };
}

export function lndContainerSpec(
  plan: LightningBackendPlan,
  role: "hub" | "user",
): ContainerSpec {
  const name = plan.containers[role];
  return {
    name,
    image: plan.images.lnd,
    network: plan.network,
    ip: plan.ips[role],
    cmd: [
      `--lnddir=${LND_DATA_DIR}`,
      "--noseedbackup",
      "--bitcoin.active",
      "--bitcoin.regtest",
      "--bitcoin.node=bitcoind",
      `--bitcoind.rpchost=${plan.containers.bitcoin}:${BITCOIN_RPC_PORT}`,
      `--bitcoind.rpccookie=/bitcoin/regtest/.cookie`,
      `--bitcoind.zmqpubrawblock=tcp://${plan.containers.bitcoin}:${BITCOIN_ZMQ_BLOCK_PORT}`,
      `--bitcoind.zmqpubrawtx=tcp://${plan.containers.bitcoin}:${BITCOIN_ZMQ_TX_PORT}`,
      `--listen=0.0.0.0:${LND_P2P_PORT}`,
      `--rpclisten=0.0.0.0:${LND_RPC_PORT}`,
      "--norest",
      `--tlsextradomain=${name}`,
      "--bitcoin.defaultchanconfs=1",
      "--debuglevel=info",
    ],
    volumes: [
      { source: plan.volumes[role], target: LND_DATA_DIR },
      {
        source: plan.volumes.bitcoin,
        target: "/bitcoin",
        readOnly: true,
      },
      ...(role === "hub"
        ? [{ source: plan.volumes.cchAuth, target: "/cch-auth" }]
        : []),
    ],
    labels: {
      [MANAGED_LABEL]: plan.net,
      [COMPONENT_LABEL]: `lnd-${role}`,
    },
  };
}

class BackendGuard {
  private readonly deadline: number;

  constructor(
    private readonly net: string,
    private readonly timeoutMs: number,
    readonly signal?: AbortSignal,
  ) {
    this.deadline = Date.now() + timeoutMs;
  }

  check(resource: string): void {
    if (this.signal?.aborted) {
      throw new ForgeError(
        "OPERATION_ABORTED",
        `Lightning backend provisioning for "${this.net}" was aborted at ${resource}`,
        {
          resource,
          action: "retry with a fresh AbortSignal when ready",
          cause: this.signal.reason,
        },
      );
    }
    if (Date.now() >= this.deadline) {
      throw new ForgeError(
        "OPERATION_TIMEOUT",
        `Lightning backend provisioning for "${this.net}" exceeded its ${this.timeoutMs}ms timeout at ${resource}`,
        {
          resource,
          action: "increase the backend timeout or inspect the named component",
        },
      );
    }
  }

  async wait(resource: string, delayMs = 500): Promise<void> {
    this.check(resource);
    const timeoutMs = Math.max(
      0,
      Math.min(delayMs, this.deadline - Date.now()),
    );
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () =>
        finish(() => {
          try {
            this.check(resource);
          } catch (error) {
            reject(error);
          }
        });
      const timer = setTimeout(() => finish(resolve), timeoutMs);
      this.signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.check(resource);
  }
}

class BitcoinCli {
  constructor(
    private readonly engine: ContainerEngine,
    private readonly container: string,
    private readonly signal?: AbortSignal,
  ) {}

  private command(args: readonly string[]): string[] {
    return ["bitcoin-cli", `-datadir=${BITCOIN_DATA_DIR}`, "-regtest", ...args];
  }

  async blockchainInfo(): Promise<BitcoinBlockchainInfo> {
    return checkedJson<BitcoinBlockchainInfo>(
      this.engine,
      this.container,
      this.command(["getblockchaininfo"]),
      "Bitcoin chain readiness",
      this.signal,
    );
  }

  async createWallet(): Promise<void> {
    await checkedJson(
      this.engine,
      this.container,
      this.command([
        "-named",
        "createwallet",
        "wallet_name=forge",
        "descriptors=true",
        "load_on_startup=true",
      ]),
      "Bitcoin wallet creation",
      this.signal,
    );
  }

  async newAddress(): Promise<string> {
    const result = await checkedExec(
      this.engine,
      this.container,
      this.command(["-rpcwallet=forge", "getnewaddress", "", "bech32"]),
      "Bitcoin address creation",
      this.signal,
    );
    const address = result.stdout.trim();
    if (!/^bcrt1[0-9a-z]+$/.test(address)) {
      throw malformedOutput("Bitcoin address creation", this.container);
    }
    return address;
  }

  async generate(blocks: number, address: string): Promise<void> {
    await checkedJson(
      this.engine,
      this.container,
      this.command(["generatetoaddress", String(blocks), address]),
      "Bitcoin block generation",
      this.signal,
    );
  }

  async sendToAddress(address: string, bitcoins: number): Promise<void> {
    const result = await checkedExec(
      this.engine,
      this.container,
      this.command([
        "-rpcwallet=forge",
        "sendtoaddress",
        address,
        String(bitcoins),
      ]),
      "Bitcoin wallet funding",
      this.signal,
    );
    if (!/^[0-9a-f]{64}$/.test(result.stdout.trim())) {
      throw malformedOutput("Bitcoin wallet funding", this.container);
    }
  }
}

class LndCli {
  constructor(
    private readonly engine: ContainerEngine,
    private readonly container: string,
    private readonly signal?: AbortSignal,
  ) {}

  private command(args: readonly string[]): string[] {
    return [
      "lncli",
      "--network=regtest",
      `--lnddir=${LND_DATA_DIR}`,
      `--rpcserver=localhost:${LND_RPC_PORT}`,
      ...args,
    ];
  }

  info(): Promise<LndInfo> {
    return checkedJson(
      this.engine,
      this.container,
      this.command(["getinfo"]),
      "LND readiness",
      this.signal,
    );
  }

  channels(): Promise<LndChannels> {
    return checkedJson(
      this.engine,
      this.container,
      this.command(["listchannels"]),
      "LND channel inspection",
      this.signal,
    );
  }

  async newAddress(): Promise<string> {
    const response = await checkedJson<{ address?: string }>(
      this.engine,
      this.container,
      this.command(["newaddress", "p2wkh"]),
      "LND funding address creation",
      this.signal,
    );
    if (!response.address || !/^bcrt1[0-9a-z]+$/.test(response.address)) {
      throw malformedOutput("LND funding address creation", this.container);
    }
    return response.address;
  }

  async bakeCchMacaroon(): Promise<void> {
    await checkedExec(
      this.engine,
      this.container,
      this.command([
        "bakemacaroon",
        `--save_to=${CCH_MACAROON_PATH}`,
        "invoices:read",
        "invoices:write",
        "offchain:read",
        "offchain:write",
      ]),
      "CCH macaroon creation",
      this.signal,
    );
    await checkedExec(
      this.engine,
      this.container,
      ["cp", `${LND_DATA_DIR}/tls.cert`, CCH_TLS_CERT_PATH],
      "CCH TLS certificate staging",
      this.signal,
    );
  }

  async openChannel(
    peerPublicKey: string,
    peerHost: string,
    amountSats: number,
  ): Promise<void> {
    await checkedExec(
      this.engine,
      this.container,
      this.command([
        "openchannel",
        `--node_key=${peerPublicKey}`,
        `--connect=${peerHost}:${LND_P2P_PORT}`,
        `--local_amt=${amountSats}`,
        "--sat_per_vbyte=1",
        "--min_confs=1",
      ]),
      "Lightning channel creation",
      this.signal,
    );
  }
}

export class LightningBackend implements LightningBackendController {
  constructor(private readonly engine: ContainerEngine) {}

  async start(
    plan: LightningBackendPlan,
    options: LightningBackendStartOptions = {},
  ): Promise<LightningBackendStatus> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LIGHTNING_BACKEND_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ForgeError(
        "INVALID_TIMEOUT",
        "Lightning backend timeout must be a positive finite number",
        {
          resource: "LightningBackendStartOptions.timeoutMs",
          action: "provide a positive timeout in milliseconds",
        },
      );
    }
    const guard = new BackendGuard(plan.net, timeoutMs, options.signal);
    const progress = options.onProgress ?? (() => {});
    let phase = "backend preflight";

    try {
      guard.check(phase);
      const labels = await this.engine.getNetworkLabels(plan.network);
      if (labels?.[MANAGED_LABEL] !== plan.net) {
        throw new ForgeError(
          "PROVISION_FAILED",
          `managed Docker network "${plan.network}" is unavailable`,
          {
            resource: plan.network,
            action: `start the Fiber network "${plan.net}" before its Lightning backend`,
          },
        );
      }

      phase = "stale Lightning backend cleanup";
      progress("removing stale Lightning backend resources");
      await this.down(plan);
      guard.check(phase);

      phase = `Bitcoin container ${plan.containers.bitcoin}`;
      progress("starting Bitcoin regtest");
      await this.engine.run(bitcoinContainerSpec(plan));
      const bitcoin = new BitcoinCli(
        this.engine,
        plan.containers.bitcoin,
        guard.signal,
      );
      await this.waitForBitcoin(bitcoin, guard, phase);

      phase = "Bitcoin regtest initialization";
      progress("initializing Bitcoin regtest wallet and spendable funds");
      await bitcoin.createWallet();
      const miningAddress = await bitcoin.newAddress();
      await bitcoin.generate(101, miningAddress);
      await this.waitForBitcoinHeight(bitcoin, 101, guard, phase);

      phase = "LND containers";
      progress("starting hub and user LND nodes");
      await this.engine.run(lndContainerSpec(plan, "hub"));
      guard.check(phase);
      await this.engine.run(lndContainerSpec(plan, "user"));
      const hub = new LndCli(this.engine, plan.containers.hub, guard.signal);
      const user = new LndCli(this.engine, plan.containers.user, guard.signal);
      await this.waitForLndSync(hub, user, 101, guard, phase);

      phase = "CCH LND authorization";
      progress("creating restricted CCH macaroon");
      await hub.bakeCchMacaroon();
      guard.check(phase);

      phase = "hub LND funding";
      progress("funding the hub LND wallet");
      const hubAddress = await hub.newAddress();
      await bitcoin.sendToAddress(hubAddress, 5);
      await bitcoin.generate(6, miningAddress);
      await this.waitForLndSync(hub, user, 107, guard, phase);

      phase = "Lightning channel creation";
      progress("opening the hub-to-user Lightning channel");
      const userInfo = await user.info();
      const userPublicKey = userInfo.identity_pubkey;
      if (!userPublicKey || !/^[0-9a-f]{66}$/.test(userPublicKey)) {
        throw malformedOutput("LND identity inspection", plan.containers.user);
      }
      await hub.openChannel(
        userPublicKey,
        plan.containers.user,
        plan.channelCapacitySats,
      );
      await bitcoin.generate(6, miningAddress);
      await this.waitForLndSync(hub, user, 113, guard, phase);
      await this.waitForActiveChannel(plan, hub, user, guard, phase);

      phase = "Lightning backend readiness";
      const status = await this.status(plan);
      if (status.state !== "ready") {
        throw new ForgeError(
          "PROVISION_FAILED",
          `Lightning backend for "${plan.net}" did not reach ready state`,
          {
            resource: plan.net,
            action: "inspect the sanitized backend status and container logs",
          },
        );
      }
      progress("Lightning backend ready");
      guard.check(phase);
      return status;
    } catch (error) {
      let controlError: unknown;
      try {
        guard.check(phase);
      } catch (guardError) {
        controlError = guardError;
      }
      const primary =
        controlError instanceof ForgeError
          ? controlError
          : error instanceof ForgeError
            ? error
            : new ForgeError(
                "PROVISION_FAILED",
                `failed to provision the Lightning backend for "${plan.net}" at ${phase}`,
                {
                  resource: phase,
                  action: "inspect the named component and retry",
                  cause: error,
                },
              );
      try {
        await this.down(plan);
      } catch (rollbackError) {
        throw new ForgeError(
          "ROLLBACK_FAILED",
          `${primary.message}; Lightning backend rollback was also incomplete: ${errorDetails(rollbackError).message}`,
          {
            resource: plan.net,
            action: `retry backend teardown for "${plan.net}" after fixing Docker`,
            cause: new AggregateError([primary, rollbackError]),
          },
        );
      }
      throw primary;
    }
  }

  async status(plan: LightningBackendPlan): Promise<LightningBackendStatus> {
    const [bitcoinContainer, hubContainer, userContainer, ...volumes] =
      await Promise.all([
        this.engine.status(plan.containers.bitcoin),
        this.engine.status(plan.containers.hub),
        this.engine.status(plan.containers.user),
        this.engine.volumeExists(plan.volumes.bitcoin),
        this.engine.volumeExists(plan.volumes.hub),
        this.engine.volumeExists(plan.volumes.user),
        this.engine.volumeExists(plan.volumes.cchAuth),
      ]);

    const bitcoin =
      bitcoinContainer === "running"
        ? await this.tryBitcoinStatus(plan)
        : { blockHeight: null };
    const hub = await this.tryLndStatus(plan.containers.hub, hubContainer);
    const user = await this.tryLndStatus(plan.containers.user, userContainer);
    const hubChannel = hub.channels.find(
      (channel) =>
        channel.active && channel.capacitySats === plan.channelCapacitySats,
    );
    const userChannel = user.channels.find(
      (channel) =>
        channel.active && channel.capacitySats === plan.channelCapacitySats,
    );
    const channel =
      hubChannel && userChannel
        ? {
            active: true,
            capacitySats: plan.channelCapacitySats,
            hubLocalSats: hubChannel.localBalanceSats,
            userLocalSats: userChannel.localBalanceSats,
          }
        : null;
    const dataVolumesPresent = volumes.some(Boolean);
    const allAbsent =
      bitcoinContainer === "absent" &&
      hubContainer === "absent" &&
      userContainer === "absent" &&
      !dataVolumesPresent;
    const ready =
      bitcoinContainer === "running" &&
      hubContainer === "running" &&
      userContainer === "running" &&
      bitcoin.blockHeight !== null &&
      bitcoin.blockHeight >= 113 &&
      hub.syncedToChain === true &&
      user.syncedToChain === true &&
      hub.blockHeight === bitcoin.blockHeight &&
      user.blockHeight === bitcoin.blockHeight &&
      channel?.active === true;

    return {
      schemaVersion: 1,
      kind: "lightning-backend",
      net: plan.net,
      state: allAbsent ? "absent" : ready ? "ready" : "degraded",
      bitcoin: {
        container: bitcoinContainer,
        blockHeight: bitcoin.blockHeight,
      },
      hub: publicLndStatus(hub),
      user: publicLndStatus(user),
      channel,
      dataVolumesPresent,
    };
  }

  async down(plan: LightningBackendPlan): Promise<void> {
    const failures: string[] = [];
    for (const container of [
      plan.containers.user,
      plan.containers.hub,
      plan.containers.bitcoin,
    ]) {
      try {
        await this.engine.stop(container);
      } catch (error) {
        failures.push(`stop ${container}: ${errorDetails(error).message}`);
      }
      try {
        await this.engine.remove(container);
      } catch (error) {
        failures.push(`remove ${container}: ${errorDetails(error).message}`);
      }
    }
    for (const volume of [
      plan.volumes.user,
      plan.volumes.hub,
      plan.volumes.cchAuth,
      plan.volumes.bitcoin,
    ]) {
      try {
        await this.engine.removeVolume(volume);
      } catch (error) {
        failures.push(`remove ${volume}: ${errorDetails(error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new ForgeError(
        "DOCKER_OPERATION_FAILED",
        `Lightning backend teardown for "${plan.net}" was incomplete: ${failures.join("; ")}`,
        {
          resource: plan.net,
          action: "fix the reported Docker resources and retry teardown",
        },
      );
    }
  }

  private async waitForBitcoin(
    bitcoin: BitcoinCli,
    guard: BackendGuard,
    resource: string,
  ): Promise<void> {
    for (;;) {
      guard.check(resource);
      try {
        const info = await bitcoin.blockchainInfo();
        if (safeInteger(info.blocks) !== null) return;
      } catch {
        // Startup errors are expected until bitcoind accepts RPC requests.
      }
      await guard.wait(resource);
    }
  }

  private async waitForBitcoinHeight(
    bitcoin: BitcoinCli,
    expectedHeight: number,
    guard: BackendGuard,
    resource: string,
  ): Promise<void> {
    for (;;) {
      guard.check(resource);
      try {
        const height = safeInteger((await bitcoin.blockchainInfo()).blocks);
        if (height !== null && height >= expectedHeight) return;
      } catch {
        // Keep polling the state boundary until the shared deadline expires.
      }
      await guard.wait(resource);
    }
  }

  private async waitForLndSync(
    hub: LndCli,
    user: LndCli,
    expectedHeight: number,
    guard: BackendGuard,
    resource: string,
  ): Promise<void> {
    for (;;) {
      guard.check(resource);
      try {
        const [hubInfo, userInfo] = await Promise.all([
          hub.info(),
          user.info(),
        ]);
        const hubHeight = safeInteger(hubInfo.block_height);
        const userHeight = safeInteger(userInfo.block_height);
        if (
          hubInfo.synced_to_chain === true &&
          userInfo.synced_to_chain === true &&
          hubHeight !== null &&
          userHeight !== null &&
          hubHeight >= expectedHeight &&
          userHeight >= expectedHeight
        ) {
          return;
        }
      } catch {
        // LND creates its wallet and TLS material before the RPC reaches ready state.
      }
      await guard.wait(resource);
    }
  }

  private async waitForActiveChannel(
    plan: LightningBackendPlan,
    hub: LndCli,
    user: LndCli,
    guard: BackendGuard,
    resource: string,
  ): Promise<void> {
    for (;;) {
      guard.check(resource);
      try {
        const [hubChannels, userChannels] = await Promise.all([
          hub.channels(),
          user.channels(),
        ]);
        const activeAtCapacity = (channels: LndChannels) =>
          (channels.channels ?? []).some(
            (channel) =>
              channel.active === true &&
              safeInteger(channel.capacity) === plan.channelCapacitySats,
          );
        if (activeAtCapacity(hubChannels) && activeAtCapacity(userChannels)) {
          return;
        }
      } catch {
        // The channel is pending until the funding transaction confirms and links activate.
      }
      await guard.wait(resource);
    }
  }

  private async tryBitcoinStatus(
    plan: LightningBackendPlan,
  ): Promise<{ blockHeight: number | null }> {
    try {
      const info = await new BitcoinCli(
        this.engine,
        plan.containers.bitcoin,
      ).blockchainInfo();
      return { blockHeight: safeInteger(info.blocks) };
    } catch {
      return { blockHeight: null };
    }
  }

  private async tryLndStatus(
    container: string,
    containerStatus: ContainerStatus,
  ): Promise<InternalLndStatus> {
    const unavailable: InternalLndStatus = {
      container: containerStatus,
      syncedToChain: null,
      blockHeight: null,
      activeChannels: null,
      localBalanceSats: null,
      channels: [],
    };
    if (containerStatus !== "running") return unavailable;
    try {
      const client = new LndCli(this.engine, container);
      const [info, response] = await Promise.all([
        client.info(),
        client.channels(),
      ]);
      const channels = (response.channels ?? []).flatMap((channel) => {
        const capacitySats = safeInteger(channel.capacity);
        const localBalanceSats = safeInteger(channel.local_balance);
        return capacitySats === null || localBalanceSats === null
          ? []
          : [
              {
                active: channel.active === true,
                capacitySats,
                localBalanceSats,
              },
            ];
      });
      return {
        container: containerStatus,
        syncedToChain:
          typeof info.synced_to_chain === "boolean"
            ? info.synced_to_chain
            : null,
        blockHeight: safeInteger(info.block_height),
        activeChannels: channels.filter((channel) => channel.active).length,
        localBalanceSats: channels.reduce(
          (sum, channel) => sum + channel.localBalanceSats,
          0,
        ),
        channels,
      };
    } catch {
      return unavailable;
    }
  }
}

async function checkedExec(
  engine: ContainerEngine,
  container: string,
  command: readonly string[],
  operation: string,
  signal?: AbortSignal,
) {
  const result = await engine.exec(container, command, {
    maxOutputBytes: 256 * 1024,
    signal,
  });
  if (
    result.exitCode !== 0 ||
    result.stdoutTruncated ||
    result.stderrTruncated
  ) {
    throw new ForgeError(
      "PROVISION_FAILED",
      `${operation} failed in container "${container}"`,
      {
        resource: container,
        action: "inspect the named container logs and retry",
      },
    );
  }
  return result;
}

async function checkedJson<T>(
  engine: ContainerEngine,
  container: string,
  command: readonly string[],
  operation: string,
  signal?: AbortSignal,
): Promise<T> {
  const result = await checkedExec(
    engine,
    container,
    command,
    operation,
    signal,
  );
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw malformedOutput(operation, container, error);
  }
}

function malformedOutput(
  operation: string,
  container: string,
  cause?: unknown,
): ForgeError {
  return new ForgeError(
    "PROVISION_FAILED",
    `${operation} returned malformed output from container "${container}"`,
    {
      resource: container,
      action: "verify the pinned backend image and retry",
      cause,
    },
  );
}

function safeInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function publicLndStatus(status: InternalLndStatus): LightningComponentStatus {
  return {
    container: status.container,
    syncedToChain: status.syncedToChain,
    blockHeight: status.blockHeight,
    activeChannels: status.activeChannels,
    localBalanceSats: status.localBalanceSats,
  };
}
