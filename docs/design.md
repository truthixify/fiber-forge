# fiber-forge — Design Specification

> The design source of truth for the fiber-forge GUI (and the visual language the CLI mirrors).
> Feed this document to a design tool or build against it directly. The aesthetic is a **forge
> instrument panel** — flat, squared, hairline-ruled, mono-labeled — with a warm/cool palette where
> **liquidity reads as heat**: ember fire for energy and funds, cool steel-teal for structure and
> flow. Inspired by (not copied from) the infern control-console language.

---

## 1. Concept & principles

fiber-forge is a **forge you can see**. A local Fiber payment-channel network is a thermal system:
nodes are forge cells, channels are conduits carrying **molten liquidity**, the CKB dev chain is a
glowing core that pulses with every block, and a payment is a **spark** that races the conduits.
Well-funded channels glow warm; depleted ones go cold. You don't read a table of balances — you
read the network's *heat*.

**Principles**

1. **The graph is the instrument.** The network fills the screen as one live panel; chrome is thin,
   squared, and docked to edges — never a column that boxes the graph in.
2. **Liquidity is heat.** Every balance, capacity, and flow is encoded as temperature and light, so
   the whole network's state is legible at a glance without reading a number.
3. **Selection drives everything.** Nothing selected → calm panel. Select a node or channel → one
   right-side readout swaps to it. Never stacked modals, never competing panels.
4. **Every motion is a real state transition.** A conduit igniting = `ChannelReady`. A spark
   arriving = `send_payment → Success`. Motion is telemetry, not decoration.
5. **Calm at rest, alive on events.** Ambient motion (core flicker, health pulse) stays ≤ 4%
   intensity; only real events flare.
6. **GUI ⇄ CLI are one tool.** Every action names its `forge …` command and shares this palette
   and glyph set (§11). Anything you can click, you can script.

**Grounded in the real data model.** `NetworkView { nodes[{name, container, rpcHostPort, pubkey,
status}], channels[{from, to, capacityCkb, state}] }`; the RPC surface (`nodeInfo`, `connectPeer`,
`openChannel`, `listChannels`, `shutdownChannel`, `newInvoice`, `sendPayment`, `getPayment`);
presets (`duo/trio/hub`, `line:N/ring:N/star:N`); node names from the fun pool (philosophers,
scientists, historical figures); channel states (`ChannelReady`, negotiating/pending, `unknown`).

---

## 2. The visual system (start here — it defines everything else)

### 2.1 Color — a warm/cool forge palette

The beauty is the **duality**: cool graphite steel for structure, warm ember fire for energy and
liquidity. Every surface is cool and quiet; every *live* thing is warm and glowing. Dark-only.

**Surfaces — cool graphite, a whisper of warmth so it's never sterile**

| Token | Hex | Use |
|---|---|---|
| `--void` | `#090B0F` | deepest backdrop, behind the graph |
| `--base` | `#0E1217` | app background |
| `--panel` | `#161B22` | docked panels, readout bodies |
| `--panel-2` | `#1E252E` | node cells, raised rows, inputs |
| `--inset` | `#06080B` | wells, code/log areas |
| `--hairline` | `#232B35` | 1px dividers (used liberally) |
| `--border` | `#323C48` | panel borders, button outlines |

**Text — warm off-white, like light off hot metal**

| Token | Hex | Use |
|---|---|---|
| `--bone` | `#F3EFE7` | headings, focal readings (the one bright thing per block) |
| `--text` | `#C6CFDB` | body, values |
| `--muted` | `#808B9C` | mono-caps labels, units, keys |
| `--faint` | `#4C5768` | rules, timestamps, disabled |

**Warm — fire, energy, local liquidity, focal action (use sparingly; it always means "live/hot")**

