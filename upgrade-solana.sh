#!/bin/bash
set -e
export PATH="/home/lucid/.cargo/bin:/home/lucid/.local/share/solana/install/active_release/bin:/home/lucid/.avm/bin:$PATH"

# Check available platform-tools versions
echo "=== Current platform-tools ==="
cat /home/lucid/.local/share/solana/install/active_release/bin/sdk/sbf/dependencies/platform-tools/version.md

echo "=== Checking latest Solana CLI ==="
# Try upgrading to latest Solana CLI which may have newer platform-tools
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" 2>&1
export PATH="/home/lucid/.local/share/solana/install/active_release/bin:$PATH"
solana --version

echo "=== New platform-tools ==="
/home/lucid/.local/share/solana/install/active_release/bin/sdk/sbf/dependencies/platform-tools/rust/bin/rustc --version 2>&1 || echo "checking..."
cat /home/lucid/.local/share/solana/install/active_release/bin/sdk/sbf/dependencies/platform-tools/version.md 2>&1 || echo "no version.md"
