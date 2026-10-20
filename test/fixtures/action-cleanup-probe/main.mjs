import { saveState } from "../../../action/github.mjs";

const network = process.env["INPUT_NETWORK"]?.trim();
if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(network ?? "")) {
  throw new Error("cleanup probe received an invalid network name");
}
await saveState("network", network);
console.log(`Registered cleanup verification for ${network}`);
