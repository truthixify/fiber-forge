import { describe, expect, it } from "vitest";
import { FakeEngine } from "../src/engine";

describe("FakeEngine", () => {
  it("creates a network idempotently", async () => {
    const e = new FakeEngine();
    await e.ensureNetwork("forge-x", "172.30.0.0/16");
    await e.ensureNetwork("forge-x", "172.30.0.0/16");
    expect(e.networks.get("forge-x")).toBe("172.30.0.0/16");
    expect(e.log.filter((l) => l.startsWith("network")).length).toBe(1);
  });

  it("models the container lifecycle", async () => {
    const e = new FakeEngine();
    expect(await e.status("n1")).toBe("absent");
    await e.run({
      name: "n1",
      image: "img",
      network: "forge-x",
      ip: "172.30.0.11",
      labels: { forge: "x" },
    });
    expect(await e.status("n1")).toBe("running");
    await e.stop("n1");
    expect(await e.status("n1")).toBe("exited");
    await e.remove("n1");
    expect(await e.status("n1")).toBe("absent");
  });

  it("lists containers by label", async () => {
    const e = new FakeEngine();
    await e.run({
      name: "a",
      image: "i",
      network: "n",
      labels: { forge: "x" },
    });
    await e.run({
      name: "b",
      image: "i",
      network: "n",
      labels: { forge: "y" },
    });
    expect(await e.listByLabel("forge", "x")).toEqual(["a"]);
  });
});
