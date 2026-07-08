/**
 * Topology parsing and validation for fiber-forge networks.
 *
 * A topology declares the nodes, the channels to open between them, and per-node on-chain
 * funding. It is validated with actionable errors before any container starts (FR-8), so a
 * misconfigured network fails fast at parse time rather than mid-boot.
 */

import { parse as parseYaml } from "yaml";

/** A node in the network. `name` is used in container/DNS names, so it is DNS-safe. */
export interface NodeSpec {
  name: string;
}

/** A channel to open from one node to another, funded by `from` with `capacityCkb` CKB. */
export interface ChannelSpec {
  from: string;
  to: string;
  capacityCkb: number;
}

/** On-chain funding transferred to each node's wallet at boot. */
export interface FundingSpec {
  perNodeCkb: number;
}

/** A fully validated network topology. */
export interface Topology {
  name: string;
  nodes: NodeSpec[];
  channels: ChannelSpec[];
  funding: FundingSpec;
}

export const MIN_NODES = 2;
export const MAX_NODES = 10;

/**
 * Minimum channel capacity. A Fiber funding cell reserves roughly 99 CKB (occupied capacity of
 * the funding-lock cell); a channel below this cannot be created.
 */
export const MIN_CHANNEL_CAPACITY_CKB = 100;

/** Headroom left in each node's balance for on-chain fees and cell overhead beyond channels. */
export const FUNDING_BUFFER_CKB = 100;

/** DNS-safe identifier: lowercase alphanumeric and hyphens, 1–30 chars, not hyphen-bounded. */
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/** Thrown when a topology is invalid; carries every issue found, not just the first. */
export class TopologyError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid topology:\n  - ${issues.join("\n  - ")}`);
    this.name = "TopologyError";
  }
}

/** Parse a topology from YAML text and validate it. Throws {@link TopologyError} on any issue. */
export function parseTopology(yamlText: string): Topology {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new TopologyError([`not valid YAML: ${(error as Error).message}`]);
  }
  return validateTopology(raw);
}

/** Validate an already-parsed object into a {@link Topology}. Throws {@link TopologyError}. */
export function validateTopology(raw: unknown): Topology {
  const issues: string[] = [];
  const root = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) {
    issues.push(
      "top level must be a mapping with name, nodes, channels, funding",
    );
  }

  const name = typeof root.name === "string" ? root.name : "";
  if (!name) {
    issues.push("name is required");
  } else if (!NAME_PATTERN.test(name)) {
    issues.push(
      `name "${name}" must be lowercase alphanumeric/hyphen (1–30 chars)`,
    );
  }

  const nodes = parseNodes(root.nodes, issues);
  const nodeNames = new Set(nodes.map((n) => n.name));
  const channels = parseChannels(root.channels, nodeNames, issues);
  const funding = parseFunding(root.funding, issues);

  if (funding && channels.length > 0 && issues.length === 0) {
    checkFundingSufficiency(nodes, channels, funding, issues);
  }

  if (issues.length > 0) {
    throw new TopologyError(issues);
  }
  return { name, nodes, channels, funding: funding as FundingSpec };
}

function parseNodes(raw: unknown, issues: string[]): NodeSpec[] {
  if (!Array.isArray(raw)) {
    issues.push("nodes must be a list");
    return [];
  }
  if (raw.length < MIN_NODES || raw.length > MAX_NODES) {
    issues.push(
      `nodes must have ${MIN_NODES}–${MAX_NODES} entries (got ${raw.length})`,
    );
  }
  const nodes: NodeSpec[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const name =
      isRecord(entry) && typeof entry.name === "string" ? entry.name : "";
    if (!name) {
      issues.push(`nodes[${i}] is missing a name`);
      return;
    }
    if (!NAME_PATTERN.test(name)) {
      issues.push(
        `node name "${name}" must be lowercase alphanumeric/hyphen (1–30 chars)`,
      );
    }
    if (seen.has(name)) {
      issues.push(`duplicate node name "${name}"`);
    }
    seen.add(name);
    nodes.push({ name });
  });
  return nodes;
}

function parseChannels(
  raw: unknown,
  nodeNames: Set<string>,
  issues: string[],
): ChannelSpec[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    issues.push("channels must be a list");
    return [];
  }
  const channels: ChannelSpec[] = [];
  raw.forEach((entry, i) => {
    const rec = isRecord(entry) ? entry : {};
    const from = typeof rec.from === "string" ? rec.from : "";
    const to = typeof rec.to === "string" ? rec.to : "";
    const capacityCkb =
      typeof rec.capacity_ckb === "number" ? rec.capacity_ckb : NaN;
    if (!from || !nodeNames.has(from)) {
      issues.push(`channels[${i}].from references unknown node "${from}"`);
    }
    if (!to || !nodeNames.has(to)) {
      issues.push(`channels[${i}].to references unknown node "${to}"`);
    }
    if (from && from === to) {
      issues.push(`channels[${i}] connects node "${from}" to itself`);
    }
    if (!Number.isFinite(capacityCkb)) {
      issues.push(`channels[${i}].capacity_ckb must be a number`);
    } else if (capacityCkb < MIN_CHANNEL_CAPACITY_CKB) {
      issues.push(
        `channels[${i}].capacity_ckb ${capacityCkb} is below the ${MIN_CHANNEL_CAPACITY_CKB} CKB reserve`,
      );
    }
    channels.push({ from, to, capacityCkb });
  });
  return channels;
}

function parseFunding(raw: unknown, issues: string[]): FundingSpec | undefined {
  const rec = isRecord(raw) ? raw : {};
  const perNodeCkb =
    typeof rec.per_node_ckb === "number" ? rec.per_node_ckb : NaN;
  if (!Number.isFinite(perNodeCkb) || perNodeCkb <= 0) {
    issues.push("funding.per_node_ckb must be a positive number");
    return undefined;
  }
  return { perNodeCkb };
}

function checkFundingSufficiency(
  nodes: NodeSpec[],
  channels: ChannelSpec[],
  funding: FundingSpec,
  issues: string[],
): void {
  for (const node of nodes) {
    const outgoing = channels
      .filter((c) => c.from === node.name)
      .reduce((sum, c) => sum + c.capacityCkb, 0);
    const required = outgoing + (outgoing > 0 ? FUNDING_BUFFER_CKB : 0);
    if (required > funding.perNodeCkb) {
      issues.push(
        `funding.per_node_ckb ${funding.perNodeCkb} is below the ${required} CKB "${node.name}" ` +
          `needs to fund its channels (${outgoing}) plus fees (${FUNDING_BUFFER_CKB})`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
