# fiber-forge — Design Specification

> The design source of truth for the fiber-forge GUI (and the visual language the CLI already
> implements). Feed this document to a design tool or build against it directly. It unifies three
> explored directions — a spatial **canvas**, an observability **dashboard**, and an IDE
> **workbench** — into one coherent product: a *living* local Fiber network you can watch, arrange,
> and drive.

---

## 1. Vision & principles

fiber-forge turns a local Fiber payment-channel network into a **living world you can see**. You
don't read a table of channels — you watch liquidity sit on the wires, arrange nodes by hand, and
see a payment race across the graph as a pulse of light. It is Polar's clarity with Figma's
tactility and a power grid's sense of live energy.

**Principles**

1. **The graph is the product.** The network graph fills the screen; everything else floats over
   it or docks to an edge. Chrome never boxes the graph into a column.
2. **Selection drives everything.** Nothing selected → calm canvas. Select a node → its inspector
   slides in. Select a channel → the channel inspector. One drawer swaps content by selection
   type; never competing panels, never stacked modals.
3. **Every animation maps to a real state transition.** A wire turning mint = `ChannelReady`. A
   pulse arriving = `send_payment → Success`. Motion is information, not decoration.
4. **Calm at rest, alive on events.** Ambient motion (wire shimmer, health ring) stays ≤ 4%
   intensity. Only real events (a payment, a channel opening) draw the eye.
5. **GUI ⇄ CLI transparency.** Every GUI action names its `forge …` command. The two share one
   visual language (§11). Anything you can click, you can script.

**Grounded in the real data model.** `NetworkView { nodes[{name, container, rpcHostPort, pubkey,
status}], channels[{from, to, capacityCkb, state}] }`; the RPC surface (`nodeInfo`, `connectPeer`,
`openChannel`, `listChannels`, `shutdownChannel`, `newInvoice`, `sendPayment`, `getPayment`);
presets (`duo/trio/hub`, `line:N/ring:N/star:N`); node names drawn from the fun pool (philosophers,
scientists, historical figures); channel states (`ChannelReady`, negotiating/pending, `unknown`).

---

## 2. Information architecture

The screen is **z-layers**, not columns.

- **Layer 0 — The Canvas** (fills the viewport): an infinite, pannable, zoomable world holding the
  network graph. 100% of the background.
- **Layer 1 — Floating chrome** (glass panels docked to edges, `backdrop-blur(16px)` over the
  canvas):
  - **Top-left — Network HUD**: a pill with the network name, node/channel counts, and a health
    dot. Click → the network switcher + "Forge a network" wizard.
  - **Top-center — Vitals strip** (from the Observatory direction): 6 live monospace chips, each
    with a 2px colored left border — `nodes ●`, `channels`, `capacity (CKB)`, `on-chain (CKB)`,
    `block #`, `payments/min`. Update within the 2-second reactivity budget.
  - **Top-center — Mode dock** (tldraw-style, keys `1–5`): **Select/Move (V)**, **Wire (W)**,
    **Pay (P)**, **Fund (F)**, **Comment (C)**.
  - **Top-right — Command bar**: `⌘K` command palette, `⚒ Spawn` (new network), `⚡ Pay`.
  - **Bottom-left — Mini-map**: a miniature of the whole graph with a viewport rectangle; drag to
    fly.
  - **Bottom-center — Zoom + layout dock**: zoom %, fit-to-screen (`⌘0`), 100% (`⌘1`), and a
    layout switch (radial / force / hierarchical) that tweens node positions.
  - **Bottom — The DECK** (collapsible): Logs · Timeline · Payments · RPC console · Terminal.
    Collapsed = a 28px strip showing the last event + a throughput sparkline.
- **Layer 2 — Inspector drawer** (right, ~380px): swaps between node / channel / payment inspector
  by selection. Slides over the canvas; canvas dims 8% and stays interactive behind it.
- **Optional — Explorer** (left, 264px, from the Workbench direction): a collapsible tree
  `Network › Nodes › (peers, channels)` with per-row status glyphs and a filter bar. **Linked
  views:** selecting in the Explorer highlights on the graph and vice-versa. Off by default for
  the calm canvas; toggled for power users.

---

## 3. The network graph — the centerpiece

