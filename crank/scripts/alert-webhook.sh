#!/bin/bash
# alert-webhook.sh — Send alert to Discord/Telegram webhook
# Usage: 
#   ALERT_WEBHOOK_URL="https://discord.com/api/webhooks/..." bash alert-webhook.sh "message"
#   TELEGRAM_BOT_TOKEN="..." TELEGRAM_CHAT_ID="..." bash alert-webhook.sh "message"

set -euo pipefail

MESSAGE="${1:-}"
WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

if [[ -z "$MESSAGE" ]]; then
    echo "Usage: $0 \"alert message\""
    exit 1
fi

send_discord() {
    local webhook="$1"
    local msg="$2"
    curl -s -X POST "$webhook" \
        -H "Content-Type: application/json" \
        -d "{\"content\":null,\"embeds\":[{\"title\":\"⚠️ Brain Staking Alert\",\"description\":\"$msg\",\"timestamp\":\"$(date -Iseconds)\",\"color\":16744448}]}" \
        >/dev/null 2>&1
}

send_telegram() {
    local token="$1"
    local chat_id="$2"
    local msg="$3"
    curl -s -X POST "https://api.telegram.org/bot$token/sendMessage" \
        -H "Content-Type: application/json" \
        -d "{\"chat_id\":\"$chat_id\",\"text\":\"⚠️ Brain Staking Alert: $msg\",\"disable_notification\":false}" \
        >/dev/null 2>&1
}

if [[ -n "$WEBHOOK_URL" ]]; then
    send_discord "$WEBHOOK_URL" "$MESSAGE"
    echo "Discord alert sent: $MESSAGE"
elif [[ -n "$TELEGRAM_BOT_TOKEN" && -n "$TELEGRAM_CHAT_ID" ]]; then
    send_telegram "$TELEGRAM_BOT_TOKEN" "$TELEGRAM_CHAT_ID" "$MESSAGE"
    echo "Telegram alert sent: $MESSAGE"
else
    echo "ERROR: Set ALERT_WEBHOOK_URL or TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID"
    exit 1
fi
