import { gzipSync, gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_BUNDLE_EXPANDED_BYTES,
  buildBundleArchive,
  createExportBundle,
  inspectBundleFile,
  loadBundle,
  replayBundleFile,
  writeExportBundle,
  type ReplayBundleBackend,
} from "../src/bundle";
import { ForgeError } from "../src/errors";
import { parseScenario, type ScenarioReport } from "../src/scenario";
import { parseTopology } from "../src/topology";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const [scenarioSource, reportSource, topologySource] = await Promise.all([
    readFile("docs/examples/export-v1/scenario.json", "utf8"),
    readFile("docs/examples/export-v1/report.json", "utf8"),
    readFile("docs/examples/export-v1/topology.json", "utf8"),
  ]);
  return {
    topology: parseTopology(topologySource),
    scenario: parseScenario(scenarioSource),
    report: JSON.parse(reportSource) as ScenarioReport,
    sourceHost: { docker: "test" },
  };
}

async function writeArchive(archive: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fiber-forge-bundle-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "case.ffbundle");
  await writeFile(path, archive);
  return path;
}

function tarEntry(
  tar: Buffer,
  path: string,
): { header: Buffer; content: Buffer; padding: Buffer } {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const nul = header.indexOf(0, 0);
    const name = header.subarray(0, nul === -1 ? 100 : nul).toString("ascii");
    const size = Number.parseInt(
      header
        .subarray(124, 136)
        .toString("ascii")
        .replace(/[\0 ]+$/g, ""),
      8,
    );
    const content = tar.subarray(offset + 512, offset + 512 + size);
    const paddedEnd = offset + 512 + Math.ceil(size / 512) * 512;
    if (name === path) {
      return {
        header,
        content,
        padding: tar.subarray(offset + 512 + size, paddedEnd),
      };
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`missing tar entry ${path}`);
}

function updateChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
}

function mutateArchive(
  archive: Buffer,
  path: string,
  mutate: (entry: { header: Buffer; content: Buffer; padding: Buffer }) => void,
): Buffer {
  const tar = Buffer.from(gunzipSync(archive));
  const entry = tarEntry(tar, path);
  mutate(entry);
  return gzipSync(tar, { level: 9 });
}

