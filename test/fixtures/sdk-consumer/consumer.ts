import {
  DEFAULT_CCH_PROOF_TIMEOUT_MS,
  DEFAULT_PROVISION_TIMEOUT_MS,
  FAULT_KINDS,
  ForgeError,
  createFiberForge,
  errorDetails,
  parseTopology,
  planNetwork,
  preset,
  type DownOptions,
  type FiberForge,
  type FaultKind,
  type FaultReport,
  type ForceCloseOptions,
  type FiberForgeError,
  type ForgeErrorCode,
  type LayoutOptions,
  type NetworkLayout,
  type NetworkView,
  type ChannelSettlementReport,
  type CchProofOptions,
  type CchTopologyStatus,
  type CchTransferProofReport,
  type BundleInspection,
  type ExportBundleOptions,
  type ExportBundleResult,
  type MineReport,
  type NodeLifecycleOptions,
  type NodeLifecycleReport,
  type Topology,
  type ReplayBundleOptions,
  type ReplayBundleResult,
  type Scenario,
  type ScenarioReport,
  type ScenarioRunOptions,
  type UpOptions,
} from "@truthixify/fiber-forge/sdk";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <
        Value,
      >() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type Assert<Condition extends true> = Condition;

type ExpectedUpOptions = {
  fnnImage?: string;
  ckbImage?: string;
  cchImage?: string;
  layout?: LayoutOptions;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  requireClean?: boolean;
  udtPerNode?: number;
};
type ExpectedDownOptions = { purge?: boolean; keep?: boolean };
type ExpectedNetworkLayout = {
  net: string;
  network: string;
  subnet: string;
  ckbContainer: string;
  ckbIp: string;
  ckbHostPort: number;
  nodes: {
    index: number;
    name: string;
    container: string;
    ip: string;
    rpcHostPort: number;
    password: string;
  }[];
};
type ExpectedForgeErrorCode =
  | "BUNDLE_INCOMPATIBLE"
  | "BUNDLE_INVALID"
  | "BUNDLE_OUTPUT_EXISTS"
  | "CHANNEL_NOT_FOUND"
  | "CHANNEL_STATE_MISMATCH"
  | "CCH_TRANSFER_FAILED"
  | "CONTAINER_NOT_FOUND"
  | "CONTAINER_START_FAILED"
  | "DOCKER_OPERATION_FAILED"
  | "DOCKER_UNAVAILABLE"
  | "FAULT_CONFLICT"
  | "FAULT_PRECONDITION_FAILED"
  | "FAULT_STATE_MISMATCH"
  | "FAULT_UNSUPPORTED"
  | "FORCE_CLOSE_CONFIRMATION_REQUIRED"
  | "IMAGE_PULL_FAILED"
  | "INVALID_NETWORK_NAME"
  | "INVALID_PORT"
  | "INVALID_TIMEOUT"
  | "NETWORK_EXISTS"
  | "NETWORK_NOT_FOUND"
  | "MINING_PAUSED"
  | "NODE_CONTAINER_MISSING"
  | "NODE_IDENTITY_MISMATCH"
  | "NODE_NOT_FOUND"
  | "NODE_RPC_UNAVAILABLE"
  | "NODE_STATE_MISMATCH"
  | "OPERATION_ABORTED"
  | "OPERATION_TIMEOUT"
  | "PAYMENT_FAILED"
  | "PORT_IN_USE"
  | "PROVISION_FAILED"
  | "ROLLBACK_FAILED"
  | "UNEXPECTED";

type _UpOptionsContract = Assert<Equal<UpOptions, ExpectedUpOptions>>;
type _DownOptionsContract = Assert<Equal<DownOptions, ExpectedDownOptions>>;
type _LayoutContract = Assert<Equal<NetworkLayout, ExpectedNetworkLayout>>;
type _ErrorCodeContract = Assert<Equal<ForgeErrorCode, ExpectedForgeErrorCode>>;

const fallback: Topology = parseTopology(`
name: sdk-consumer
nodes: [{ name: alice }, { name: bob }]
channels: [{ from: alice, to: bob, capacity_ckb: 1000 }]
funding: { per_node_ckb: 100000 }
`);
const topology: Topology = preset("trio") ?? fallback;
const forge: FiberForge = createFiberForge({
  stateDir: "/tmp/fiber-forge-sdk-consumer",
});
const controller = new AbortController();
const upOptions: UpOptions = {
  layout: { ckbHostPort: 8114 },
  signal: controller.signal,
  timeoutMs: DEFAULT_PROVISION_TIMEOUT_MS,
  onProgress: (message) => void message,
};
const downOptions: DownOptions = { purge: true };
const planned: NetworkLayout = planNetwork(topology, {
  ckbHostPort: 8114,
  rpcHostPortBase: 8300,
});

type AppForge = Pick<
  FiberForge,
  | "up"
  | "runScenario"
  | "exportBundle"
  | "inspectBundle"
  | "replayBundle"
  | "inspect"
  | "cchStatus"
  | "proveCchTransfers"
  | "inspectNode"
  | "stopNode"
  | "startNode"
  | "restartNode"
  | "applyFault"
  | "faultStatus"
  | "resetFault"
  | "resetAllFaults"
  | "mineBlocks"
  | "forceCloseChannel"
  | "inspectChannelSettlement"
  | "pay"
  | "down"
>;

async function exerciseContract(client: AppForge): Promise<void> {
  const layout: NetworkLayout = await client.up(topology, upOptions);
  const view: NetworkView = await client.inspect(layout.net);
  const cch: CchTopologyStatus = await client.cchStatus(layout.net);
  const cchProofOptions: CchProofOptions = {
    timeoutMs: DEFAULT_CCH_PROOF_TIMEOUT_MS,
    signal: controller.signal,
  };
  const cchProof: Promise<CchTransferProofReport> = client.proveCchTransfers(
    layout.net,
    cchProofOptions,
  );
  const lifecycleOptions: NodeLifecycleOptions = {
    timeoutMs: 60_000,
    reconcileTimeoutMs: 10_000,
  };
  const inspected: NodeLifecycleReport = await client.inspectNode(
    layout.net,
    topology.nodes[0].name,
  );
  const faultKind: FaultKind = FAULT_KINDS[0];
  const applied: FaultReport = await client.applyFault(
    layout.net,
    faultKind,
    topology.nodes[0].name,
  );
  const mined: MineReport = await client.mineBlocks(layout.net, 1);
  const forceOptions: ForceCloseOptions = { confirmChannelId: "0xchannel" };
  const settlement: Promise<ChannelSettlementReport> =
    client.inspectChannelSettlement(
      layout.net,
      topology.nodes[0].name,
      "0xchannel",
    );
  void applied;
  void cch;
  void cchProof;
  void mined;
  void forceOptions;
  void settlement;
  void inspected;
  void lifecycleOptions;
  await client.down(view.net, downOptions);
}

function classify(error: unknown): FiberForgeError {
  const details = errorDetails(error);
  const code: ForgeErrorCode = details.code;
  void code;
  return details;
}

void forge;
void planned;
void exerciseContract;
void classify;
void new ForgeError("OPERATION_ABORTED", "aborted");
void ({} as BundleInspection);
void ({} as ExportBundleOptions);
void ({} as ExportBundleResult);
void ({} as ReplayBundleOptions);
void ({} as ReplayBundleResult);
void ({} as Scenario);
void ({} as ScenarioReport);
void ({} as ScenarioRunOptions);
