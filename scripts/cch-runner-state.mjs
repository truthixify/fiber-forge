import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_REPORT_BYTES = 256 * 1024;
const MAX_STAGE_ENTRIES = 64;
const MAX_STAGE_VALUE_LENGTH = 160;

function boundedValue(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[^a-zA-Z0-9 .:_/-]/g, "?").trim();
  return normalized.slice(0, MAX_STAGE_VALUE_LENGTH) || fallback;
}

function errorCode(error) {
  return boundedValue(error?.code, "UNEXPECTED").toUpperCase();
}

export class CchRunnerStageTimeout extends Error {
  constructor(phase, timeoutMs) {
    super(`CCH runner phase "${phase}" exceeded ${timeoutMs}ms`);
    this.name = "CchRunnerStageTimeout";
    this.code = "CCH_RUNNER_STAGE_TIMEOUT";
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

export function createCchRunnerReport(runPrefix, now = new Date()) {
  return {
    schemaVersion: 1,
    source: "installed-packed-artifact",
    status: "running",
    startedAt: now.toISOString(),
    completedAt: null,
    runPrefix: boundedValue(runPrefix, "invalid-prefix"),
    activeStage: null,
    stageJournal: [],
    runs: [],
  };
}

export async function persistCchRunnerReport(outputFile, report) {
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) {
    throw new Error("CCH runner report exceeded its bounded size");
  }
  await mkdir(dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.${process.pid}.tmp`;
  await writeFile(temporary, serialized, { mode: 0o600 });
  await rename(temporary, outputFile);
}

export async function recordCchRunnerStage(
  outputFile,
  report,
  phase,
  status,
  error,
) {
  const normalizedPhase = boundedValue(phase, "unknown-stage");
  const normalizedStatus =
    status === "started" || status === "completed" || status === "failed"
      ? status
      : "failed";
  report.activeStage = normalizedStatus === "started" ? normalizedPhase : null;
  const sequence = (report.stageJournal.at(-1)?.sequence ?? 0) + 1;
  report.stageJournal.push({
    sequence,
    phase: normalizedPhase,
    status: normalizedStatus,
    at: new Date().toISOString(),
    ...(error ? { errorCode: errorCode(error) } : {}),
  });
  if (report.stageJournal.length > MAX_STAGE_ENTRIES) {
    report.stageJournal.splice(
      0,
      report.stageJournal.length - MAX_STAGE_ENTRIES,
    );
  }
  await persistCchRunnerReport(outputFile, report);
}

export async function runBoundedCchRunnerStage(
  { outputFile, report, phase, timeoutMs, onTimeout },
  operation,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("CCH runner stage timeout must be a positive integer");
  }
  await recordCchRunnerStage(outputFile, report, phase, "started");
  const operationPromise = Promise.resolve().then(operation);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new CchRunnerStageTimeout(phase, timeoutMs);
      reject(error);
      try {
        onTimeout?.(error);
      } catch {
        // The stage timeout remains authoritative even if cooperative abort notification fails.
      }
    }, timeoutMs);
  });
  try {
    const value = await Promise.race([operationPromise, deadline]);
    await recordCchRunnerStage(outputFile, report, phase, "completed");
    return value;
  } catch (error) {
    await recordCchRunnerStage(outputFile, report, phase, "failed", error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
