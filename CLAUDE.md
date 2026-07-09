# CLAUDE.md — working agreement

**Before writing any code, read `docs/spec.md` in full — it is the source of truth.**
`README.md` states what this project is. Stack: **TypeScript / Node** (ESM).

## Working agreement (non-negotiable)
- **The spec governs.** If a requirement is ambiguous, underspecified, or contradictory, stop and
  re-read `docs/`. If the docs still do not answer it, surface the question — never guess or invent
  behavior.
- **Nothing half-done ships.** No `TODO`/`FIXME` markers, no `throw new Error("not implemented")`
  stubs, no placeholder returns, no commented-out "later" code, no dead scaffolding. A unit of work
  is complete and tested, or it is not started.
- **No numbered-step comments.** Never write comments like `// Step 1`, `// 1.`, or `// then …`.
  A comment states a non-obvious *why* — a protocol constraint, a safety invariant — never *what*
  the next line does.
- **Comments are rare and load-bearing.** Prefer precise names and small functions over narration.
- **Commit often, in small imperative steps** (`add order state machine`, `wire settlement
  watcher`). Push a coherent unit of work once it is done and `make ci` is green.
- **No co-author trailers.** Commit messages carry no `Co-Authored-By:` line and no attribution
  footer.
- **CI is the gate.** `.github/workflows/ci.yml` runs `make ci` on every push and pull request.
  Keep it green; never merge red.
- **Docs stay in sync.** When behavior changes, update `docs/`. Add new design docs under `docs/`
  as the system grows.
- **Self-contained.** This repo references no sibling project and no planning folder; everything it
  needs lives here.

## Commands — always via `make`
| target | does |
|--------|------|
| `make setup` | `npm ci` |
| `make build` | `npm run build` (tsc) |
| `make test`  | `npm test` (vitest) |
| `make lint`  | typecheck — `tsc --noEmit` |
| `make fmt`   | `prettier --write .` |
| `make ci`    | fmt-check + lint + test + build (what CI runs) |

Run `make ci` before every push.

## Coding standards
- TypeScript strict mode, ESM, Node 20+. Format with Prettier (defaults). `tsc --noEmit` must pass
  clean.
- Prefer explicit types at module boundaries; avoid `any` (justify any exception in a comment).
- Errors are typed and never silently swallowed; async code always handles the rejection path.
- Any component that talks to a Fiber node takes the RPC transport as an injectable interface so
  the logic layer is testable against a mock — no live node in unit tests.
- Exported items carry doc comments describing the contract, not the implementation.
- One responsibility per module; keep modules cohesive and small.

## Layout
- `docs/` — specification & design (authoritative)
- `src/` — source
- `Makefile` — task runner · `.github/workflows/ci.yml` — CI
