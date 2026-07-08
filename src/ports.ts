/**
 * Host-port allocation. So that independent networks coexist without `--ckb-port`/`--rpc-base`,
 * the orchestrator probes for free host ports rather than hardcoding them.
 */

import { createServer } from "node:net";

/** Whether a TCP port is free to bind on all interfaces. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "0.0.0.0");
  });
}

/** The first free port at or after `start`. */
export async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 2000; port += 1) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`no free host port near ${start}`);
}

/** The start of a run of `count` consecutive free ports at or after `start`. */
export async function findFreePortBlock(
  start: number,
  count: number,
): Promise<number> {
  for (let base = start; base < start + 2000; base += 1) {
    let free = true;
    for (let offset = 0; offset < count; offset += 1) {
      if (!(await isPortFree(base + offset))) {
        free = false;
        break;
      }
    }
    if (free) {
      return base;
    }
  }
  throw new Error(`no run of ${count} free host ports near ${start}`);
}
