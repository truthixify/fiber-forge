import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DevChain } from "../src/ckb";
import {
  DEFAULT_CCH_IMAGE,
  type CchOperatorController,
  type CchOperatorStatus,
} from "../src/cch";
import { FakeEngine } from "../src/engine";
import {
  type LightningBackendController,
  type LightningBackendStatus,
} from "../src/lightning";
import {
  FORGE_LABEL,
  type NetworkState,
  Orchestrator,
} from "../src/orchestrator";
import { FnnRpc, type RpcTransport } from "../src/rpc";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), "forge-cch-status-"));
  temporaryRoots.push(stateDir);
  const script = {
    code_hash: `0x${"1".repeat(64)}`,
    hash_type: "data1",
    args: `0x${"2".repeat(64)}`,
  };
  const state: NetworkState = {
    schemaVersion: 1,
    net: "cch-status",
    network: "forge-cch-status",
    ckbHostPort: 18114,
    ckbContainer: "forge-cch-status-ckb",
    ckbIp: "10.5.7.2",
    nodes: [
      {
        name: "user",
        container: "forge-cch-status-node-1",
        ip: "10.5.7.11",
        rpcHostPort: 18300,
        pubkey: "0xuser",
        ckbAddress: "ckt1user",
      },
      {
        name: "hub",
        container: "forge-cch-status-node-2",
        ip: "10.5.7.12",
        rpcHostPort: 18301,
        pubkey: "0xhub",
        ckbAddress: "ckt1hub",
      },
    ],
    channels: [
      {
        from: "user",
        to: "hub",
        capacityCkb: 0.002,
        asset: "simple_udt",
        capacityBaseUnits: "200000",
      },
    ],
    cch: {
      schemaVersion: 1,
      userNode: "user",
      hubNode: "hub",
      wrappedChannelBaseUnits: "200000",
      issuedBaseUnits: "100000000",
      wrappedTypeScript: script,
      operator: {
        image: DEFAULT_CCH_IMAGE,
        container: "forge-cch-status-cch",
        ip: "10.5.7.203",
        rpcHostPort: 18400,
        dataVolume: "forge-cch-status-cch-data",
      },
    },
  };
  await mkdir(join(stateDir, state.net), { recursive: true });
  await writeFile(
    join(stateDir, state.net, "layout.json"),
    JSON.stringify(state),
  );

  const engine = new FakeEngine();
  await engine.ensureNetwork(state.network, "10.5.7.0/24");
  for (const container of [
    state.ckbContainer!,
    ...state.nodes.map((node) => node.container),
    state.cch!.operator.container,
  ]) {
    await engine.run({
      name: container,
      image: "test",
      network: state.network,
      labels: { [FORGE_LABEL]: state.net },
    });
  }

  let operatorStatus: CchOperatorStatus = {
    container: "running",
    rpcReady: true,
    dataVolumePresent: true,
  };
  let lightningStatus: LightningBackendStatus = {
    schemaVersion: 1,
    kind: "lightning-backend",
    net: state.net,
    state: "ready",
    bitcoin: { container: "running", blockHeight: 113 },
    hub: {
      container: "running",
      syncedToChain: true,
      blockHeight: 113,
      activeChannels: 1,
      localBalanceSats: 996530,
    },
    user: {
      container: "running",
      syncedToChain: true,
      blockHeight: 113,
      activeChannels: 1,
      localBalanceSats: 0,
    },
    channel: {
      active: true,
      capacitySats: 1000000,
      hubLocalSats: 996530,
      userLocalSats: 0,
    },
    dataVolumesPresent: true,
  };
  const operator: CchOperatorController = {
    start: async () => operatorStatus,
    status: async () => operatorStatus,
    down: async () => {},
  };
  const lightning: LightningBackendController = {
    start: async () => lightningStatus,
    status: async () => lightningStatus,
    down: async () => {},
  };
  const makeRpc = (port: number) =>
    new FnnRpc({
      async call(method: string) {
        if (method !== "list_channels") return {};
        return {
          channels: [
            {
              channel_id: "0xwrapped",
              pubkey: port === 18300 ? "0xhub" : "0xuser",
              state: "ChannelReady",
              local_balance: port === 18300 ? "0x30d40" : "0x0",
              remote_balance: port === 18300 ? "0x0" : "0x30d40",
              funding_udt_type_script: script,
            },
          ],
        };
      },
    } satisfies RpcTransport);
  const chain = {
    tipBlock: async () => 37,
    balanceShannonsOf: async () => 100_000_000n,
    udtBalanceOf: async () => 0n,
  } as unknown as DevChain;
  const orchestrator = new Orchestrator(
    engine,
    "/assets",
    stateDir,
    makeRpc,
    () => chain,
    () => lightning,
    () => operator,
  );
  return {
    orchestrator,
    state,
    stateDir,
    setOperator: (value: CchOperatorStatus) => (operatorStatus = value),
    setLightning: (value: LightningBackendStatus) => (lightningStatus = value),
    lightningStatus,
  };
}

describe("CCH topology status", () => {
  it("reports exact ready, degraded, and failed boundaries", async () => {
    const setup = await fixture();

    await expect(
      setup.orchestrator.cchStatus("cch-status"),
    ).resolves.toMatchObject({
      state: "ready",
      fiber: {
        wrappedChannel: {
          state: "ChannelReady",
          capacityBaseUnits: "200000",
          typeScriptMatches: true,
        },
      },
    });

    setup.setLightning({ ...setup.lightningStatus, state: "degraded" });
    await expect(
      setup.orchestrator.cchStatus("cch-status"),
    ).resolves.toMatchObject({
      state: "degraded",
      operator: { rpcReady: true },
      lightning: { state: "degraded" },
    });

    setup.setOperator({
      container: "exited",
      rpcReady: false,
      dataVolumePresent: true,
    });
    await expect(
      setup.orchestrator.cchStatus("cch-status"),
    ).resolves.toMatchObject({
      state: "failed",
      operator: { container: "exited" },
    });
  });

  it("rejects portable export of intentionally incomplete CCH state", async () => {
    const { orchestrator } = await fixture();
    await expect(
      orchestrator.exportBundle("cch-status", {
        scenario: "version: 1\nsteps:\n  - wait: 0\n",
        report: "{}",
        output: join(tmpdir(), "should-not-exist.ffbundle"),
      }),
    ).rejects.toMatchObject({ code: "BUNDLE_INCOMPATIBLE" });
  });

  it("reports unsupported for an ordinary Fiber network without probing CCH", async () => {
    const { orchestrator, state, stateDir } = await fixture();
    delete state.cch;
    await writeFile(
      join(stateDir, state.net, "layout.json"),
      JSON.stringify(state),
    );

    await expect(orchestrator.cchStatus(state.net)).resolves.toEqual({
      schemaVersion: 1,
      kind: "cch-topology",
      net: state.net,
      state: "unsupported",
      operator: null,
      lightning: null,
      fiber: null,
      boundary: null,
    });
  });

  it("rejects inconsistent persisted operator identity", async () => {
    const { orchestrator, state, stateDir } = await fixture();
    state.cch!.operator.container = "unexpected-operator";
    await writeFile(
      join(stateDir, state.net, "layout.json"),
      JSON.stringify(state),
    );

    await expect(orchestrator.cchStatus(state.net)).rejects.toMatchObject({
      code: "PROVISION_FAILED",
      resource: state.net,
    });
  });
});
