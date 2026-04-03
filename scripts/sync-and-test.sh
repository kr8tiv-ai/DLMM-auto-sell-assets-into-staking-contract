#!/bin/bash
set -euo pipefail
export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

SRC="/mnt/c/Users/lucid/Desktop/brain staking"
DST="$HOME/brain-staking"

# Sync source, tests, and config
rsync -a --delete "$SRC/programs/brain-staking/src/" "$DST/programs/brain-staking/src/"
rsync -a --delete "$SRC/tests/" "$DST/tests/"
cp "$SRC/Anchor.toml" "$DST/Anchor.toml"

echo "==> Source and tests synced"

cd "$DST"
anchor test 2>&1 | tail -150
