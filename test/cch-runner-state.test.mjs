import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  createCchRunnerReport,
  persistCchRunnerReport,
  recordCchRunnerStage,
  runBoundedCchRunnerStage,
} from "../scripts/cch-runner-state.mjs";

const execFileAsync = promisify(execFile);

async function withReport(run) {
  const directory = await mkdtemp(join(tmpdir(), "fiber-forge-cch-runner-"));
  try {
    await run(join(directory, "runner.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("CCH packed runner state", () => {
  it("atomically preserves the last entered stage", async () => {
    await withReport(async (outputFile) => {
      const report = createCchRunnerReport(
        "cch-test",
        new Date("2026-11-12T00:00:00.000Z"),
      );
      await persistCchRunnerReport(outputFile, report);
      await recordCchRunnerStage(
        outputFile,
        report,
        "cold-start:provision",
        "started",
      );

      const saved = JSON.parse(await readFile(outputFile, "utf8"));
      expect(saved).toMatchObject({
        status: "running",
        activeStage: "cold-start:provision",
        runs: [],
        stageJournal: [
          {
            sequence: 1,
            phase: "cold-start:provision",
            status: "started",
          },
        ],
      });
    });
  });

  it("keeps a referenced deadline and records a stalled stage failure", async () => {
    await withReport(async (outputFile) => {
      const report = createCchRunnerReport("cch-timeout");
      let timedOut = false;

      await expect(
        runBoundedCchRunnerStage(
          {
            outputFile,
            report,
            phase: "cold-start:proof",
            timeoutMs: 10,
            onTimeout: () => {
              timedOut = true;
              throw new Error("cooperative abort failed");
            },
          },
          () => new Promise(() => {}),
        ),
      ).rejects.toMatchObject({ code: "CCH_RUNNER_STAGE_TIMEOUT" });

      const saved = JSON.parse(await readFile(outputFile, "utf8"));
      expect(timedOut).toBe(true);
      expect(saved.activeStage).toBeNull();
      expect(saved.stageJournal).toMatchObject([
        { phase: "cold-start:proof", status: "started" },
        {
          phase: "cold-start:proof",
          status: "failed",
          errorCode: "CCH_RUNNER_STAGE_TIMEOUT",
        },
      ]);
    });
  });

  it("records a completed stage without changing the operation result", async () => {
    await withReport(async (outputFile) => {
      const report = createCchRunnerReport("cch-complete");
      const result = await runBoundedCchRunnerStage(
        {
          outputFile,
          report,
          phase: "warm-start:status",
          timeoutMs: 1_000,
        },
        async () => ({ state: "ready" }),
      );

      expect(result).toEqual({ state: "ready" });
      expect(report.stageJournal.map(({ status }) => status)).toEqual([
        "started",
        "completed",
      ]);
    });
  });

  it("executes when the copied runner is launched through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "fiber-forge-cch-entrypoint-"));
    const realDirectory = join(root, "consumer");
    const linkedDirectory = join(root, "consumer-link");
    const outputFile = join(root, "runner.json");
    try {
      await mkdir(realDirectory);
      await Promise.all([
        copyFile(
          new URL("../scripts/cch-packed-runner.mjs", import.meta.url),
          join(realDirectory, "cch-packed-runner.mjs"),
        ),
        copyFile(
          new URL("../scripts/cch-runner-state.mjs", import.meta.url),
          join(realDirectory, "cch-runner-state.mjs"),
        ),
      ]);
      await symlink(realDirectory, linkedDirectory, "dir");

      await expect(
        execFileAsync(process.execPath, [
          join(linkedDirectory, "cch-packed-runner.mjs"),
          outputFile,
          join(root, "state"),
          "cch-symlink",
        ]),
      ).rejects.toMatchObject({ code: 1 });

      const report = JSON.parse(await readFile(outputFile, "utf8"));
      expect(report).toMatchObject({
        status: "failed",
        activeStage: null,
        stageJournal: [
          { phase: "runner:load-sdk", status: "started" },
          { phase: "runner:load-sdk", status: "failed" },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
