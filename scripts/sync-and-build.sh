#!/bin/bash
set -euo pipefail
export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

SRC="/mnt/c/Users/lucid/Desktop/brain staking/programs/brain-staking/src"
DST="$HOME/brain-staking/programs/brain-staking/src"

rsync -a --delete "$SRC/" "$DST/"
echo "==> Source synced"

cd "$HOME/brain-staking"
anchor build 2>&1 | tail -100