### 3.1 Nodes — tactile cards, not circles

Each node is a rounded-rect **card** (~180×92 at 100% zoom) carrying live state at a glance:

```
┌──────────────────────────────┐
│ ● feynman          :8300  ⣿⣿ │   ● health: running = mint ring sweep, exited = slate, unhealthy = amber
│ 0x03f2…9ac1                  │   truncated pubkey (mono), click to copy
│ ┌──────────────────────────┐ │
│ │ on-chain   9,842 CKB     │ │   funded balance (animated roll)
│ │ ▓▓▓▓▓▓░░  channels ×3     │ │   local channel-capacity bar
│ └──────────────────────────┘ │
└──────────────────────────────┘
     ◟ 4 rim wire-ports (N/E/S/W) glow in Wire mode
```

- **Level-of-detail:** < 40% zoom → a labeled dot with a health halo; mid-zoom → header only;
  full-zoom → balances + bars. Keeps a 10-node `hub` legible.
- **Identity color** (from the Workbench direction): a deterministic hash of the pubkey picks a
  stable gradient pair (e.g. `#4AD6C4→#8B7BFF`, `#3EE8A0→#4AD6C4`, `#F4C752→#FF5CC8`) so a node's
  accent is the same forever — recognizable across sessions.
- **Health ring:** 2px. Running = slow mint gradient sweep (4s). Unhealthy = amber. Exited = static
  slate, card desaturated to 60%. Delivers the "node unhealthy within 2s" requirement viscerally.
- **Selected:** teal focus ring + 6px lift; scales to 1.03 with a spring. **Dragging:** shadow
  deepens, card tilts 1–2° toward velocity, connected wires rubber-band and re-tauten.
- **Hub emphasis:** high-degree nodes (`hub`/`star` center) render larger with a faint radial glow
  — topology reads instantly.

### 3.2 Channels — living wires

A channel is a **bézier wire** between two rims that encodes four things at once:

- **State → color + texture:** `ChannelReady` → solid **mint** with a slow directional shimmer;
  negotiating/pending → **amber**, dashed march (`stroke-dashoffset` loop); `unknown`/unreachable →
  **slate**, 40% opacity, static.
- **Capacity → thickness:** stroke width maps to `capacityCkb` (log-scaled, 2–8px).
- **Balance split → a bead on the wire:** a small **balance bead** rides the wire at the
  `local/capacity` position. A bead 30% from `feynman` means that side holds 30%. Hover → it
  expands into an inline `local ⇄ remote` mini-bar with numbers. This one touch makes network-wide
  liquidity legible at a glance — the single most information-dense element in the app.
- **Ambient flow:** on ready channels, faint particles drift toward the higher-inbound side, so the
  graph looks like it carries energy.
- **Hover:** wire thickens 1.5×, lifts, shows `feynman ⇄ lorentz · 1,000 CKB · 60/40`. **Click:**
  channel inspector.

### 3.3 Payments — pulses traveling the graph (the money shot)

When a payment fires (`sendPayment` → poll `getPayment`):

1. The route highlights: participating wires brighten to **teal**, everything else dims to 25%
   (spotlight the path). On a `line` network `feynman → …` lights up every hop.
2. A **luminous pulse** (bright teal orb, comet trail, soft bloom) launches from the sender,
   travels wire 1, lands at each relay (which ripples as it forwards), and continues to the
   receiver.
3. On `Success`: the receiver emits a mint **success ripple**, the pulse bursts into particles, and
   the **balance beads on every hop slide** to their new split with a spring — you watch liquidity
   shift across the multi-hop route in real time. A `+250 CKB` chip floats up.
4. On failure: the pulse turns **red**, halts at the failing hop, shakes, dissolves; that wire
   flashes red; a toast names the failing node. The red pulse lingers ~1.5s so the failure point is
   seen.

Tuned so a 2-hop payment reads in ~1.4s. Concurrent payments = concurrent pulses (great for a
traffic generator).

### 3.4 Canvas mechanics

Infinite pan (space-drag / middle-mouse), scroll-zoom toward cursor, pinch-zoom, `⌘0` fit, `⌘1`
100%. Auto-layout with animated transitions between **radial** (default; matches the current SVG
ring), **force-directed** (custom topologies), and **hierarchical/dagre** (`line` chains). Manual
positions are sticky and persisted per network. Dotted-grid background, faint edge vignette.

