export const FAULT_KINDS = [
  "node-kill",
  "peer-partition",
  "ckb-unavailable",
  "mining-pause",
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];
export type FaultObservedState = "active" | "inactive" | "degraded";

export interface FaultNetworkAttachment {
  container: string;
  network: string;
  connected: boolean;
}

export interface FaultObservation {
  state: FaultObservedState;
  summary: string;
  containerStatus?: "running" | "stopped" | "absent";
  attachments?: FaultNetworkAttachment[];
  ckbReady?: boolean;
  tipBlock?: number;
}

/** Machine-readable result shared by the SDK and CLI fault commands. */
export interface FaultReport {
  net: string;
  id: string;
  kind: FaultKind;
  target: string | null;
  requested: "active" | "reset";
  observed: FaultObservation;
  changed: boolean;
  appliedAt: string | null;
  survivesProcessRestart: true;
  recovery: "not-applicable" | "ready" | "action-required";
  nextAction: string | null;
}

export interface PersistedFault {
  id: string;
  kind: FaultKind;
  target?: string;
  appliedAt: string;
  isolation?: {
    network: string;
    subnet: string;
    nodeIp: string;
    ckbIp: string;
  };
}

export interface PersistedFaultFile {
  version: 1;
  faults: PersistedFault[];
}

export function emptyFaultFile(): PersistedFaultFile {
  return { version: 1, faults: [] };
}

export function isFaultKind(value: string): value is FaultKind {
  return (FAULT_KINDS as readonly string[]).includes(value);
}

export function faultNeedsTarget(kind: FaultKind): boolean {
  return kind === "node-kill" || kind === "peer-partition";
}

export function faultId(kind: FaultKind, target?: string): string {
  return target ? `${kind}:${target}` : kind;
}

export function parseFaultFile(value: unknown): PersistedFaultFile {
  if (!value || typeof value !== "object") {
    throw new Error("fault state must be an object");
  }
  const candidate = value as { version?: unknown; faults?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.faults)) {
    throw new Error("fault state version or fault list is invalid");
  }
  const faults = candidate.faults.map((fault): PersistedFault => {
    if (!fault || typeof fault !== "object") {
      throw new Error("fault entry must be an object");
    }
    const record = fault as Partial<PersistedFault>;
    if (
      typeof record.id !== "string" ||
      typeof record.kind !== "string" ||
      !isFaultKind(record.kind) ||
      typeof record.appliedAt !== "string"
    ) {
      throw new Error("fault entry has invalid required fields");
    }
    return record as PersistedFault;
  });
  return { version: 1, faults };
}
