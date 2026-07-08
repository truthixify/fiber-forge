/**
 * Terminal aesthetic for the CLI: a calm, truecolor, dark-terminal look — one teal accent, state
 * carried by glyph color, generous space. Formatters return strings (the CLI prints results to
 * stdout); {@link Progress} owns its own in-place animation on stderr and degrades to plain lines
 * when stderr is not a TTY. Machine output (`--json`) bypasses all of this.
 */

import pc from "picocolors";
import { createLogUpdate } from "log-update";

const colorOn = pc.isColorSupported && !process.env.NO_COLOR;
const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function paint(
  hex: string,
  fallback: (s: string) => string,
): (s: string) => string {
  if (!colorOn) {
    return (s) => s;
  }
  if (!truecolor) {
    return fallback;
  }
  const [r, g, b] = hexRgb(hex);
  return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

// A forge palette: warm ember for energy/focal, cool flux for ready/structure, gold for CKB.
export const ember = paint("#FF6A3D", pc.red);
export const accent = ember;
export const flux = paint("#2DE0C7", pc.cyan);
export const success = flux;
export const gold = paint("#F5C451", pc.yellow);
export const pending = paint("#F0A93C", pc.yellow);
export const error = paint("#FF5765", pc.red);
export const heading = paint("#F3EFE7", pc.white);
export const text = paint("#C6CFDB", (s) => s);
export const muted = paint("#808B9C", pc.gray);
export const dim = paint("#4C5768", (s) => pc.dim(pc.gray(s)));

/** Uppercase a label for the mono-caps instrument feel. */
export function caps(s: string): string {
  return s.toUpperCase();
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const WIDTH = Math.min(process.stdout.columns || 80, 78);

/** First-6…last-4 of a long hash/key/address. */
export function shortHash(value: string): string {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  return body.length <= 12 ? value : `${body.slice(0, 6)}…${body.slice(-4)}`;
}

/** Glyph + color for a container status. */
export function nodeGlyph(status: string): string {
  if (status === "running") return success("●");
  if (status === "exited" || status === "stopped") return dim("○");
  return error("✗");
}

/** Glyph + color for a channel state name. */
export function channelGlyph(state: string): string {
  if (state === "ChannelReady") return success("●");
  if (state === "unknown") return error("✗");
  if (/CLOSED|SHUTDOWN/i.test(state)) return dim("○");
  return pending("◍");
}

/** A bright mono-caps heading followed by a hairline rule. */
export function heading2(title: string): string {
  return `\n  ${heading(caps(title))}\n  ${dim("─".repeat(WIDTH - 2))}`;
}

/** Aligned `key value` rows; keys muted, right-padded to a common width. */
export function keyValue(rows: [string, string][], indent = "  "): string {
  const keyWidth = Math.max(...rows.map(([k]) => k.length));
  return rows
    .map(([k, v]) => `${indent}${muted(k.padEnd(keyWidth))}   ${v}`)
    .join("\n");
}

/** A squared readout card with an inline mono-caps title and a right-aligned tag in the top rule. */
export function box(
  title: string,
  tag: string,
  tagPaint: (s: string) => string,
  lines: string[],
  titlePaint: (s: string) => string = heading,
): string {
  const inner = WIDTH - 2;
  const titleCaps = caps(title);
  const tagCaps = caps(tag);
  const head = title ? ` ${titlePaint(titleCaps)} ` : " ";
  const tagged = tag ? ` ${tagPaint(tagCaps)} ` : "";
  const headPlain = title ? ` ${titleCaps} ` : " ";
  const tagPlain = tag ? ` ${tagCaps} ` : "";
  const fillLen = inner - 1 - headPlain.length - tagPlain.length - 1;
  const top = `  ${dim("┌─")}${head}${dim("─".repeat(Math.max(1, fillLen)))}${tagged}${dim("─┐")}`;
  const bottom = `  ${dim("└" + "─".repeat(inner) + "┘")}`;
  const body = lines.map((line) => {
    const visibleLen = stripAnsi(line).length;
    const pad = Math.max(0, inner - 1 - visibleLen);
    return `  ${dim("│")} ${line}${" ".repeat(pad)}${dim("│")}`;
  });
  return [top, ...body, bottom].join("\n");
}

/** A squared alarm readout for a CLI error: an ERROR title, the message, and an optional next step. */
export function errorBox(message: string, suggestion?: string): string {
  const lines = [error(message)];
  if (suggestion) {
    lines.push(dim("─".repeat(Math.max(1, WIDTH - 6))));
    lines.push(`${muted("try")}   ${text(suggestion)}`);
  }
  return box("error", "", error, lines, error);
}

/** Space-aligned table with a muted header row and a dim rule. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(
      stripAnsi(h).length,
      ...rows.map((r) => stripAnsi(r[i] ?? "").length),
    ),
  );
  const pad = (cell: string, i: number) =>
    cell + " ".repeat(Math.max(0, widths[i] - stripAnsi(cell).length));
  const headerLine = `  ${muted(headers.map((h, i) => pad(h, i)).join("   "))}`;
  const rule = `  ${dim("─".repeat(WIDTH - 2))}`;
  const body = rows.map((r) => `  ${r.map((c, i) => pad(c, i)).join("   ")}`);
  return [headerLine, rule, ...body].join("\n");
}

/** A dim ` · `-joined hint line, e.g. suggested next commands. */
export function hint(label: string, items: string[]): string {
  return `\n  ${muted(label)}   ${items.map((i) => text(i)).join(dim("  ·  "))}`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const uiOn = colorOn && Boolean(process.stderr.isTTY);

export interface Step {
  key: string;
  label: string;
}

interface StepState {
  state: "idle" | "active" | "done" | "fail";
  detail?: string;
  count?: string;
  startedAt?: number;
  elapsed?: number;
}

/** An in-place multi-step checklist with a braille spinner on the active step (stderr). */
export class Progress {
  private readonly states = new Map<string, StepState>();
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly render = createLogUpdate(process.stderr);
  private readonly printed = new Set<string>();

  constructor(
    private readonly title: string,
    private readonly steps: Step[],
  ) {
    for (const step of steps) {
      this.states.set(step.key, { state: "idle" });
    }
    if (uiOn) {
      process.stderr.write(
        `\n  ${accent("fiber-forge")}  ${dim("·")}  ${muted(title)}\n\n`,
      );
      this.timer = setInterval(() => this.draw(), 80);
    }
  }

  /** Activate `key`, marking every earlier step done. */
  enter(key: string, detail?: string): void {
    let reached = false;
    for (const step of this.steps) {
      const state = this.states.get(step.key)!;
      if (step.key === key) {
        reached = true;
        if (state.state !== "active") {
          state.state = "active";
          state.startedAt = Date.now();
        }
        if (detail) state.detail = detail;
      } else if (!reached && state.state !== "done") {
        this.complete(state);
      }
    }
    this.draw();
  }

  detail(key: string, text: string): void {
    const state = this.states.get(key);
    if (state) state.detail = text;
    this.draw();
  }

  count(key: string, done: number, total: number): void {
    const state = this.states.get(key);
    if (state) state.count = `${done}/${total}`;
    this.draw();
  }

  finish(): void {
    for (const step of this.steps) {
      const state = this.states.get(step.key)!;
      if (state.state === "active") this.complete(state);
    }
    this.stop();
  }

  fail(key: string, message: string): void {
    const state = this.states.get(key);
    if (state) {
      state.state = "fail";
      state.detail = message;
    }
    this.stop();
  }

  /** Mark whichever step is currently active as failed. */
  failActive(message: string): void {
    const active = this.steps.find(
      (s) => this.states.get(s.key)!.state === "active",
    );
    this.fail(active ? active.key : this.steps[0].key, message);
  }

  private complete(state: StepState): void {
    state.state = "done";
    if (state.startedAt && state.elapsed === undefined) {
      state.elapsed = Date.now() - state.startedAt;
    }
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.draw();
    if (uiOn) this.render.done();
  }

  private draw(): void {
    if (!uiOn) {
      this.drawPlain();
      return;
    }
    this.frame = (this.frame + 1) % SPINNER.length;
    const lines = this.steps.map((step) => {
      const state = this.states.get(step.key)!;
      const glyph =
        state.state === "done"
          ? success("✔")
          : state.state === "fail"
            ? error("✗")
            : state.state === "active"
              ? accent(SPINNER[this.frame])
              : dim("○");
      const label = (state.state === "idle" ? dim : text)(step.label.padEnd(9));
      const counter = state.count ? muted(state.count.padEnd(5)) : "     ";
      const right =
        state.state === "done" && state.elapsed !== undefined
          ? dim(`${(state.elapsed / 1000).toFixed(1)}s`)
          : state.state === "active" && state.detail
            ? muted(state.detail)
            : state.state === "fail" && state.detail
              ? error(state.detail)
              : "";
      return `  ${glyph} ${label} ${counter} ${right}`.trimEnd();
    });
    this.render(lines.join("\n"));
  }

  private drawPlain(): void {
    for (const step of this.steps) {
      const state = this.states.get(step.key)!;
      const id = `${step.key}:${state.state}`;
      if (state.state !== "idle" && !this.printed.has(id)) {
        this.printed.add(id);
        const mark =
          state.state === "fail" ? "✗" : state.state === "done" ? "✔" : "›";
        process.stderr.write(
          `  ${mark} ${step.label}${state.detail ? " " + state.detail : ""}\n`,
        );
      }
    }
  }
}
