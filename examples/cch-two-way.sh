#!/usr/bin/env bash
set -euo pipefail

report="${1:-cch-transfer-proof.json}"

cleanup() {
  fiber-forge down cch --purge >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fiber-forge up cch --no-gui
fiber-forge cch prove cch --output "$report"
fiber-forge down cch --purge
trap - EXIT INT TERM
