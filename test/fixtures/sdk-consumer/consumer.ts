import {
  DEFAULT_PROVISION_TIMEOUT_MS,
  ForgeError,
  createFiberForge,
  errorDetails,
  parseTopology,
  planNetwork,
  preset,
  type DownOptions,
  type FiberForge,
  type FiberForgeError,
  type ForgeErrorCode,
  type LayoutOptions,
  type NetworkLayout,
  type NetworkView,
  type Topology,
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
  layout?: LayoutOptions;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
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
  | "CONTAINER_NOT_FOUND"
  | "CONTAINER_START_FAILED"
  | "DOCKER_OPERATION_FAILED"
  | "DOCKER_UNAVAILABLE"
  | "IMAGE_PULL_FAILED"
  | "INVALID_NETWORK_NAME"
  | "INVALID_PORT"
  | "INVALID_TIMEOUT"
  | "NETWORK_EXISTS"
  | "NETWORK_NOT_FOUND"
  | "OPERATION_ABORTED"
  | "OPERATION_TIMEOUT"
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

type AppForge = Pick<FiberForge, "up" | "inspect" | "pay" | "down">;

async function exerciseContract(client: AppForge): Promise<void> {
  const layout: NetworkLayout = await client.up(topology, upOptions);
  const view: NetworkView = await client.inspect(layout.net);
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
