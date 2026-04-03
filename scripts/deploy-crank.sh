#!/bin/bash
# ============================================================================
# deploy-crank.sh — One-command crank deployment to VPS via SSH
# ============================================================================
# Usage:
#   bash scripts/deploy-crank.sh [OPTIONS]
#
# Options:
#   --host HOST        VPS hostname or IP (default: $CRANK_VPS_HOST or 76.13.106.100)
#   --user USER        SSH user (default: crank)
#   --key PATH         SSH key path (default: ~/.ssh/id_rsa)
#   --keypair PATH     Local crank keypair to upload (optional, first deploy only)
#   --docker           Use Docker Compose instead of PM2
#   --dry-run          Print commands without executing
# ============================================================================

set -euo pipefail

HOST="${CRANK_VPS_HOST:-76.13.106.100}"
SSH_USER="crank"
SSH_KEY="$HOME/.ssh/id_rsa"
KEYPAIR_PATH=""
USE_DOCKER=false
DRY_RUN=false
REMOTE_DIR="/opt/brain-staking-crank"

while [[ $# -gt 0 ]]; do
    case $1 in
        --host)    HOST="$2";          shift 2 ;;
        --user)    SSH_USER="$2";      shift 2 ;;
        --key)     SSH_KEY="$2";       shift 2 ;;
        --keypair) KEYPAIR_PATH="$2";  shift 2 ;;
        --docker)  USE_DOCKER=true;    shift ;;
        --dry-run) DRY_RUN=true;       shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

SSH_CMD="ssh -i $SSH_KEY $SSH_USER@$HOST"

run_cmd() {
    echo "  \$ $*"
    if [[ "$DRY_RUN" == true ]]; then
        echo "  [dry-run] skipped"
    else
        "$@"
    fi
}

echo "============================================"
echo " Brain Staking Crank — VPS Deploy"
echo "============================================"
echo " Host:   $SSH_USER@$HOST"
echo " Remote: $REMOTE_DIR"
echo " Mode:   $(if $USE_DOCKER; then echo Docker; else echo PM2; fi)"
echo ""

# Step 1: Upload keypair (first deploy only)
if [[ -n "$KEYPAIR_PATH" ]]; then
    echo "==> [1] Uploading crank keypair..."
    run_cmd scp -i "$SSH_KEY" "$KEYPAIR_PATH" "$SSH_USER@$HOST:$REMOTE_DIR/crank-keypair.json"
    run_cmd $SSH_CMD "chmod 600 $REMOTE_DIR/crank-keypair.json"
fi

# Step 2: Sync crank source
echo "==> [2] Syncing crank source..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRANK_DIR="$(cd "$SCRIPT_DIR/../crank" && pwd)"
run_cmd rsync -avz --delete \
    --exclude 'node_modules' \
    --exclude '.env' \
    --exclude 'heartbeat.txt' \
    --exclude 'logs' \
    --exclude 'dist' \
    -e "ssh -i $SSH_KEY" \
    "$CRANK_DIR/" "$SSH_USER@$HOST:$REMOTE_DIR/crank/"

# Step 3: Build and restart
echo "==> [3] Building and restarting..."

if $USE_DOCKER; then
    run_cmd $SSH_CMD "cd $REMOTE_DIR/crank && docker compose build && docker compose up -d"
else
    run_cmd $SSH_CMD "cd $REMOTE_DIR/crank && npm ci --production && npm run build && pm2 restart brain-staking-crank || pm2 start ecosystem.config.js"
fi

# Step 4: Verify
echo "==> [4] Verifying..."
sleep 3
if $USE_DOCKER; then
    run_cmd $SSH_CMD "docker ps --filter name=brain-staking-crank --format '{{.Status}}'"
else
    run_cmd $SSH_CMD "pm2 status brain-staking-crank"
fi

echo ""
echo "============================================"
echo " Deploy complete"
echo "============================================"
