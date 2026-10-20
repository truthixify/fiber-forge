import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockerEngine } from "../src/engine";
import { FORGE_LABEL, Orchestrator } from "../src/orchestrator";
import { preset } from "../src/presets";

const live = process.env.FORGE_CCH_TOPOLOGY_E2E === "1";
const describeLive = live ? describe : describe.skip;
const assetsDir = join(import.meta.dirname, "..", "assets");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describeLive("integrated CCH topology", () => {
  it(
    "reaches its exact boundary and purges every managed resource",
    async () => {
      const selected = preset("cch");
      if (!selected) throw new Error("cch preset is unavailable");

      const suffix = `${process.pid}-${Date.now().toString(36)}`.slice(-14);
      const topology = { ...selected, name: `cch-e2e-${suffix}` };
      const stateDir = await mkdtemp(join(tmpdir(), "forge-cch-e2e-"));
      const engine = new DockerEngine();
      const orchestrator = new Orchestrator(engine, assetsDir, stateDir);
      let failure: unknown;
      let cleanupFailure: unknown;

      try {
        await orchestrator.up(topology, { timeoutMs: 10 * 60_000 });
        const status = await orchestrator.cchStatus(topology.name);
        expect(status).toMatchObject({
          state: "ready",
          operator: { container: "running", rpcReady: true },
          lightning: {
            state: "ready",
            channel: { active: true, capacitySats: 1_000_000 },
          },
          fiber: {
            hubStatus: "running",
            userStatus: "running",
            wrappedChannel: {
              state: "ChannelReady",
              capacityBaseUnits: String(topology.cch!.wrappedChannelBaseUnits),
              typeScriptMatches: true,
            },
          },
          boundary: {
            fiberAsset: "simple_udt",
            lightningAsset: "regtest_btc",
            trustedOperator: true,
          },
        });
        expect(
          await engine.listByLabel(FORGE_LABEL, topology.name),
        ).toHaveLength(7);
      } catch (error) {
        failure = error;
      }

      try {
        if (await exists(join(stateDir, topology.name))) {
          await orchestrator.down(topology.name, { purge: true });
        }
        expect(await engine.listByLabel(FORGE_LABEL, topology.name)).toEqual(
          [],
        );
        expect(await engine.networkExists(`forge-${topology.name}`)).toBe(
          false,
        );
        for (const suffix of [
          "ckb-data",
          "bitcoin-data",
          "lnd-hub-data",
          "lnd-user-data",
          "cch-auth",
          "cch-data",
        ]) {
          expect(
            await engine.volumeExists(`forge-${topology.name}-${suffix}`),
          ).toBe(false);
        }
        expect(await exists(join(stateDir, topology.name))).toBe(false);
      } catch (error) {
        cleanupFailure = error;
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }

      if (failure && cleanupFailure) {
        throw new AggregateError(
          [failure, cleanupFailure],
          "CCH topology proof and cleanup both failed",
        );
      }
      if (failure) throw failure;
      if (cleanupFailure) throw cleanupFailure;
    },
    12 * 60_000,
  );
});
