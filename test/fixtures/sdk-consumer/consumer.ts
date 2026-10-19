import {
  createFiberForge,
  parseTopology,
  preset,
  type DownOptions,
  type FiberForge,
  type NetworkLayout,
  type NetworkView,
  type Topology,
  type UpOptions,
} from "@truthixify/fiber-forge/sdk";

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
const upOptions: UpOptions = { layout: { ckbHostPort: 8114 } };
const downOptions: DownOptions = { purge: true };

async function exerciseContract(): Promise<void> {
  const layout: NetworkLayout = await forge.up(topology, upOptions);
  const view: NetworkView = await forge.inspect(layout.net);
  await forge.down(view.net, downOptions);
}

void exerciseContract;
