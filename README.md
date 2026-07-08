# fiber-forge

> One-click local Fiber networks: spin up a CKB devnet and N Fiber nodes, and open channels from a visual GUI — a working payment-channel playground in under a minute.

[![CI](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/truthixify/fiber-forge/actions/workflows/ci.yml)

Built for the **"Gone in 60ms" Fiber Network Infrastructure Hackathon** — Category 2.

## Status

Scaffold: the specification in [`docs/spec.md`](docs/spec.md) is complete and implementation is
underway. This repository is self-contained and CI is green from the first commit.

## Quickstart

All tasks run through `make`:

```sh
make setup   # install toolchain / dependencies
make build
make test
make ci      # fmt-check + lint + test + build (exactly what CI runs)
```

Run `make ci` before every push.

## Docs

- [`docs/spec.md`](docs/spec.md) — the authoritative specification. Read it first.
- [`docs/fiber-integration.md`](docs/fiber-integration.md) — the shared Fiber (FNN) RPC reference.
- [`CLAUDE.md`](CLAUDE.md) — the working agreement.

## License

MIT — see [`LICENSE`](LICENSE).