---

## 4. Node inspector (right drawer, ~380px)

Tabbed: **Overview · Peers · Channels · Logs · Console**.

```
┌─ feynman ──────────────────────── ✕ ─┐
│ ● Running   forge-trio-node-0         │
│ 0x03f2c9…9ac1              [copy] [⧉] │  ⧉ = "point your app here" → copies RPC URL
│  Overview  Peers  Channels  Logs  ›_  │
│ ───────────────────────────────────  │
│  BALANCE                              │
│   On-chain      9,842.0 CKB           │
│   In channels   1,830.0 CKB  (3)      │
│   ◕ capacity donut · 60s sparkline    │
│  ENDPOINT                             │
│   RPC   http://127.0.0.1:8300  [copy] │
│   P2P   /ip4/…/tcp/8228/p2p/Qm…       │
│  QUICK ACTIONS                        │
│   [ Fund + ]  [ Open channel → ]      │
│   [ Create invoice ]  [ Pay from ]    │
└───────────────────────────────────────┘
```

- **Overview:** balance breakdown (on-chain vs in-channel), a capacity donut, a per-node
  **throughput sparkline** (payments routed over the last 60s, from the Observatory direction), and
  the endpoint block with copy-to-clipboard — the "point your app at a forge node" story.
- **Peers:** `listPeers` as pubkey chips with connection dots; click pans to that node.
- **Channels:** this node's channels with mini balance bars; row click selects the wire.
- **Logs:** streamed `docker logs` with level filter chips (`info/warn/error/debug`), search,
  autoscroll toggle, level-colored gutter.
- **Console:** a raw RPC console — pick a method (`node_info`, `list_channels`, …), fill params,
  send, see pretty JSON. Turns the GUI into a learning + debugging tool; mutating methods badged.

---

## 5. Channel inspector (right drawer)

```
┌─ Channel ──────────────────────── ✕ ─┐
│  feynman  ⇄  lorentz   ● ChannelReady │
│  0x9c1a…be40                   [copy] │
│  CAPACITY            1,000 CKB        │
│   feynman ◀━━━━━━━━━●━━━━━▶ lorentz   │  balance split bar with a bead
│          600 CKB    │    400 CKB      │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░           │
│  STATE   Negotiating → Ready ✓        │  state-machine breadcrumb (current step lit)
│  Funding 0x4f…  ·  opened 12s ago     │
│  [ Send payment across → ]            │
│  [ ⚠ Close channel ]                  │
└───────────────────────────────────────┘
```

- **Balance split is the hero:** a large bar with a bead at the split, animated whenever balances
  change (post-payment).
- **State-machine breadcrumb:** `Negotiating → FundingReady → ChannelReady` with the current step
  lit — makes amber "pending" wires legible while opening.
