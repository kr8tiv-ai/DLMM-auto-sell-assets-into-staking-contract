#!/bin/bash
# ============================================================================
# verifiable-build.sh — Deterministic build via solana-verify in WSL
# ============================================================================
# Produces a verifiable .so that can be checked on-chain with:
#   solana-verify verify-from-repo <args>
#
# Usage:
#   wsl bash scripts/verifiable-build.sh
#
# Prerequisites:
#   - WSL with Anchor 0.31.0, Solana CLI 3.1.12, Rust 1.89 platform-tools
#   - solana-verify CLI installed: cargo install solana-verify
#   - Docker running (solana-verify uses Docker for reproducible builds)
# ============================================================================

set -euo pipefail

# ── WSL PATH setup (mirrors build_check.sh / K001) ──────────────────────────
export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# ── Resolve project root ─────────────────────────────────────────────────────
# When run from WSL, the project lives at /home/lucid/brain-staking
# When run from Windows WSL invocation, adapt the path
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# If we're under /mnt/c (Windows path), use the WSL-native copy
if [[ "$PROJECT_ROOT" == /mnt/c/* ]]; then
    WSL_PROJECT="/home/lucid/brain-staking"
    echo "==> Detected Windows mount. Syncing source to WSL project at $WSL_PROJECT"

    # Sync all Rust source files from Windows mount to WSL project
    SRC="$PROJECT_ROOT/programs/brain-staking/src"
    DST="$WSL_PROJECT/programs/brain-staking/src"

    # Sync entire src tree
    rsync -av --delete "$SRC/" "$DST/" 2>/dev/null || {
        echo "rsync not available, falling back to cp"
        cp -r "$SRC/"* "$DST/"
    }

    # Sync Anchor.toml and Cargo files
    cp "$PROJECT_ROOT/Anchor.toml" "$WSL_PROJECT/Anchor.toml"
    cp "$PROJECT_ROOT/Cargo.toml" "$WSL_PROJECT/Cargo.toml" 2>/dev/null || true
    cp "$PROJECT_ROOT/programs/brain-staking/Cargo.toml" "$WSL_PROJECT/programs/brain-staking/Cargo.toml" 2>/dev/null || true

    PROJECT_ROOT="$WSL_PROJECT"
    echo "==> Source synced. Building from $PROJECT_ROOT"
fi

cd "$PROJECT_ROOT"

# ── Verify toolchain ─────────────────────────────────────────────────────────
echo "==> Verifying toolchain..."
echo "    Anchor: $(anchor --version)"
echo "    Solana: $(solana --version)"
echo "    Rustc:  $(rustc --version)"

# ── Check solana-verify is installed ──────────────────────────────────────────
if ! command -v solana-verify &>/dev/null; then
    echo "ERROR: solana-verify not found. Install with: cargo install solana-verify"
    exit 1
fi
echo "    solana-verify: $(solana-verify --version)"

# ── Check Docker is available ─────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    echo "ERROR: Docker not found. solana-verify requires Docker for reproducible builds."
    echo "Install Docker Desktop and ensure it's running."
    exit 1
fi

if ! docker info &>/dev/null 2>&1; then
    echo "ERROR: Docker daemon is not running. Start Docker Desktop first."
    exit 1
fi
echo "    Docker: available"

# ── Run verifiable build ──────────────────────────────────────────────────────
echo ""
echo "==> Running verifiable build with solana-verify..."
echo "    This uses Docker to ensure byte-for-byte reproducibility."
echo ""

solana-verify build --library-name brain_staking

echo ""
echo "==> Verifiable build complete."
echo "    Output: target/deploy/brain_staking.so"
echo ""
echo "    After deployment, verify on-chain with:"
echo "    solana-verify verify-from-repo \\"
echo "      --program-id <PROGRAM_ID> \\"
echo "      --url mainnet-beta \\"
echo "      <REPO_URL>"