| Token | Hex | Use |
|---|---|---|
| `--ember` | `#FF6A3D` | **hero accent** — brand, focal point, primary action, payment sparks, local liquidity |
| `--ember-hot` | `#FF8F5E` | hover/active ember, hottest part of a flow |
| `--ember-deep` | `#D2481D` | pressed, deep-heat gradient stop |
| `--ember-glow` | `#FFC2A3` | bloom/halo behind live elements (low opacity) |
| `--gold` | `#F5C451` | on-chain CKB, funding, treasury |

**Cool — structure, ready state, remote liquidity, flow (the calm counterweight to ember)**

| Token | Hex | Use |
|---|---|---|
| `--flux` | `#2DE0C7` | `ChannelReady`, healthy, remote liquidity, the cool accent |
| `--flux-deep` | `#14A896` | flux gradient stop, dim flux |
| `--signal` | `#5AA0FF` | info, links, secondary highlight |
| `--violet` | `#A98BFF` | routes, invoices, multi-hop path highlight |

**Alert**

| Token | Hex | Use |
|---|---|---|
| `--amber` | `#F0A93C` | pending / negotiating, warnings |
| `--alarm` | `#FF5765` | errors, failed payments, destructive |

**The signature gradient — the liquidity conduit.** A channel's fill runs `--ember (local) →
--flux (remote)` with the balance bead at the split. A 60/40 channel is 60% warm, 40% cool. A
depleted local side cools toward `--faint` steel. This single encoding makes network-wide liquidity
readable as a thermal map. Payment spark: `radial(#FFE9D8 → --ember → transparent)`. Ready-conduit
glow: `--flux → --ember-glow` low-opacity bloom. Forge-core: `conic(--gold → --ember → --ember-deep)`
slow rotate.

### 2.2 Form — flat, squared, hairline

- **Squared corners everywhere (radius 0).** No rounded cards. It reads as precision instrumentation.
- **No drop shadows, no glass blur.** Depth comes from **hairline borders** and one-step surface
  shifts (`--panel` → `--panel-2`), not elevation. The only "glow" is the ember/flux bloom on
  genuinely live elements.
- **Hairlines do the work.** Cells in a grid are separated by 1px `--hairline`, not gaps. Sections
  are ruled, not boxed.
- **HUD L-brackets** (ember, 2px, 14px arms) frame a *focal* reading — a node's balance, a
  payment's amount — like a targeting reticle. Reserved for the one number that matters in a view.
- **Offset-ember block:** a solid `--ember` rectangle nudged behind a hero card (no blur) — a
  brutalist "hot backing plate." Used once per screen at most (the selected node, the pay result).
- **Thermal grid:** the graph backdrop is a faint ember blueprint grid
  (`color-mix(--ember 5%)` lines, 80px) with a cool vignette — the forge floor.

### 2.3 Type

- **Sans:** Geist (or Inter), variable. Headings `-0.01em`. Body 14px base.
- **Mono:** Geist Mono / JetBrains Mono — used heavily for **labels** as small tracked caps
  (`mono-caps`: 10–11px, `letter-spacing 0.14em`, uppercase, `--muted`), for all numbers (tabular
  figures — non-negotiable so live counters don't jitter), pubkeys, ports, logs, console.
- **Display:** Geist heavy for the network name and focal readings (26–40px).
- Scale (px): `10 · 11 · 12 · 13 · 14 · 16 · 20 · 26 · 34 · 40`.

### 2.4 Motion — precise, not bouncy

Instrument motion: decisive eases, not playful springs. `cubic-bezier(0.2, 0.8, 0.2, 1)`, durations
140ms (micro), 220ms (panels), 400ms (payment beats). Live signatures: **pulse-dot** (opacity
0.6↔1, 1.6s) for anything live; **kindle** flicker (`--ember ↔ --ember-hot`, 2.4s) on the
forge-core and node health; **ignite** (a conduit morphing pending→ready: amber-dashed → the
ember/flux gradient fills in 400ms with one bright sweep); balance number rolls 600ms. Everything
respects `prefers-reduced-motion` (pulses → single fades, flicker freezes).

### 2.5 Iconography

Lucide (1.5px stroke) + a small forge set: node = a hexagonal **cell** chip, channel = a two-headed
**conduit**, payment = a **spark**, fund = a **coin-stack**, chain = an **anvil/core**, forge action
= a **hammer** ⚒. States use a filled dot in the semantic color.

---

## 3. The network graph — the innovation

This is the centerpiece and where fiber-forge stops looking like every other node-graph. It is a
**live thermal circuit** on the forge floor.

### 3.1 Nodes — forge cells (instrument readouts, not bubbles)

Each node is a **squared cell** (~184×96 at 100%), built like an instrument readout: a mono-caps
**state band** across the top, the identity below, a molten balance gauge inside. It is a component,
not a circle.

```
┌ NODE ──────────────────────── ● RUNNING ┐   ← state band: mono-caps, dot pulses when live
│ feynman                          :8300   │   name (sans) · port (mono, ember)
│ 0x03f2…9ac1                              │   pubkey (mono, muted) — click to copy
│ ┌ ON-CHAIN ──────────────────────────┐  │
│ │ 9,842 CKB   ▛▀▀▀▀▀▀▀▀▀▀▀▀▚░░░░░░░  │  │   molten gauge: gold fill = funded, cools to steel
│ └──────────────────────────────────────┘  │
│ CHANNELS ×3        CAP 3,000 CKB          │   mono-caps footer, hairline-topped
└───────────────────────────────────────────┘
   ◟ 4 hairline conduit-ports (N/E/S/W) kindle in Wire mode
```

- **Identity color:** a deterministic hash of the pubkey warms the state-band dot and the name to a
  stable hue drawn from the palette (ember / gold / flux / signal / violet) — so a node is
  recognizable at a glance and across sessions, without a rainbow.
- **Health = kindle.** Running: the top state band reads `● RUNNING` with an ember dot that pulses;
  the cell's border warms faintly. Unhealthy: band → `◍ DEGRADED` amber, border flickers amber.
  Exited: band → `○ STOPPED`, the whole cell desaturates to cold steel (ash). Satisfies "node
  unhealthy within 2s" as a visible cool-down.
- **Level of detail:** < 40% zoom the cell collapses to a labeled chip with a heat halo; mid-zoom
  shows the band + name; full-zoom shows the gauge + footer. Keeps a 10-node `hub` legible.
- **Selected:** an offset-ember backing plate slides behind the cell + an ember focus border; the
  cell lifts by surface shift (no shadow). **Dragging:** connected conduits rubber-band and
  re-tauten; position persists per network.
- **Hub emphasis:** high-degree nodes (`hub`/`star` center) render larger with a warmer thermal-grid
  halo — topology reads instantly.

### 3.2 Channels — molten conduits (liquidity as heat)

A channel is a **conduit** (a squared-shouldered bézier rail, not a thin line) whose *fill* is the
liquidity thermal map:

- **Fill = balance split.** The conduit is filled from the `from` end in **ember** and from the
  `to` end in **flux**, meeting at a **balance bead** at the `local/capacity` position. You see, on
  every wire, exactly how liquidity sits — warm where `from` holds it, cool where `to` does. Hover
  → the bead expands into a mono-caps mini-readout `LOCAL 600 · REMOTE 400`.
- **Capacity = conduit width** (log-scaled 3–9px). Fat conduits carry more.
- **State = texture.** `ChannelReady` → the fill is solid and *glows* (ember/flux saturated, faint
  bloom, a slow directional shimmer of energy). Pending/negotiating → **amber dashed march**, unlit.
  `unknown`/unreachable → **cold steel**, 35% opacity, static.
- **Ambient heat flow:** on ready conduits, faint ember motes drift from the hotter (funded) side —
  the network looks like it's carrying molten metal, subtly.
- **Hover:** conduit thickens 1.5×; a readout chip `feynman ⇄ lorentz · 1,000 CKB · 60/40`.
  **Click:** the channel readout opens.

### 3.3 The CKB dev chain — the forge core

At the graph's center sits the **forge-core**: a squared anvil glyph inside an ember/gold conic ring
that **kindles**, and **pulses once per block** (a single ring expands and fades). Under it, a
mono-caps readout `CORE · BLOCK #47 · 6 CKB TX`. It's the visual anchor that says "this network is
alive and mining," and the loading state grows out of it (§7).

### 3.4 Payments — sparks racing the conduits (the money shot)

On `sendPayment` → poll `getPayment`:

1. The route ignites: participating conduits flare to full ember/flux glow; everything else cools to
   25% (spotlight the path). A multi-hop route lights **every** hop, tinted `--violet`.
2. A **spark** (bright ember orb, comet trail, `--ember-glow` bloom) launches from the sender, races
   conduit 1, and **strikes** each relay (which flares as it forwards), then continues to the payee.
3. On `Success`: the payee emits a **flux ignition ring**, the spark bursts into motes, and the
   **balance beads on every hop slide** to their new split — you watch liquidity redistribute across
   the multi-hop route in real time, warm shifting to cool. An HUD-bracketed `+250 CKB` reading
   flares up from the payee.
4. On failure: the spark turns `--alarm`, halts at the failing hop, shudders, and gutters out; that
   conduit flashes red; a toast names the failing node. The dead spark lingers ~1.5s so the failure
   point is *seen*.

Tuned so a 2-hop payment reads in ~1.4s. Concurrent payments = concurrent sparks (great for a
traffic generator).

### 3.5 Canvas mechanics

Infinite pan (space/middle-drag), scroll-zoom to cursor, `⌘0` fit, `⌘1` 100%. Layout switch —
**radial** (default, matches the current SVG ring), **force**, **hierarchical/dagre** (`line`
chains) — tweens positions with a staggered ease. Manual positions persist per network. Thermal-grid
backdrop, cool edge vignette.

---

## 4. Information architecture

Z-layers over the forge floor — thin, squared, hairline chrome; never full-height columns.

- **Layer 0 — Forge floor** (fills viewport): the thermal graph.
- **Layer 1 — Chrome** (squared panels, hairline borders, docked to edges):
  - **Top-left — Rig readout:** network name, `● healthy` pulse-dot, node/channel counts.
  - **Top-center — Vitals rail:** hairline-separated mono-caps cells — `NODES 3 · CHANNELS 2 ·
    CAPACITY 2,000 · ON-CHAIN 29,530 · BLOCK #47 · PAY/MIN 4`. Updates within the 2s budget.
  - **Top-center — Mode dock** (keys 1–5): `SELECT · WIRE · PAY · FUND · PIN`.
  - **Top-right — Command bar:** `⌘K` palette, `⚒ SPAWN`, `⚡ PAY`.
  - **Bottom-left — Mini-map** (thermal miniature + viewport frame).
  - **Bottom-center — Zoom + layout dock.**
  - **Bottom — The DECK** (collapsible): `LOGS · TIMELINE · PAYMENTS · CONSOLE · TERMINAL`.
    Collapsed = a 28px ticker: last event + a throughput sparkline.
- **Layer 2 — Readout drawer** (right, ~380px): swaps node / channel / payment readout by
  selection. Slides over the floor; floor cools 8% behind it, stays interactive.
- **Optional — Explorer** (left, 264px): a hairline tree `NETWORK › NODES › (peers, channels)` with
  per-row state dots and a filter. **Linked views:** selecting here highlights on the floor and vice
  versa. Off by default for the calm floor; on for power users.

---

## 5. Readout drawers

### 5.1 Node readout (right)

Tabbed: `OVERVIEW · PEERS · CHANNELS · LOGS · CONSOLE`.

```
┌ NODE ─────────────────────────────── ✕ ┐
│ ● RUNNING   forge-trio-node-0            │
│ feynman                                  │
│ 0x03f2c9…9ac1                [copy] [⧉]  │  ⧉ = copy RPC URL ("point your app here")
├──────────────────────────────────────────┤
│ OVERVIEW  PEERS  CHANNELS  LOGS  CONSOLE  │
├──────────────────────────────────────────┤
│ ┌ BALANCE ─────────────────────────────┐ │  HUD-bracketed focal reading (ember)
│ │  9,842.0 CKB   on-chain               │ │
│ │  1,830.0 CKB   in channels (3)        │ │
│ │  ◕ heat donut · 60s throughput ▁▂▅▃▇  │ │
│ └───────────────────────────────────────┘ │
│ ENDPOINT   http://127.0.0.1:8300   [copy] │
│ P2P        /ip4/…/tcp/8228/p2p/Qm…        │
│ ─────────────────────────────────────────│
│ [ FUND + ]  [ OPEN CHANNEL → ]            │  ember primary / bone-outline secondary
│ [ INVOICE ]  [ PAY FROM ]                 │
└───────────────────────────────────────────┘
```

- **Overview:** on-chain vs in-channel, a **heat donut** (funded = gold arc, locked = ember,
  free = steel), a per-node throughput sparkline, and the copyable endpoint (the "point your app at
  a forge node" story).
- **Peers:** `listPeers` as pubkey chips + connection dots; click pans to that node.
- **Channels:** this node's conduits with mini thermal bars; row click selects the conduit.
- **Logs:** streamed `docker logs`, level filter chips, search, color-coded gutter.
- **Console:** a raw RPC console (pick method → params → pretty JSON). Mutating methods badged. Turns
  the GUI into a learning + debugging tool.

### 5.2 Channel readout (right)

```
┌ CHANNEL ──────────────────────────── ✕ ┐
│ feynman  ⇄  lorentz         ● CHANNELREADY│
│ 0x9c1a…be40                      [copy]  │
├──────────────────────────────────────────┤
│ CAPACITY   1,000 CKB                      │
│  feynman ▟█████████████▙░░░░░░░ lorentz   │  the liquidity conduit, full width
│          600 CKB   ◆ split   400 CKB      │  ember (local) ◆ flux (remote)
│ STATE   NEGOTIATING → FUNDING → READY ✓   │  state-machine breadcrumb, current lit
│ FUNDING 0x4f…   ·   OPENED 12s ago        │
│ ─────────────────────────────────────────│
│ [ SEND PAYMENT ACROSS → ]                 │
│ [ ⚠ CLOSE CHANNEL ]                       │  alarm-outline, inline confirm
└───────────────────────────────────────────┘
```

- The **liquidity bar is the hero**: ember→flux with the split bead, animated on any balance change.
- **State-machine breadcrumb** makes amber "pending" conduits legible while opening.
- **Close** (`shutdownChannel`): inline confirm; on confirm the conduit *cools* (glow drains, ember
  and flux fade to steel), the split collapses to the settling side, the conduit retracts into both
  cells with a snap, and a settlement event lands in the timeline.

---

## 6. Core flows

- **Create-network wizard** (`forge up`): a right-anchored 3-step slide-over (`TOPOLOGY → FUNDING →
  REVIEW & FORGE`), floor visible behind. Preset cards render an animated topology glyph of the
  actual shape; `line/ring/star` reveal an **N stepper** (`MIN..MAX_NODES`) with a live preview.
  "Build custom" → a visual editor or Monaco YAML with inline `topology.ts` validation (unknown ref,
  capacity below reserve, dup names). **Forge it → the boot sequence _is_ the loading state** (§7).
- **Fund a node** (Fund mode / quick action): amount stepper (1k/10k/100k CKB) from the treasury →
  the cell's on-chain gauge **fills with gold** (animated), a `+10,000 CKB` chip flares, timeline
  logs it. Maps to funding.
- **Open a channel** (Wire mode — the signature gesture): grab a cell's conduit-port → an
  **amber-dashed rail** rubber-bands to the cursor; valid targets kindle, invalid dim; release → a
  squared **capacity popover** (`CAPACITY ◀━●━ 1,000 CKB`, `PUBLIC ✓`, `OPEN ⚒`). Confirm →
  `connectPeer → openChannel → poll listChannels`; the rail renders amber/dashed with a state
  stepper, then **ignites** into the ember/flux gradient on `ChannelReady`. Maps to `forge channel
  open`.
- **Create / pay an invoice:** create → `newInvoice` → a copyable `invoice_address` + QR, and a
  playful claimable "invoice token" dropped near the payee. Pay (Pay mode): click sender → click
  payee → a squared pay sheet (`FROM · TO · AMOUNT · ROUTE feynman→lorentz→galileo`, hops preview on
  the floor) → the spark animation (§3.4). Maps to `forge pay`.
- **Close / teardown:** channel readout → Close (§5.2); network teardown from the rig readout → maps
  to `forge down` with `KEEP DATA` / `WIPE EVERYTHING` toggles.

---

## 7. Live logs + timeline (the DECK) and states

**DECK** tabs: **Timeline** (typed, iconographic events — `NETWORK FORGED`, `FUNDED feynman 10,000
CKB`, `CHANNEL feynman⇄lorentz → READY`, `PAYMENT feynman→galileo SUCCESS 250 CKB`, `CHANNEL
CLOSED`; each clickable → flies the floor to the elements, color-coded warm/cool/alarm),
**Payments** (a ledger: time · from→to · amount · hops · status · latency; row click replays the
spark), **Logs** (per-node `docker logs`, level chips, search, follow), **Console** (RPC console),
**Terminal** (shows the equivalent `forge …` command for whatever you just did — GUI→CLI
transparency). Collapsed = a single-line ticker.

**States**

- **Empty:** the thermal grid with a large cold **anvil silhouette**, `NO NETWORK FORGED YET`, a
  primary `FORGE A NETWORK ⚒`. Faint ash-nodes drift behind. Inviting, not dead.
- **Loading = the forge sequence (loading state _and_ the wow moment):** "Forge it" transitions into
  the floor. The **forge-core ignites** and starts mining; nodes **materialize cold and warm up**
  one by one as the orchestrator boots them; conduits draw themselves amber/dashed and **ignite** to
  the gradient as channels reach ready; a slim top rail mirrors `onProgress` verbatim. The user
  watches the network **forge itself**. Needs a WS push of orchestrator progress (upgrade from the
  2s poll).
- **Skeleton:** cells shimmer for balances until `listChannels` returns; conduits render cold steel
  until state is known.
- **Daemon lost:** rig dot → alarm, non-blocking `LOST CONNECTION — RETRYING…` banner, floor cools
  30% and freezes but stays readable (last-known state); auto-reconnect, flux flash on return.
- **Node unhealthy:** within 2s the cell cools to ash, its conduits go steel, a timeline alarm lands,
  the open readout surfaces the last log lines.
- **Action failed:** inline in the sheet + an alarm toast naming the failing node/hop; never a raw
  stack.

**Responsive:** ≥1280 full; 768–1280 Explorer→icons, readout→overlay sheet, vitals wrap; <768
view-only (floor + rig + bottom sheet, actions via buttons). The GUI is a companion to the CLI.

---

## 8. Tech stack & component inventory

**Core:** React 18 + TypeScript + Vite (ESM). The daemon serves the built bundle in place of today's
single `gui.html`; a single-file build (`vite-plugin-singlefile`) keeps "the daemon serves one
artifact" true.

**Graph/floor:** **React Flow (`@xyflow/react`)** — infinite pan/zoom, draggable custom node/edge
components (forge cells + molten conduits are components), `onConnect` → open-channel for free, plus
mini-map. `d3-force`/`dagre`/`elkjs` for layouts; a hand-rolled radial default. A **custom
SVG/Canvas overlay** synced to the viewport transform renders sparks, conduit fills, and core pulses
along the edge paths (drop to PixiJS/regl only if a traffic generator stresses it).

**Motion:** Framer Motion (precise eases, `AnimatePresence`, number rolls). **Styling:** Tailwind
with the palette as CSS variables + shadcn/ui (Radix) for drawers, dialogs, popovers, palette,
toasts, tabs, tooltips; `cmdk` for `⌘K`; `lucide-react` icons. **State/data:** Zustand (selection,
mode, positions), TanStack Query for daemon fetches. **Upgrade the daemon** from `GET /api/state`
polling to a **WebSocket** pushing `NetworkView` diffs + orchestrator progress — powers < 2s
reactivity, the forge-sequence loading, and payment/close animations. Keep `/api/state` as fallback.

**Component inventory:** `ForgeFloor`, `NodeCell`, `ConduitEdge`, `ForgeCore`, `SparkLayer`,
`RigReadout`, `VitalsRail`, `ModeDock`, `CommandBar`, `MiniMap`, `LayoutDock`, `ReadoutDrawer`
(`NodeReadout`/`ChannelReadout`/`PaymentReadout`), `ExplorerTree`, `Deck`
(`Timeline`/`PaymentsLedger`/`LogsPanel`/`RpcConsole`/`Terminal`), `Wizard`, `FundSheet`, `PaySheet`,
`CapacityPopover`, `HudBracket`, `StateBand`, `PulseDot`, `EmberBrackets`, `Toast`, `EmptyState`,
`ForgeSequence`.

---

## 9. CLI alignment (`src/ui.ts`)

The terminal is the same instrument in ANSI: warm ember for the live/focal thing, cool flux/teal for
structure and ready state, mono-caps labels, hairline rules, squared ASCII brackets, and a braille
spinner. `--json` bypasses it all for scripting.

| Role | Truecolor | Terminal use |
|---|---|---|
| ember | `#FF6A3D` | brand, active spinner, focal number, payment beat, headings' accent |
| flux | `#2DE0C7` | `ChannelReady`, healthy `●`, ports, "ready" state |
| gold | `#F5C451` | CKB amounts, funded |
| amber | `#F0A93C` | `◍` pending/negotiating |
| alarm | `#FF5765` | `✗` failed / unreachable / errors |
| muted | `#808B9C` | mono-caps labels, `→`, `·` |
| faint | `#4C5768` | rules `─`, tree `├─ └─ │`, brackets `┌ ┐ └ ┘` |

`forge up trio` — live progress then a squared summary readout:
```
  FIBER-FORGE · spinning up trio

  ✔ NETWORK              0.3s
  ✔ CKB                  2.1s
  ✔ NODES    3/3         4.8s
  ✔ FUND     3/3         3.2s
  ✔ CONNECT              1.1s
  ✔ CHANNELS 2/2         6.0s
  ✔ READY

  ┌ TRIO ──────────────────────────────────────────── READY ┐
  │ NETWORK   forge-trio                                     │
  │ CKB RPC   http://127.0.0.1:8114                          │
  │ ───────────────────────────────────────────────────────│
  │ ● feynman   http://127.0.0.1:8300                        │
  │ ● lorentz   http://127.0.0.1:8301                        │
  │ ● galileo   http://127.0.0.1:8302                        │
  │ ───────────────────────────────────────────────────────│
  │ feynman → lorentz   ● CHANNELREADY   1000 CKB            │
  │ lorentz → galileo   ● CHANNELREADY   1000 CKB            │
  └──────────────────────────────────────────────────────────┘

  NEXT   forge status trio · forge pay trio feynman galileo 42 · forge gui trio
```

`forge status` — nodes + channels tree; `forge ls` — a hairline-ruled table; `forge pay` — a settle
spinner then an ember-bracketed `PAID 42 CKB · SUCCESS` readout; errors render as a squared alarm
readout (`✗ ERROR` band + the message + a suggested next command), never a raw stack. Every GUI
action prints its `forge …` equivalent in the DECK's Terminal — the loop is closed.

---

## Appendix — reference wireframes (monospace = the real proportions)

### A. Forge floor at rest (trio)
```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ┌ TRIO · ● HEALTHY ┐   NODES 3 · CH 2 · CAP 2K · #47      ┌ ⚒ SPAWN · ⚡ PAY ┐  │
│ └──────────────────┘        ⌘K                            └─────────────────┘  │
│                     ┌ SELECT · WIRE · PAY · FUND · PIN ┐                        │
│        ┌ NODE ── ● RUNNING ┐                                                    │
│        │ feynman     :8300 │▟███████████(60 ◆ 40)███████▙ ┌ NODE ── ● RUNNING ┐ │
│        │ 9,842 CKB ▛▀▀▚░░░ │                             │ lorentz     :8301 │ │
│        └───────────────────┘             ◍ CORE #47      │ 9,970 CKB ▛▀▀▀▚░░ │ │
│                                          (kindling)      └─────────┬─────────┘ │
│                                             ▟███████(40 ◆ 60)██████▙            │
│                                                        ┌ NODE ── ● RUNNING ┐    │
│                                                        │ galileo     :8302 │    │
│                                                        └───────────────────┘    │
│ ┌ ▖MAP ┐        ┌ RADIAL · 100% · ⤢ ┐        ┌ ⚡ PAYMENT …→galileo SUCCESS ┐  │
└───────────────────────────────────────────────────────────────────────────────┘
```

### B. Node selected → readout + spark mid-flight
```
┌───────────────────────────────────────────────────────┬─────────────────────┐
│ ┌ TRIO ┐   SELECT · WIRE · PAY · FUND · PIN            │ ┌ NODE ──── ● RUN ┐ │
│ ▓┌ NODE ── ● RUNNING ┐   ← offset-ember backing        │ │ feynman         │ │
│ ▓│ feynman     :8300 │                                 │ │ 0x03f2…9ac1     │ │
│  └────────●✦→→→──────┘  spark (ember comet)            │ ├ OVERVIEW ─────── │ │
│      route flares ember/violet                         │ │┌ BALANCE ──────┐ │ │
│        ┌ NODE ── ● RELAY ┐  ← flares, forwarding       │ ││ 9,842 CKB     │ │ │
│        │ lorentz         │                             │ │└───────────────┘ │ │
│        └───────✦→→→●─────┘                             │ │ ENDPOINT :8300   │ │
│              ┌ NODE ── ○ … ┐  (cooled, awaiting)       │ │ [FUND+][OPEN →]  │ │
│              │ galileo     │                           │ │ [INVOICE][PAY]   │ │
│  ┌ ⚡ PAYING feynman→galileo 250 CKB … ┐               │ └──────────────────┘ │
└───────────────────────────────────────────────────────┴─────────────────────┘
```

### C. Forge sequence (loading = the network building itself)
```
┌───────────────────────────────────────────────────────────────────────────────┐
│                          ⚒  FORGING  trio  ⚒                                   │
│  ██████████████████████████░░░░░░░░  FUNDING lorentz 10,000 CKB                 │
│                          ◍ FORGE-CORE · BLOCK #47 · kindling                    │
│         ┌ NODE ── ● BOOT ┐                                                       │
│         │ feynman        │┄┄┄┄ amber dashed ┄┄┄┄┐ CONNECTING PEER                │
│         └────────────────┘             ┌ NODE ── ◌ … ┐                          │
│                                        │ lorentz     │  ← warming in             │
│                                        └─────────────┘   ⋯ galileo (cold)        │
│  RAIL →  ● network  ● ckb ready  ● feynman rpc  ◐ funding  ○ open feynman→…      │
│                                                      [ RUN IN BACKGROUND ]       │
└───────────────────────────────────────────────────────────────────────────────┘
```
```
LEGEND   ● live/ready (flux)   ◍ pending (amber)   ○ cold/stopped   ✦ spark (ember)
         ◆ balance split       ▟█▙ molten conduit  ⚒ forge action   ◐ in progress
```