- **Close** (`shutdownChannel`): inline confirm ("Close feynman ⇄ lorentz? Funds settle
  on-chain."). On confirm the wire drains mint → slate, the split collapses to the settling side,
  and the wire retracts into both nodes with a soft snap; a settlement event lands in the timeline.

---

## 6. Core flows

### 6.1 Create-network wizard (`forge up`, over the daemon)
A right-anchored 3-step slide-over (glass, graph visible behind): **Topology → Funding → Review &
forge**. Preset cards render an **animated topology glyph** of the actual shape; `line/ring/star`
reveal an **N stepper** (bounded `MIN_NODES..MAX_NODES`) with a live-updating preview graph
mirroring `presets.ts`. "Build custom" opens a visual node-editor (or a Monaco YAML editor) with
inline `topology.ts` validation errors (unknown ref, capacity below reserve, dup names). **Forge it
→ the boot sequence _is_ the loading state** (§9).

### 6.2 Fund a node (Fund mode / quick action)
A compact sheet: amount stepper (1k / 10k / 100k CKB), source = devnet treasury. Confirm → the node
card plays a coin-drop, the on-chain counter rolls up, a `+10,000 CKB` chip floats off, the timeline
logs `funded feynman 10,000 CKB`.

### 6.3 Open a channel (drag between nodes) — the signature interaction
In **Wire mode** (or dragging from a rim port anytime): grab a rim → a wire rubber-bands from the
cursor (amber dashed, "live"); valid targets glow mint, invalid (self / already-channeled /
unreachable) dim; release → a **capacity popover** (`Capacity ◀━●━ 1,000 CKB`, `public ✓`,
`[Open]`). Confirm → `connectPeer → openChannel → poll listChannels`; the wire renders amber/dashed
with the state stepper floating on it, then **snaps to solid mint** on `ChannelReady` with a scale
bounce. Maps 1:1 to `forge channel open`.

### 6.4 Create / pay an invoice
**Create:** node inspector → amount + description → `newInvoice` → a copyable `invoice_address` pill
+ QR, and a playful claimable "invoice token" dropped on the canvas near the receiver. **Pay sheet
(Pay mode):** click sender → click receiver →

```
┌─ Send payment ─────────────────────┐
│  From feynman     To  pericles      │
│  Amount  [ 250 CKB ]                │
│  Route   feynman → lorentz → pericles (2 hop)   ← previewed, hops highlight on canvas
│           [ Cancel ]  [ Send ⚡ ]    │
└─────────────────────────────────────┘
```

On send: invoice auto-created on the receiver, `sendPayment` from the sender, poll `getPayment`;
the route animates (§3.3). Maps to `forge pay`.

### 6.5 Close a channel / tear down
Channel inspector → Close (§5). Network teardown from the HUD → confirm → `forge down` (with
`--keep` / `--purge` options surfaced as "keep data" / "wipe everything" toggles).

---

## 7. Live logs + event timeline (the DECK)

- **Event timeline (semantic):** a stream of typed, iconographic events — `network forged`,
  `funded feynman 10,000 CKB`, `channel feynman⇄lorentz → ChannelReady`, `payment feynman→pericles
  Success (250 CKB)`, `channel closed`. Each is clickable → flies the canvas to the involved
  elements (replay feel). Color-coded: fund = gold, channel = mint, payment = teal, error = red.
- **Payments ledger:** time, from→to, amount, hop count, status, latency; row click replays the
  animation.
- **Raw logs:** tabbed by node, level filter chips, search, follow/pause (`docker logs`).
- **Terminal:** shows the equivalent `forge …` command for whatever you just did — GUI→CLI
  transparency.

The semantic timeline derives from the orchestrator's `onProgress` messages + RPC state diffs; raw
logs stream from `engine.logs`. Collapsed = a single-line ticker.

---

## 8. Visual system

Dark-first, cool near-black surfaces with electric accents. **This palette is a superset of the
CLI's** (§11) so the two tools read as one product; the CLI uses the truecolor subset marked ★.

### 8.1 Color palette

| Token | Hex | Role |
|---|---|---|
| `--bg-void` | `#070A0F` | canvas backdrop (deepest) |
| `--bg-grid` | `#0E141C` | grid dots (low opacity) |
| `--surface-1` | `#111823` | floating glass panels |
| `--surface-2` | `#172130` | node cards, raised surfaces |
| `--surface-3` | `#1E2A3C` | hover / inputs |
| `--line` | `#24324A` | hairlines, borders |
| `--text-hi` | `#EAF1F8` | headings, the one bright thing per block ★ `heading #EAEDF2` |
| `--text` | `#C4D0DE` | body / values ★ `text #C3C9D3` |
| `--text-mute` | `#7E8DA1` | keys, labels, units ★ `muted #8A93A3` |
| `--text-faint` | `#4C596B` | rules, connectors, timestamps ★ `dim #5A6273` |
| `--accent` ★ | `#4AD6C4` | brand, selection, active spinner, ports, primary numbers |
| `--accent-pulse` | `#38E1FF` | payment pulses, live-motion sibling of accent |
| `--mint` ★ | `#5FD98A` | `ChannelReady`, healthy, success (`success`) |
| `--mint-glow` | `#6FFFC4` | success ripple bloom |
| `--amber` ★ | `#E3B341` | pending / negotiating, warnings (`pending`) |
| `--gold` | `#F4C752` | funding / on-chain CKB |
| `--red` ★ | `#F2737A` | errors, failed payments, destructive (`error`) |
| `--violet` | `#A88BFF` | routes / invoices, secondary highlight |

Gradients: payment pulse `radial(#EAFBFF → #38E1FF → transparent)`; ready-wire shimmer
`linear(#2FBF86 → #5FD98A → #6FFFC4)`; health ring `conic(mint → accent)` slow rotate; node card
fill `top-lit(#172130 → #111823)`.

### 8.2 Typography
- **UI:** Inter / Geist (variable), `-0.01em` tracking on headings.
- **Numbers/balances:** tabular figures (`font-feature-settings: "tnum"`) everywhere numbers change
  — non-negotiable so live counters don't jitter.
- **Mono (pubkeys, logs, console, ports):** Geist Mono / JetBrains Mono.
- **Display (HUD name, wizard titles):** Geist heavy, tight tracking.
- Scale (px): `11 · 12 · 13 · 14(base) · 16 · 20 · 26 · 34`. Line-height 1.5 body, 1.15 display.

### 8.3 Spacing & radii
4-based scale: `2 · 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`. Panels: 16 padding, 12 gaps; node card
internal 8/12. Radii: `6` inputs, `10` cards, `14` panels, `full` pills.

### 8.4 Elevation
Cool-tinted (never pure black), with a subtle inner top-highlight for glass:
- `--e1` panels: `0 1px 0 rgba(255,255,255,.03) inset, 0 8px 24px -12px rgba(0,0,0,.6)`
- `--e2` node cards: `0 2px 4px -1px rgba(0,0,0,.5), 0 12px 32px -12px rgba(0,0,0,.7)`
- `--e3` drawer/modal: `0 24px 64px -20px rgba(0,0,0,.8)`
- **Glow** for live elements: selected node `0 0 0 2px var(--accent), 0 0 32px -6px rgba(74,214,196,.5)`.
- Floating panels: `backdrop-filter: blur(16px)`, `--surface-1` at 82% opacity.

### 8.5 Iconography
Lucide (1.5px stroke, rounded caps) + a small Fiber-specific set: node (hexagon chip), channel
(two-headed link), payment (lightning-drop), fund (coin-stack), forge (anvil ⚒). Health = filled
dot in semantic colors. 16/20px, `--text-mute` default, brighten on hover.

### 8.6 Motion
- **Springs, not linear.** UI `spring(stiffness 320, damping 30)`; canvas nodes softer
  `spring(220, 26)` (weighty, physical).
- Drawer slide-in 240ms; node select scale 1→1.03 (180ms); balance number rolls 600ms ease-out;
  wire pending→ready 400ms color morph + one 1.15 "thump"; payment pulse ~700ms/hop with an
  afterimage trail; layout re-flow staggered 30ms.
- Ambient animations ≤ 4% intensity. **Respect `prefers-reduced-motion`:** pulses become a single
  fade-move, shimmers freeze, ripples become opacity flashes.

---

## 9. Empty / loading / error states

- **Empty:** a large centered dotted **anvil silhouette**, "No network forged yet.", a primary
  `Forge a network ⚒` button. Faint ghost-nodes drift behind. Inviting, not dead.
- **Loading = the boot sequence (the best loading state you'll see):** the wizard's "Forge it"
  transitions _into the canvas_. Nodes **materialize one by one** as the orchestrator boots them;
  the CKB dev chain is an **anvil-core** at center pulsing while mining; channels draw themselves
  amber/dashed and march toward mint; a slim top rail mirrors `onProgress` verbatim (`funding
  feynman 10,000 CKB`, `channel feynman→lorentz ready`). The user watches the network **forge
  itself** — loading state and wow-moment in one. Needs a WS push of orchestrator progress
  (upgrade from the 2s poll).
- **Skeleton:** node cards shimmer for balances until `listChannels` returns; wires render slate
  until state is known.
- **Daemon disconnected:** HUD dot → red, non-blocking "Lost connection — retrying…" banner, canvas
  dims 30% and freezes ambient motion but stays readable (last-known state); auto-reconnect with
  backoff, green flash on return.
- **Node unhealthy:** within 2s the health ring flips amber/red, the card desaturates, its wires dim
  to slate, a timeline error lands, and the open inspector surfaces the last log lines.
- **Action failed** (open/pay/close): inline in the sheet + a red toast naming the failing
  node/hop; never a raw stack.

---

## 10. Responsive & layout behavior

- **≥ 1280px:** full experience — canvas + all floating chrome + optional Explorer + inspector
  drawer.
- **768–1280px:** Explorer collapses to icons; inspector becomes an overlay sheet; vitals strip
  wraps to 3+3.
- **< 768px (view-only):** canvas + HUD + a bottom sheet for inspectors; drag-to-open disabled,
  actions via buttons. The GUI is a companion to the CLI, not a phone-first app.
- Panels never exceed the viewport; the canvas always retains ≥ 50% width on desktop.

---

## 11. CLI alignment (already implemented in `src/ui.ts`)

The CLI mirrors the GUI's visual language in the terminal: one teal accent, state carried by glyph
color, generous space. The palette is the truecolor subset marked ★ in §8.1.

| GUI token | Terminal (truecolor) | Glyph vocabulary |
|---|---|---|
| `--accent` | `#4AD6C4` | ports, primary numbers, active spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` |
| `--mint` | `#5FD98A` | `●` ready/running, `✔` done |
| `--amber` | `#E3B341` | `◍` pending/negotiating |
| `--red` | `#F2737A` | `✗` failed / unreachable |
| `--text-mute` | `#8A93A3` | keys, `→` direction, `·` separators |
| `--text-faint` | `#5A6273` | rules `─`, tree `├─ └─ │`, box borders `╭ ╮ ╰ ╯` |

Rounded boxes are the reward at the end of a command; tables and trees carry lists; progress is an
in-place multi-step checklist with a braille spinner on the active step (stderr), and `--json`
bypasses all of it for scripting.

`forge up trio` — live progress → summary card:
```
  fiber-forge  ·  spinning up trio

  ✔ network              0.3s
  ✔ ckb                  2.1s
  ✔ nodes    3/3         4.8s
  ✔ fund     3/3         3.2s
  ✔ connect              1.1s
  ✔ channels 2/2         6.0s
  ✔ ready

  ╭─ trio ─────────────────────────────────────────── ready ─╮
  │ network   forge-trio                                      │
  │ ckb rpc   http://127.0.0.1:8114                           │
  │                                                           │
  │ nodes                                                     │
  │ ● feynman   http://127.0.0.1:8300                         │
  │ ● lorentz   http://127.0.0.1:8301                         │
  │ ● galileo   http://127.0.0.1:8302                         │
  │                                                           │
  │ channels                                                  │
  │ feynman → lorentz   ● ChannelReady   1000 CKB             │
  │ lorentz → galileo   ● ChannelReady   1000 CKB             │
  ╰───────────────────────────────────────────────────────────╯

  next   forge status trio  ·  forge pay trio feynman galileo 42  ·  forge gui trio
```

`forge status trio` — nodes + channels tree · `forge ls` — networks table · `forge pay a b 42` —
a settle spinner then a `paid 42 CKB · Success` card. Every GUI action shows its equivalent command
in the DECK's Terminal tab, closing the loop.

---

## 12. Tech stack & component inventory

**Core:** React 18 + TypeScript + Vite (ESM, matching the repo). The daemon serves the built bundle
in place of today's single `gui.html`; a single-file build (`vite-plugin-singlefile`) keeps "the
daemon serves one artifact" simple.

**Graph/canvas:** **React Flow (`@xyflow/react`)** — infinite pan/zoom, draggable nodes, custom
node/edge React components (node cards + living wires are components), and connection-drag
(`onConnect` → open-channel) for free, plus a mini-map and controls. `d3-force` for force layout,
`dagre`/`elkjs` for hierarchical, a hand-rolled radial function for the default. A **custom
SVG/Canvas overlay** synced to the viewport transform renders payment pulses and wire shimmer along
the same bézier paths (drop to PixiJS/regl only if a traffic generator stresses it).

**Animation:** Framer Motion (springs, `AnimatePresence`, number rolls). **Styling:** Tailwind +
shadcn/ui (Radix) for drawers, dialogs, popovers, palette, toasts, tabs, tooltips; `cmdk` for `⌘K`;
`lucide-react` for icons. **State/data:** Zustand (selection, mode, node positions), TanStack Query
for daemon fetches. **Upgrade the daemon** from `GET /api/state` polling to a **WebSocket** pushing
`NetworkView` diffs + orchestrator progress — this powers < 2s reactivity, the live-forge loading
state, and payment/close animations. Keep `/api/state` as a fallback.

**Component inventory:** `Canvas`, `NodeCard`, `ChannelWire`, `PaymentPulseLayer`, `NetworkHUD`,
`VitalsStrip`, `ModeDock`, `CommandBar`, `MiniMap`, `LayoutDock`, `InspectorDrawer`
(`NodeInspector` / `ChannelInspector` / `PaymentInspector`), `ExplorerTree`, `Deck`
(`LogsPanel` / `Timeline` / `PaymentsLedger` / `RpcConsole` / `Terminal`), `WizardSlideOver`,
`FundSheet`, `PaySheet`, `CapacityPopover`, `Toast`, `EmptyState`, `BootSequence`.

---

## Appendix — reference wireframes

### A. Canvas at rest (trio, nothing selected)
```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ╭─────────────────────────╮      nodes● 3  ch 2  cap 2k  #47      ╭─────────╮   │
│ │ ⬡ trio · ● healthy      │         ⌘K search                     │⚒ ⚡ Pay  │   │
│ ╰─────────────────────────╯   ┌─[ V ][ W ][ P ][ F ][ C ]─┐       ╰─────────╯   │
│              ┌──────────────┐                                                   │
│              │● feynman :8300│═════════(mint, 60●40)═════════╗                  │
│              │ 9,842 CKB ▓▓░ │                              ┌──────────────┐    │
│              └──────────────┘                               │● lorentz:8301│    │
│                                                             └──────┬───────┘    │
│                                                    ════(mint,40●60)════╗        │
│                                                                   ┌──────────────┐
│                                                                   │● galileo:8302│
│ ╭ ▖mini ╮          ╭ radial 100% ⊹ ⤢ ╮      ╭ ⚡ payment …→galileo ✓ ╮        │
└───────────────────────────────────────────────────────────────────────────────┘
```

### B. Node selected → inspector + payment pulse mid-flight
```
┌───────────────────────────────────────────────────────┬─────────────────────┐
│ ⬡ trio      [ V ][ W ][ P ][ F ][ C ]                 │ feynman         ✕   │
│      ┌──────────────┐                                  │ ● Running  node-0   │
│      │◎ feynman     │  ← selected (teal ring)          │ 0x03f2…9ac1 [copy]  │
│      └──────┬───────┘                                  │ Overview Peers Chan │
│             ●→→→ ✦ pulse (teal comet)                  │ BALANCE 9,842 CKB   │
│        ┌──────────────┐                                │ Channels 1,830 (3)  │
│        │◉ lorentz     │ ← ripples, forwarding          │ ENDPOINT :8300 [⧉]  │
│        └──────┬───────┘                                │ [Fund+][Open ch →]  │
│          ✦→→→● ═══┐                                    │ [Invoice][Pay from] │
│              ┌──────────────┐                          │                     │
│              │○ galileo     │ (dimmed, awaiting)       │                     │
│  ╭ ⚡ paying feynman→galileo 250 CKB … ╮               │                     │
└───────────────────────────────────────────────────────┴─────────────────────┘
```

### C. Live forge (loading = the network building itself)
```
┌───────────────────────────────────────────────────────────────────────────────┐
│                          ⚒  Forging  trio  ⚒                                   │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░  funding lorentz 10,000 CKB                     │
│                              ◍ anvil-core (CKB) · block #47                     │
│         ┌──────────────┐                                                        │
│         │● feynman ✓   │┄┄┄┄amber dashed┄┄┄┄┐ connecting peer                   │
│         └──────────────┘              ┌──────────────┐                          │
│                                       │◌ lorentz …   │  ← springing in          │
│                                       └──────────────┘   ⋯ galileo queued       │
│  rail →  ● network  ● ckb ready  ● feynman rpc  ◐ funding…  ○ open feynman→…    │
│                                                      [ Run in background ]      │
└───────────────────────────────────────────────────────────────────────────────┘
```
