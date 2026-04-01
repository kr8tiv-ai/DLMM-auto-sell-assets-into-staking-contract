#!/bin/bash
SRC="/mnt/c/Users/lucid/desktop/brain staking/programs/brain-staking/src"
DST="/home/lucid/brain-staking/programs/brain-staking/src"
cp "$SRC/instructions/unstake.rs" "$DST/instructions/unstake.rs"
cp "$SRC/instructions/mod.rs" "$DST/instructions/mod.rs"
cp "$SRC/lib.rs" "$DST/lib.rs"
echo "Files synced"
