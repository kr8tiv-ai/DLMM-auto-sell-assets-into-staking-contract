#!/bin/bash
# ============================================================================
# deploy.sh — Full mainnet deployment orchestration for brain-staking
# ============================================================================
# Orchestrates: keypair generation → declare_id update → verifiable build →
#               deploy as upgradeable → IDL publish → pool initialization
#
# Usage:
#   wsl bash scripts/deploy.sh [OPTIONS]
#
# Options (all have defaults, override via env or flags):
#   --wallet PATH        Deployer wallet keypair (default: ~/.config/solana/id.json)
#   --rpc URL            Solana RPC URL (default: https://api.mainnet-beta.solana.com)
#   --program-keypair P  Program keypair path (default: target/deploy/brain_staking-keypair.json)
#   --skip-build         Skip verifiable build (use existing .so)
#   --skip-init          Skip pool initialization
#   --dry-run            Print commands without executing
#
# Prerequisites:
#   - WSL with Anchor 0.31.0, Solana CLI 3.1.12, Rust 1.89 platform-tools
#   - solana-verify CLI installed: cargo install solana-verify
#   - Docker running (for verifiable build)
#   - Deployer wallet funded with ~3.6 SOL
#
# Production parameters (from constants.rs):
#   - min_stake_amount:   100_000_000_000 (100k BRAIN with 6 decimals)
#   - protocol_fee_bps:   200 (2%)
#   - BRAIN mint:          Set via --brain-mint or BRAIN_MINT env var
#   - Treasury:            Set via --treasury or TREASURY env var
#   - Crank:               Set via --crank or CRANK_PUBKEY env var
# ============================================================================

set -euo pipefail

# ── WSL PATH setup (K001/K002) ───────────────────────────────────────────────
export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# ── Defaults ──────────────────────────────────────────────────────────────────
WALLET="${WALLET:-$HOME/.config/solana/id.json}"
RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
PROGRAM_KEYPAIR="${PROGRAM_KEYPAIR:-target/deploy/brain_staking-keypair.json}"
BRAIN_MINT="${BRAIN_MINT:-}"
TREASURY="${TREASURY:-}"
CRANK_PUBKEY="${CRANK_PUBKEY:-}"
SKIP_BUILD=false
SKIP_INIT=false
DRY_RUN=false

# Production constants (from constants.rs)
MIN_STAKE_AMOUNT=100000000000      # 100k BRAIN with 6 decimals
PROTOCOL_FEE_BPS=200               # 2%

# ── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --wallet)       WALLET="$2";          shift 2 ;;
        --rpc)          RPC_URL="$2";         shift 2 ;;
        --program-keypair) PROGRAM_KEYPAIR="$2"; shift 2 ;;
        --brain-mint)   BRAIN_MINT="$2";      shift 2 ;;
        --treasury)     TREASURY="$2";        shift 2 ;;
        --crank)        CRANK_PUBKEY="$2";    shift 2 ;;
        --skip-build)   SKIP_BUILD=true;      shift ;;
        --skip-init)    SKIP_INIT=true;       shift ;;
        --dry-run)      DRY_RUN=true;         shift ;;
        --help|-h)
            head -30 "$0" | grep "^#" | sed 's/^# *//'
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# ── Resolve project root ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# If running from Windows mount, redirect to WSL native copy
if [[ "$PROJECT_ROOT" == /mnt/c/* ]]; then
    WSL_PROJECT="/home/lucid/brain-staking"
    echo "==> Detected Windows mount. Using WSL project at $WSL_PROJECT"
    PROJECT_ROOT="$WSL_PROJECT"
fi

cd "$PROJECT_ROOT"

# ── Helper ────────────────────────────────────────────────────────────────────
run_cmd() {
    echo "  \$ $*"
    if [[ "$DRY_RUN" == true ]]; then
        echo "  [dry-run] skipped"
    else
        "$@"
    fi
}

abort() {
    echo "ERROR: $1" >&2
    exit 1
}

# ── Banner ────────────────────────────────────────────────────────────────────
echo "============================================================================"
echo " brain-staking mainnet deployment"
echo "============================================================================"
echo ""
echo " Wallet:          $WALLET"
echo " RPC:             $RPC_URL"
echo " Program keypair: $PROGRAM_KEYPAIR"
echo " Skip build:      $SKIP_BUILD"
echo " Skip init:       $SKIP_INIT"
echo " Dry run:         $DRY_RUN"
echo ""

# ── Pre-flight checks ────────────────────────────────────────────────────────
echo "==> [1/7] Pre-flight checks"

echo "    Verifying toolchain..."
anchor --version || abort "Anchor CLI not found"
solana --version || abort "Solana CLI not found"

echo "    Verifying wallet exists..."
[[ -f "$WALLET" ]] || abort "Wallet not found at $WALLET"

echo "    Setting Solana config..."
run_cmd solana config set --url "$RPC_URL" --keypair "$WALLET"

DEPLOYER_PUBKEY=$(solana-keygen pubkey "$WALLET")
echo "    Deployer: $DEPLOYER_PUBKEY"

echo "    Checking wallet balance..."
BALANCE=$(solana balance "$DEPLOYER_PUBKEY" --url "$RPC_URL" 2>/dev/null | awk '{print $1}')
echo "    Balance: $BALANCE SOL"

# Warn if balance is low (need ~3.6 SOL for deployment)
if command -v bc &>/dev/null; then
    if (( $(echo "$BALANCE < 3.0" | bc -l 2>/dev/null || echo 0) )); then
        echo "    WARNING: Balance may be insufficient. Recommend >= 3.6 SOL for deployment."
    fi
fi

# ── Step 2: Generate or verify program keypair ────────────────────────────────
echo ""
echo "==> [2/7] Program keypair"

if [[ -f "$PROGRAM_KEYPAIR" ]]; then
    PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
    echo "    Using existing keypair: $PROGRAM_ID"
else
    echo "    Generating new program keypair at $PROGRAM_KEYPAIR"
    mkdir -p "$(dirname "$PROGRAM_KEYPAIR")"
    run_cmd solana-keygen new --no-bip39-passphrase --outfile "$PROGRAM_KEYPAIR"
    PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
    echo "    Generated program ID: $PROGRAM_ID"
fi

# ── Step 3: Update declare_id!() in lib.rs ────────────────────────────────────
echo ""
echo "==> [3/7] Updating declare_id!()"

LIB_RS="programs/brain-staking/src/lib.rs"
CURRENT_ID=$(grep 'declare_id!' "$LIB_RS" | sed 's/declare_id!("\(.*\)");/\1/')

if [[ "$CURRENT_ID" == "$PROGRAM_ID" ]]; then
    echo "    declare_id!() already set to $PROGRAM_ID"
else
    echo "    Updating $CURRENT_ID → $PROGRAM_ID"
    if [[ "$DRY_RUN" == true ]]; then
        echo "    [dry-run] would update declare_id!()"
    else
        sed -i "s/declare_id!(\"$CURRENT_ID\")/declare_id!(\"$PROGRAM_ID\")/" "$LIB_RS"
        echo "    Updated."
    fi
fi

# Also update Anchor.toml mainnet program ID
echo "    Updating Anchor.toml [programs.mainnet]..."
if [[ "$DRY_RUN" == true ]]; then
    echo "    [dry-run] would update Anchor.toml"
else
    sed -i "s/^brain_staking = \".*\"$/brain_staking = \"$PROGRAM_ID\"/" "$PROJECT_ROOT/Anchor.toml"
    echo "    Updated Anchor.toml."
fi

# ── Step 4: Verifiable build ──────────────────────────────────────────────────
echo ""
echo "==> [4/7] Verifiable build"

if [[ "$SKIP_BUILD" == true ]]; then
    echo "    Skipped (--skip-build)"
    [[ -f "target/deploy/brain_staking.so" ]] || abort "No .so found — run build first or remove --skip-build"
else
    if command -v solana-verify &>/dev/null; then
        echo "    Running solana-verify build (Docker-based reproducible build)..."
        run_cmd solana-verify build --library-name brain_staking
    else
        echo "    WARNING: solana-verify not installed. Falling back to anchor build."
        echo "    Install with: cargo install solana-verify"
        echo "    A non-verified build will NOT be verifiable on-chain."
        run_cmd anchor build
    fi
fi

echo "    Build artifact: target/deploy/brain_staking.so"
ls -lh target/deploy/brain_staking.so 2>/dev/null || abort "Build artifact not found"

# ── Step 5: Deploy as upgradeable ─────────────────────────────────────────────
echo ""
echo "==> [5/7] Deploying program (upgradeable)"

run_cmd solana program deploy \
    target/deploy/brain_staking.so \
    --program-id "$PROGRAM_KEYPAIR" \
    --keypair "$WALLET" \
    --url "$RPC_URL" \
    --upgrade-authority "$WALLET"

echo "    Program deployed: $PROGRAM_ID"
echo "    Upgrade authority: $DEPLOYER_PUBKEY"

# Verify deployment
echo "    Verifying deployment..."
run_cmd solana program show "$PROGRAM_ID" --url "$RPC_URL"

# ── Step 6: Publish IDL ───────────────────────────────────────────────────────
echo ""
echo "==> [6/7] Publishing IDL on-chain"

IDL_FILE="target/idl/brain_staking.json"
if [[ -f "$IDL_FILE" ]]; then
    run_cmd anchor idl init \
        --filepath "$IDL_FILE" \
        --provider.cluster "$RPC_URL" \
        --provider.wallet "$WALLET" \
        "$PROGRAM_ID"
    echo "    IDL published."
else
    echo "    WARNING: IDL file not found at $IDL_FILE"
    echo "    Run 'anchor build' to generate it, then publish manually:"
    echo "    anchor idl init --filepath $IDL_FILE --provider.cluster $RPC_URL --provider.wallet $WALLET $PROGRAM_ID"
fi

# ── Step 7: Initialize staking pool ──────────────────────────────────────────
echo ""
echo "==> [7/7] Initialize staking pool"

if [[ "$SKIP_INIT" == true ]]; then
    echo "    Skipped (--skip-init)"
elif [[ -z "$CRANK_PUBKEY" ]]; then
    echo "    Skipped — no --crank pubkey provided."
    echo "    Initialize manually after setting up the crank wallet:"
    echo ""
    echo "    # Using Anchor CLI or a script:"
    echo "    # initialize(crank=<CRANK_PUBKEY>, protocol_fee_bps=$PROTOCOL_FEE_BPS, min_stake_amount=$MIN_STAKE_AMOUNT)"
    echo ""
else
    echo "    Crank pubkey:       $CRANK_PUBKEY"
    echo "    Protocol fee:       $PROTOCOL_FEE_BPS bps ($(echo "scale=1; $PROTOCOL_FEE_BPS / 100" | bc)%)"
    echo "    Min stake amount:   $MIN_STAKE_AMOUNT lamports"
    echo ""
    echo "    Initializing pool via Anchor..."

    # The initialize instruction requires building a transaction.
    # Use anchor test --skip-deploy with a dedicated init script,
    # or call via the integration test script.
    echo "    NOTE: Pool initialization requires a TypeScript transaction."
    echo "    Run the integration test or a dedicated init script:"
    echo ""
    echo "    npx ts-node scripts/mainnet-integration-test.ts \\"
    echo "      --rpc $RPC_URL \\"
    echo "      --program-id $PROGRAM_ID \\"
    echo "      --wallet $WALLET \\"
    echo "      --crank $CRANK_PUBKEY"
    echo ""
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================================================"
echo " Deployment summary"
echo "============================================================================"
echo ""
echo " Program ID:       $PROGRAM_ID"
echo " Deployer:         $DEPLOYER_PUBKEY"
echo " Upgrade authority: $DEPLOYER_PUBKEY"
echo " RPC:              $RPC_URL"
echo " Network:          mainnet-beta"
echo ""
echo " Next steps:"
echo "   1. Verify build:     solana-verify verify-from-repo --program-id $PROGRAM_ID <REPO_URL>"
echo "   2. Initialize pool:  Run integration test or init script with --crank"
echo "   3. Set up crank:     Configure crank/.env with mainnet values (see crank/README.md)"
echo "   4. Fund treasury:    Transfer initial SOL rewards to reward vault"
echo "   5. Announce:         Program is live and accepting stakes"
echo ""
echo "============================================================================"
