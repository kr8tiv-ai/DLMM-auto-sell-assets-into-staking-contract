#!/bin/bash
set -e
export PATH="/home/lucid/.cargo/bin:/home/lucid/.local/share/solana/install/active_release/bin:/home/lucid/.avm/bin:$PATH"

cd /home/lucid/brain-staking

# The issue: cargo build-sbf uses the "solana" toolchain at 1.79.0
# which can't parse edition2024 in cpufeatures 0.3.0
# Solution: update the Solana platform-tools which include their own rustc

# Check current platform tools version
solana-install info 2>&1 || true
ls /home/lucid/.local/share/solana/install/active_release/bin/ 2>&1
echo "---"

# Check if newer anchor versions are available
avm list 2>&1
