import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

async function loadGuiComponent() {
  const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");
  const script = html.match(
    /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/,
  )?.[1];
  if (!script) throw new Error("GUI component script not found");
  return new Function("DCLogic", `${script}\nreturn Component;`)(class {});
}

describe("GUI topology and payment usability", () => {
  it("uses stable asset channel colors and explicit node metrics", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    expect(html).toContain(
      "const assetColor = ch.udt ? 'var(--flux)' : 'var(--ember)'",
    );
    expect(html).toContain("const trackPad = Math.max(18");
    expect(html).toContain("stroke: 'transparent', strokeWidth: width + 18");
    expect(html).toContain('aria-label="Filter topology channels by asset"');
    expect(html).toContain(
      "const unrelatedToChannel = selectedChannel && !isEndpoint",
    );
    expect(html).toContain("dot: 'var(--flux)', band: 'var(--flux)'");
    expect(html).toContain("ON-CHAIN WALLET · CKB");
    expect(html).toContain("CKB IN CHANNELS");
    expect(html).toContain("UDT IN CHANNELS");
    expect(html).toContain("'CKB CH ' + ckbDeg");
    expect(html).not.toContain("const gaugeFrac");
    expect(html).not.toContain("{{ spark }}");
    expect(html).not.toContain("emberLen");
    expect(html).not.toContain("rotate(45 ' + bead.x");
  });

  it("preflights directional liquidity and offers inline recovery", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    expect(html).toContain("_routeAnalysis(nodes, channels, u, v, balances)");
    expect(html).toContain("analysis.capacity < this.state.payAmt");
    expect(html).toContain("VISIBLE OUTBOUND");
    expect(html).toContain("SHORTFALL");
    expect(html).toContain('disabled="{{ sendDisabled }}"');
    expect(html).toContain("openCapForPayment");
    expect(html).toContain("payRecoveryLabel: 'OPEN '");
    expect(html).toContain(
      "const cap = this.state.capacity, udt = this.state.capUdt",
    );
    expect(html).toContain("(udt ? ' --udt' : '')");
    expect(html).toContain("SEND FROM {{ nName }}");
  });

  it("chooses the widest route using directional channel balances", async () => {
    const Component = await loadGuiComponent();
    const component = Object.create(Component.prototype);
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const channels = [
      { id: "ab", from: "a", to: "b", cap: 100 },
      { id: "bc", from: "b", to: "c", cap: 100 },
      { id: "ac", from: "a", to: "c", cap: 100 },
    ];
    const balances = { ab: 80, bc: 60, ac: 25 };

    expect(
      component._routeAnalysis(nodes, channels, "a", "c", balances),
    ).toEqual({
      nodes: ["a", "b", "c"],
      hops: [
        { chId: "ab", reversed: false },
        { chId: "bc", reversed: false },
      ],
      capacity: 60,
    });
    expect(
      component._routeAnalysis(nodes, channels, "c", "a", balances),
    ).toEqual({
      nodes: ["c", "a"],
      hops: [{ chId: "ac", reversed: true }],
      capacity: 75,
    });
  });

  it("supports two-node channel selection and navigable peer and channel rows", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    expect(html).toContain("event.metaKey || event.ctrlKey");
    expect(html).toContain("if (!interactive && !moved");
    expect(html).toContain("pairSelectionCount");
    expect(html).toContain('onClick="{{ openPairChannel }}"');
    expect(html).toContain('onClick="{{ p.select }}"');
    expect(html).toContain('onClick="{{ c.select }}"');
    expect(html).toContain('aria-label="Open node {{ p.name }}"');
    expect(html).toContain('aria-label="Open channel with {{ c.peer }}"');
  });
});
