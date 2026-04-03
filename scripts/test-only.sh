#!/bin/bash
set -euo pipefail
export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

SRC="/mnt/c/Users/lucid/Desktop/brain staking"
DST="$HOME/brain-staking"

# Sync source + tests + config
rsync -a --delete "$SRC/programs/brain-staking/src/" "$DST/programs/brain-staking/src/"
rsync -a --delete "$SRC/tests/" "$DST/tests/"
cp "$SRC/Anchor.toml" "$DST/Anchor.toml"
echo "==> Synced"

cd "$DST"

# Build only (no validator)
anchor build 2>&1 | tail -5
echo "==> Built"

# Run tests with --skip-build to avoid rebuilding
anchor test --skip-build 2>&1 | tail -200
