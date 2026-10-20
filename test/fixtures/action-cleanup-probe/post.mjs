import { getSavedState } from "../../../action/github.mjs";
import { exactDockerResourceState } from "../../../action/runtime.mjs";

const network = getSavedState("network");
const state = await exactDockerResourceState(network);
const remaining = [
  ...state.containers.map((name) => `container ${name}`),
  ...state.networks.map((name) => `network ${name}`),
  ...state.volumes.map((name) => `volume ${name}`),
];
if (remaining.length > 0) {
  throw new Error(
    `Fiber Forge post hook left resources: ${remaining.join(", ")}`,
  );
}
console.log(`Independent cleanup verification passed for ${network}`);
