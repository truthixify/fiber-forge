/**
 * Host-port allocation. So that independent networks coexist without `--ckb-port`/`--rpc-base`,
 * the orchestrator probes for free host ports rather than hardcoding them.
 */

import { createServer } from "node:net";

/** Whether `host` can bind `port`. */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Whether a TCP port is free for docker to publish a container port on. Both the wildcard and the
 * loopback address are probed because BSD socket semantics let a wildcard bind succeed while
 * loopback is already held: on macOS, probing `0.0.0.0` alone reports a port that another
 * container already publishes on `127.0.0.1` as free, and the container then fails to start with
 * "port is already allocated".
 */
export async function isPortFree(port: number): Promise<boolean> {
  return (await canBind(port, "0.0.0.0")) && (await canBind(port, "127.0.0.1"));
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