describe("export bundles", () => {
  it("produces stable recipe identity and validates its complete archive", async () => {
    const input = await fixture();
    const first = createExportBundle({
      ...input,
      createdAt: new Date("2026-10-20T00:00:00.000Z"),
    });
    const second = createExportBundle({
      ...input,
      createdAt: new Date("2026-10-20T01:00:00.000Z"),
    });

    expect(first.manifest.recipeDigest).toBe(second.manifest.recipeDigest);
    expect(first.archive.equals(second.archive)).toBe(false);
    const path = await writeArchive(first.archive);
    const loaded = await loadBundle(path);
    expect(loaded.inspection).toMatchObject({
      integrity: "verified",
      redaction: "verified",
      recipe: {
        network: "bundle-sample",
        nodes: ["alice", "bob", "carol"],
        executions: 3,
        expectedPassed: true,
      },
      compatibility: { replayable: true },
    });
    expect(loaded.manifest.artifacts.map((artifact) => artifact.path)).toEqual([
      "report.json",
      "scenario.json",
      "topology.json",
    ]);
  });

  it("redacts and bounds diagnostic logs before archiving", async () => {
    const input = await fixture();
    const secret = "visible-do-not-export";
    const { archive } = createExportBundle({
      ...input,
      diagnostics: {
        network: { path: `${process.cwd()}/private`, token: secret },
        channels: [],
        faults: [],
        logs: {
          ckb: `FIBER_SECRET_KEY_PASSWORD=${secret}\n${"ordinary\n".repeat(20_000)}`,
          "node-alice": `Bearer ${secret}`,
        },
        privatePaths: [process.cwd()],
      },
    });
    const expanded = gunzipSync(archive).toString("utf8");
    expect(expanded).not.toContain(secret);
    expect(expanded).not.toContain(process.cwd());
    expect(expanded).not.toContain("FIBER_SECRET_KEY_PASSWORD");
    expect((await inspectBundleFile(await writeArchive(archive))).level).toBe(
      "diagnostic",
    );
  });

  it("never replaces or removes an existing output file", async () => {
    const input = await fixture();
    const directory = await mkdtemp(join(tmpdir(), "fiber-forge-output-test-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "existing.ffbundle");
    await writeFile(output, "keep me");

    await expect(writeExportBundle({ ...input, output })).rejects.toMatchObject(
      {
        code: "BUNDLE_OUTPUT_EXISTS",
      },
    );
    expect(await readFile(output, "utf8")).toBe("keep me");
  });
});

describe("hostile bundle validation", () => {
  it("rejects duplicate JSON keys and inconsistent report metadata", async () => {
    const input = await fixture();
    const duplicateReport = JSON.stringify(input.report).replace(
      '{"format":',
      '{"format":"fiber-forge-scenario-report","format":',
    );
    expect(() =>
      createExportBundle({ ...input, report: duplicateReport }),
    ).toThrow(/duplicate object keys/);

    const malformedTiming = structuredClone(input.report) as ScenarioReport;
    (malformedTiming.steps[0] as unknown as { durationMs: string }).durationMs =
      "500";
    expect(() =>
      createExportBundle({ ...input, report: malformedTiming }),
    ).toThrow(/durationMs must be an integer/);

    const inconsistent = structuredClone(input.report);
    inconsistent.steps[0].assertions[0].passed = false;
    expect(() =>
      createExportBundle({ ...input, report: inconsistent }),
    ).toThrow(/outcome is inconsistent/);
  });

  it("rejects traversal, links, undeclared entries, corrupt hashes, and new schemas", async () => {
    const built = createExportBundle(await fixture());

    const traversal = mutateArchive(
      built.archive,
      "topology.json",
      ({ header }) => {
        header.fill(0, 0, 100);
        header.write("../evil.json", 0, "ascii");
        updateChecksum(header);
      },
    );
    await expect(loadBundle(await writeArchive(traversal))).rejects.toThrow(
      /unsafe or unsupported/,
    );

    const link = mutateArchive(built.archive, "topology.json", ({ header }) => {
      header.write("2", 156, "ascii");
      updateChecksum(header);
    });
    await expect(loadBundle(await writeArchive(link))).rejects.toThrow(
      /not a regular file/,
    );

    const badChecksum = mutateArchive(
      built.archive,
      "topology.json",
      ({ header }) => {
        header[100] ^= 1;
      },
    );
    await expect(loadBundle(await writeArchive(badChecksum))).rejects.toThrow(
      /checksum is invalid/,
    );

    const executable = mutateArchive(
      built.archive,
      "topology.json",
      ({ header }) => {
        header.write("0000755\0", 100, 8, "ascii");
        updateChecksum(header);
      },
    );
    await expect(loadBundle(await writeArchive(executable))).rejects.toThrow(
      /executable mode bits/,
    );

    const hiddenPadding = mutateArchive(
      built.archive,
      "topology.json",
      ({ padding }) => {
        padding[0] = 1;
      },
    );
    await expect(loadBundle(await writeArchive(hiddenPadding))).rejects.toThrow(
      /non-zero padding data/,
    );

    const files = new Map<string, Buffer>();
    for (const artifact of built.manifest.artifacts) {
      const tar = gunzipSync(built.archive);
      files.set(
        artifact.path,
        Buffer.from(tarEntry(tar, artifact.path).content),
      );
    }
    files.set("Dockerfile", Buffer.from("FROM scratch\n"));
    const unexpected = buildBundleArchive(built.manifest, files);
    await expect(loadBundle(await writeArchive(unexpected))).rejects.toThrow(
      /unsafe or unsupported/,
    );

    const corrupt = mutateArchive(
      built.archive,
      "scenario.json",
      ({ content }) => {
        content[0] ^= 1;
      },
    );
    await expect(loadBundle(await writeArchive(corrupt))).rejects.toThrow(
      /SHA-256/,
    );

    const future = mutateArchive(
      built.archive,
      "manifest.json",
      ({ content }) => {
        const value = content
          .toString("utf8")
          .replace('"major": 1', '"major": 2');
        Buffer.from(value).copy(content);
      },
    );
    await expect(loadBundle(await writeArchive(future))).rejects.toMatchObject({
      code: "BUNDLE_INCOMPATIBLE",
    });
  });

  it("rejects a compressed payload that expands beyond the global limit", async () => {
    const bomb = gzipSync(Buffer.alloc(MAX_BUNDLE_EXPANDED_BYTES + 512));
    await expect(loadBundle(await writeArchive(bomb))).rejects.toThrow(
      /expands past/,
    );
  });
});

class ReplayBackend implements ReplayBundleBackend {
  readonly calls: string[] = [];
  mismatch = false;
  waitForAbort = false;

  constructor(private readonly sourceReport: ScenarioReport) {}

  async assertReplayTargetClean(net: string): Promise<void> {
    this.calls.push(`clean:${net}`);
  }

  async up(
    topology: ReturnType<typeof parseTopology>,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      requireClean?: boolean;
    },
  ): Promise<void> {
    expect(options.requireClean).toBe(true);
    this.calls.push(`up:${topology.name}`);
  }

  async runScenario(
    net: string,
    _scenario: ReturnType<typeof parseScenario>,
    options?: { signal?: AbortSignal },
  ): Promise<ScenarioReport> {
    this.calls.push(`run:${net}`);
    if (this.waitForAbort) {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
    }
    const report = structuredClone(this.sourceReport);
    report.network = net;
    if (this.mismatch) {
      report.steps[1].passed = false;
      report.steps[1].assertions[0].passed = false;
      delete report.steps[1].error;
      report.passed = false;
      report.summary = { total: 3, passed: 2, failed: 1 };
    }
    return report;
  }

  async down(net: string): Promise<void> {
    this.calls.push(`down:${net}`);
  }
}

describe("bundle replay", () => {
  it("compares outcomes and always purges the fresh target", async () => {
    const input = await fixture();
    const path = await writeArchive(createExportBundle(input).archive);
    const backend = new ReplayBackend(input.report);
    const result = await replayBundleFile(backend, path, {
      network: "fresh-replay",
    });

    expect(result.reproduced).toBe(true);
    expect(result.cleanup.purged).toBe(true);
    expect(backend.calls).toEqual([
      "clean:fresh-replay",
      "up:fresh-replay",
      "run:fresh-replay",
      "down:fresh-replay",
    ]);

    const mismatch = new ReplayBackend(input.report);
    mismatch.mismatch = true;
    const mismatched = await replayBundleFile(mismatch, path, {
      network: "different-replay",
    });
    expect(mismatched.reproduced).toBe(false);
    expect(mismatched.differences).not.toHaveLength(0);
    expect(mismatch.calls.at(-1)).toBe("down:different-replay");
  });

  it("purges after cancellation but does not provision an invalid bundle", async () => {
    const input = await fixture();
    const built = createExportBundle(input);
    const validPath = await writeArchive(built.archive);
    const backend = new ReplayBackend(input.report);
    backend.waitForAbort = true;
    const controller = new AbortController();
    const replay = replayBundleFile(backend, validPath, {
      network: "cancel-replay",
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new ForgeError("OPERATION_ABORTED", "test cancellation"));
    await expect(replay).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(backend.calls.at(-1)).toBe("down:cancel-replay");

    const corrupt = mutateArchive(
      built.archive,
      "report.json",
      ({ content }) => {
        content[0] ^= 1;
      },
    );
    const untouched = new ReplayBackend(input.report);
    await expect(
      replayBundleFile(untouched, await writeArchive(corrupt), {
        network: "never-created",
      }),
    ).rejects.toThrow(/SHA-256/);
    expect(untouched.calls).toEqual([]);
  });
});
