#!/bin/bash
# check-balance.sh — Alert if crank wallet SOL balance is below threshold
# Add to cron: 0 */6 * * * /opt/brain-staking-crank/crank/scripts/check-balance.sh

CRANK_PUBKEY="${CRANK_PUBKEY:-}"
RPC_URL="${SOLANA_RPC_URL:-https://api.mainnet-beta.solana.com}"
MIN_BALANCE="${MIN_BALANCE_SOL:-0.05}"
WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"

if [[ -z "$CRANK_PUBKEY" ]]; then
    echo "ERROR: CRANK_PUBKEY not set"
    exit 1
fi

alert() {
    local msg="$1"
    echo "$msg"
    if [[ -n "$WEBHOOK_URL" ]]; then
        curl -s -X POST "$WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d "{\"content\":\"⚠️ **Brain Staking Crank**: $msg\"}" \
            >/dev/null 2>&1
    fi
}

BALANCE=$(curl -s "$RPC_URL" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$CRANK_PUBKEY\"]}" \
    | grep -o '"value":[0-9]*' | cut -d: -f2)

if [[ -z "$BALANCE" ]]; then
    alert "ERROR: Could not fetch balance for $CRANK_PUBKEY"
    exit 1
fi

BALANCE_SOL=$(echo "scale=4; $BALANCE / 1000000000" | bc 2>/dev/null || echo "0")

BELOW=$(echo "$BALANCE_SOL < $MIN_BALANCE" | bc 2>/dev/null || echo "0")
if [[ "$BELOW" == "1" ]]; then
    alert "LOW BALANCE: Crank wallet has ${BALANCE_SOL} SOL (threshold: ${MIN_BALANCE} SOL). Refill needed!"
    exit 1
fi

echo "OK: Crank balance ${BALANCE_SOL} SOL (threshold: ${MIN_BALANCE} SOL)"
exit 0
