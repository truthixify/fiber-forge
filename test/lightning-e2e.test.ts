import { afterAll, describe, expect, it } from "vitest";
import { pickSubnetBase } from "../src/config";
import { DockerEngine } from "../src/engine";
import {
  type LightningBackendPlan,
  LightningBackend,
  planLightningBackend,
} from "../src/lightning";

const live = process.env.FORGE_LIGHTNING_E2E === "1";
const describeLive = live ? describe : describe.skip;

describeLive("Lightning backend live lifecycle", () => {
  const engine = new DockerEngine();
  const suffix = `${process.pid}-${Date.now().toString(36)}`.slice(-18);
  const net = `lnd-${suffix}`;
  const backend = new LightningBackend(engine);
  let plan: LightningBackendPlan | undefined;

  afterAll(async () => {
    if (!plan) return;
    await backend.down(plan).catch(() => undefined);
    await engine.removeNetwork(plan.network).catch(() => undefined);
  });

  it(
    "starts from clean state, reaches RPC-derived readiness, and removes all state",
    async () => {
      const subnetBase = pickSubnetBase(net, await engine.usedSubnets());
      plan = planLightningBackend(net, `forge-${net}`, subnetBase);
      await backend.down(plan);
      await engine.removeNetwork(plan.network);
      await engine.ensureNetwork(plan.network, plan.subnet, {
        labels: { "fiber-forge": plan.net },
      });

      const ready = await backend.start(plan, { timeoutMs: 5 * 60_000 });
      expect(ready).toMatchObject({
        state: "ready",
        bitcoin: { container: "running" },
        hub: { container: "running", syncedToChain: true, activeChannels: 1 },
        user: { container: "running", syncedToChain: true, activeChannels: 1 },
        channel: {
          active: true,
          capacitySats: 1_000_000,
          hubLocalSats: expect.any(Number),
          userLocalSats: expect.any(Number),
        },
        dataVolumesPresent: true,
      });
      expect(
        ready.channel!.hubLocalSats + ready.channel!.userLocalSats,
      ).toBeLessThanOrEqual(ready.channel!.capacitySats);
      const authFiles = await engine.exec(plan.containers.hub, [
        "ls",
        "-1",
        "/cch-auth",
      ]);
      expect(authFiles).toMatchObject({ exitCode: 0 });
      expect(authFiles.stdout.trim().split("\n").sort()).toEqual([
        "cch.macaroon",
        "tls.cert",
      ]);

      await backend.down(plan);
      expect(await backend.status(plan)).toMatchObject({
        state: "absent",
        bitcoin: { container: "absent" },
        hub: { container: "absent" },
        user: { container: "absent" },
        dataVolumesPresent: false,
      });
      expect(await engine.networkExists(plan.network)).toBe(true);
      await engine.removeNetwork(plan.network);
      expect(await engine.networkExists(plan.network)).toBe(false);
    },
    6 * 60_000,
  );
});
