#!/bin/bash
set -euo pipefail
export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

SRC="/mnt/c/Users/lucid/Desktop/brain staking"
DST="$HOME/brain-staking"

# Kill stale processes
killall -9 solana-test-validator 2>/dev/null || true
killall -9 node 2>/dev/null || true
sleep 2

# Sync
rsync -a --delete "$SRC/programs/brain-staking/src/" "$DST/programs/brain-staking/src/"
rsync -a --delete "$SRC/tests/" "$DST/tests/"
cp "$SRC/Anchor.toml" "$DST/Anchor.toml"
echo "HEARTBEAT: synced"

cd "$DST"

# Build first (includes Rust changes)
echo "HEARTBEAT: building..."
anchor build 2>&1 | tail -5
echo "HEARTBEAT: built"

# Run anchor test with heartbeat (skip-build since we just built)
anchor test --skip-build 2>&1 &
TEST_PID=$!

# Heartbeat loop - print status every 10s
while kill -0 $TEST_PID 2>/dev/null; do
    echo "HEARTBEAT: $(date +%H:%M:%S) test running pid=$TEST_PID"
    sleep 10
done

wait $TEST_PID
EXIT_CODE=$?
echo "HEARTBEAT: test finished exit=$EXIT_CODE"
exit $EXIT_CODE
