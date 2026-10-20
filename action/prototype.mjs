import { extname, relative, resolve, sep } from "node:path";

const exactVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const presetPattern = /^(?:duo|trio|hub|(?:line|ring|star):(?:[2-9]|10))$/;
const diagnosticsModes = new Set(["failure", "always", "never"]);

function optionalPort(value, name) {
  if (value === undefined || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function optionalPositiveInteger(value, name) {
  if (value === undefined || value === "") return undefined;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return amount;
}

/** Normalize the proposed Action interface without touching GitHub or Docker. */
export function validatePrototypeInputs(input, workspace) {
  const packageVersion = String(input.packageVersion ?? "").trim();
  if (!exactVersionPattern.test(packageVersion)) {
    throw new Error(
      "package-version must be an exact semver such as 0.2.9 or 0.3.0-rc.1",
    );
  }

  const topology = String(input.topology ?? "").trim();
  if (!topology) throw new Error("topology is required");
  let topologyTarget;
  let topologyKind;
  if (presetPattern.test(topology)) {
    topologyTarget = topology;
    topologyKind = "preset";
  } else {
    const root = resolve(workspace);
    const candidate = resolve(root, topology);
    const fromRoot = relative(root, candidate);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      ![".yml", ".yaml"].includes(extname(candidate).toLowerCase())
    ) {
      throw new Error(
        "topology files must be YAML paths inside GITHUB_WORKSPACE",
      );
    }
    topologyTarget = candidate;
    topologyKind = "file";
  }

  const startupTimeoutMs = Number(input.startupTimeoutMs ?? 600_000);
  if (
    !Number.isInteger(startupTimeoutMs) ||
    startupTimeoutMs < 1_000 ||
    startupTimeoutMs > 1_800_000
  ) {
    throw new Error(
      "startup-timeout-ms must be an integer from 1000 through 1800000",
    );
  }
  const diagnostics = String(input.diagnostics ?? "failure");
  if (!diagnosticsModes.has(diagnostics)) {
    throw new Error("diagnostics must be failure, always, or never");
  }
  const rpcPortBase = optionalPort(input.rpcPortBase, "rpc-port-base");
  if (rpcPortBase !== undefined && rpcPortBase > 65_526) {
    throw new Error("rpc-port-base must leave room for up to 10 node ports");
  }

  return {
    packageVersion,
    topology: topologyTarget,
    topologyKind,
    ckbPort: optionalPort(input.ckbPort, "ckb-port"),
    rpcPortBase,
    startupTimeoutMs,
    udtPerNode: optionalPositiveInteger(input.udtPerNode, "udt-per-node"),
    diagnostics,
  };
}

function requireLoopbackUrl(value, label) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be an http://127.0.0.1 URL`);
  }
  return url.toString().replace(/\/$/, "");
}

/** Build the structured, secret-free outputs accepted for the Action implementation. */
export function buildPrototypeOutputs(connection, metadata) {
  const network = String(connection.network ?? "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(network)) {
    throw new Error("network must be a safe Fiber Forge network name");
  }
  const normalized = {
    schemaVersion: 1,
    network,
    ckbRpc: requireLoopbackUrl(connection.ckbRpc, "ckbRpc"),
    nodes: connection.nodes.map((node) => {
      const name = String(node.name ?? "");
      const pubkey = String(node.pubkey ?? "");
      if (!name || !pubkey) {
        throw new Error("every node output must include a name and pubkey");
      }
      return {
        name,
        pubkey,
        rpc: requireLoopbackUrl(node.rpc, `node ${name} rpc`),
      };
    }),
  };
  return {
    network: normalized.network,
    "ckb-rpc": normalized.ckbRpc,
    "nodes-json": JSON.stringify(normalized.nodes),
    "connection-json": JSON.stringify(normalized),
    "report-path": String(metadata.reportPath),
    "startup-duration-ms": String(metadata.startupDurationMs),
  };
}

/**
 * Model GitHub's JavaScript main/consumer/post ordering. The post phase runs after main failure or a
 * later consumer failure, and cleanup errors are retained alongside the primary failure.
 */
export async function simulatePostActionJob({ main, consumer, post }) {
  let outputs;
  let primaryFailure;
  try {
    outputs = await main();
    await consumer(outputs);
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupFailure;
  try {
    await post();
  } catch (error) {
    cleanupFailure = error;
  }

  if (primaryFailure && cleanupFailure) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      "consumer and post-action cleanup both failed",
    );
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  return outputs;
}
