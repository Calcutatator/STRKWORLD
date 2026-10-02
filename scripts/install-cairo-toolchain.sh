#!/usr/bin/env bash
# Installs the pinned Cairo toolchain for CI (x86_64 Linux): Scarb, Starknet Foundry and the
# Universal Sierra Compiler that snforge needs. Each tarball is a fixed GitHub release asset,
# checked against the sha256 digest GitHub publishes for it, so a moved tag cannot change what
# runs. Versions match contracts/receipt-ledger/.tool-versions.
set -euo pipefail

dest="${RUNNER_TEMP:-/tmp}/cairo-toolchain"
mkdir -p "$dest"

fetch() { # url sha256 name
  local file="$dest/$3.tar.gz"
  curl --proto '=https' --tlsv1.2 -fsSL "$1" -o "$file"
  echo "$2  $file" | sha256sum -c -
  tar -xzf "$file" -C "$dest"
}

fetch https://github.com/software-mansion/scarb/releases/download/v2.13.1/scarb-v2.13.1-x86_64-unknown-linux-gnu.tar.gz \
  c3354866901254d1868dcff7b56bb68822ca54f6a522cf8671685b2448ccdf15 scarb
fetch https://github.com/foundry-rs/starknet-foundry/releases/download/v0.52.0/starknet-foundry-v0.52.0-x86_64-unknown-linux-gnu.tar.gz \
  14b075ab6025d0a3808c3c639c9afc72bab8324f3b570bdf1123ccaaefedfe47 snfoundry
fetch https://github.com/software-mansion/universal-sierra-compiler/releases/download/v2.9.1/universal-sierra-compiler-v2.9.1-x86_64-unknown-linux-gnu.tar.gz \
  ce3e7b83e58f99f91a751d15f1a3229babe4fc5aa54e8fe6f3b01abbd4b8e1b8 usc

for bin in \
  "$dest/scarb-v2.13.1-x86_64-unknown-linux-gnu/bin" \
  "$dest/starknet-foundry-v0.52.0-x86_64-unknown-linux-gnu/bin" \
  "$dest/universal-sierra-compiler-v2.9.1-x86_64-unknown-linux-gnu/bin"; do
  if [ -n "${GITHUB_PATH:-}" ]; then echo "$bin" >> "$GITHUB_PATH"; fi
  export PATH="$bin:$PATH"
done
scarb --version
snforge --version
