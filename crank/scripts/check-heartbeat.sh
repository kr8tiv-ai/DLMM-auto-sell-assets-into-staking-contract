#!/bin/bash
# check-heartbeat.sh — Alert if crank heartbeat is stale
# Add to cron: */1 * * * * /opt/brain-staking-crank/crank/scripts/check-heartbeat.sh

HEARTBEAT_FILE="${HEARTBEAT_PATH:-/opt/brain-staking-crank/crank/heartbeat.txt}"
MAX_AGE_SECONDS="${MAX_AGE:-30}"
WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"

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

if [ ! -f "$HEARTBEAT_FILE" ]; then
    alert "CRITICAL: Heartbeat file missing at $HEARTBEAT_FILE"
    exit 2
fi

LAST_BEAT=$(cat "$HEARTBEAT_FILE")
LAST_EPOCH=$(date -d "$LAST_BEAT" +%s 2>/dev/null)
NOW_EPOCH=$(date +%s)
AGE=$((NOW_EPOCH - LAST_EPOCH))

if [ "$AGE" -gt "$MAX_AGE_SECONDS" ]; then
    alert "WARNING: Heartbeat stale (${AGE}s old, threshold ${MAX_AGE_SECONDS}s)"
    exit 1
fi

echo "OK: Heartbeat fresh (${AGE}s old)"
exit 0
