# Brain Staking DLMM Exit Crank

Off-chain crank service that monitors DLMM exit positions on Solana, claims accumulated SOL fees, detects dust thresholds via Jupiter+Pyth price feeds, and completes exits when positions are fully unwound.

## Overview

The crank performs these operations in a continuous loop:

1. **Fetch** all active `DlmmExit` accounts from the program
2. **Monitor** each position's accumulated fees via the Meteora DLMM SDK
3. **Claim** fees when above the configured threshold, deposit SOL to the reward vault
4. **Check dust** — if remaining position value is below $1 (Jupiter/Pyth), complete the exit
5. **Submit** transactions via Jito bundles with automatic fallback to regular RPC

All output is structured JSON (one line per log entry) for easy parsing and alerting.

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9
- A funded Solana keypair registered as the crank wallet on the staking pool
- The deployed program IDL file (`brain_staking.json`)
- Access to a Solana RPC endpoint (dedicated recommended for production)

## VPS Setup

```bash
# 1. Create a dedicated user
sudo useradd -r -m -d /opt/brain-staking-crank -s /bin/bash crank

# 2. Clone and install
sudo -u crank bash
cd /opt/brain-staking-crank
git clone <repo-url> .
cd crank
npm ci --production

# 3. Build TypeScript
npm run build

# 4. Copy and configure environment
cp .env.example .env
chmod 600 .env
# Edit .env with your values (see Configuration below)
```

## Configuration

Copy `.env.example` to `.env` and fill in the required values:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SOLANA_RPC_URL` | ✅ | — | Solana RPC endpoint |
| `CRANK_KEYPAIR_PATH` | ✅ | — | Path to crank keypair JSON |
| `PROGRAM_ID` | ✅ | — | Deployed program ID (base58) |
| `STAKING_POOL` | ✅ | — | Staking pool PDA (base58) |
| `IDL_PATH` | | `../target/idl/brain_staking.json` | Anchor IDL file path |
| `POLL_INTERVAL_MS` | | `5000` | Polling interval (ms) |
| `CLAIM_THRESHOLD_LAMPORTS` | | `1000000` | Min fee threshold to claim |
| `JITO_BLOCK_ENGINE_URL` | | `https://mainnet.block-engine.jito.wtf` | Jito endpoint |
| `JITO_TIP_LAMPORTS` | | `10000` | Jito bundle tip |
| `HEARTBEAT_PATH` | | `./heartbeat.txt` | Heartbeat file location |

## Security

```bash
# Keypair file should be readable only by the crank user
chmod 600 /opt/brain-staking-crank/crank-keypair.json

# .env contains no secrets directly, but restrict access anyway
chmod 600 /opt/brain-staking-crank/crank/.env

# Firewall: the crank only needs outbound HTTPS (RPC, Jito, Jupiter, Pyth)
# No inbound ports required
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
```

**Key rotation:** If the crank keypair is compromised, use the `update_crank` instruction (owner-only) to rotate to a new pubkey without redeploying the program. Generate a new keypair, call `update_crank` from the pool owner wallet, then update `CRANK_KEYPAIR_PATH` and restart.

## Running with PM2

```bash
# Install PM2 globally
npm install -g pm2

# Start the crank
cd /opt/brain-staking-crank/crank
pm2 start ecosystem.config.js

# View logs (structured JSON)
pm2 logs brain-staking-crank

# Filter errors only
pm2 logs brain-staking-crank --err

# Check status
pm2 status

# Restart after config changes
pm2 restart brain-staking-crank

# Enable startup persistence (auto-start on reboot)
pm2 startup
pm2 save
```

## Running with systemd

```bash
# Copy the service file
sudo cp brain-staking-crank.service /etc/systemd/system/

# Edit paths if needed
sudo systemctl edit brain-staking-crank

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable brain-staking-crank
sudo systemctl start brain-staking-crank

# View logs
journalctl -u brain-staking-crank -f

# Filter by level
journalctl -u brain-staking-crank -f | grep '"level":"error"'
```

## Health Monitoring

### Heartbeat check

The crank writes the current timestamp to `heartbeat.txt` after each monitoring cycle. A stale heartbeat indicates a stuck or crashed crank.

```bash
#!/bin/bash
# check-heartbeat.sh — alert if heartbeat is older than 30 seconds
HEARTBEAT_FILE="/opt/brain-staking-crank/crank/heartbeat.txt"
MAX_AGE_SECONDS=30

if [ ! -f "$HEARTBEAT_FILE" ]; then
  echo "CRITICAL: Heartbeat file missing"
  exit 2
fi

LAST_BEAT=$(cat "$HEARTBEAT_FILE")
LAST_EPOCH=$(date -d "$LAST_BEAT" +%s 2>/dev/null)
NOW_EPOCH=$(date +%s)
AGE=$((NOW_EPOCH - LAST_EPOCH))

if [ "$AGE" -gt "$MAX_AGE_SECONDS" ]; then
  echo "WARNING: Heartbeat stale (${AGE}s old)"
  exit 1
fi

echo "OK: Heartbeat fresh (${AGE}s old)"
exit 0
```

### PM2 monitoring

```bash
# Quick status
pm2 status brain-staking-crank

# Memory and CPU
pm2 monit
```

## Troubleshooting

### Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Missing required environment variable: X` | `.env` not loaded or var missing | Check `.env` file exists and contains the variable |
| `Error fetching exits` | RPC endpoint down or rate-limited | Check RPC URL, retry is automatic (3 attempts with backoff) |
| `Bundle/tx failed` | Jito bundle didn't land | Automatic Jito→RPC fallback handles this; check RPC health |
| `Failed to write heartbeat` | Permission issue on heartbeat path | Check file/directory permissions for crank user |

### Log inspection

```bash
# All crank logs (structured JSON)
pm2 logs brain-staking-crank --lines 100

# Filter by module
pm2 logs brain-staking-crank | grep '"module":"monitor"'

# Filter by exit PDA
pm2 logs brain-staking-crank | grep '"exitPda":"<first-8-chars>"'

# Errors only
pm2 logs brain-staking-crank | grep '"level":"error"'
```

## Emergency Operations

### Emergency halt

To pause the entire staking pool and terminate all active exits:

```bash
# From the pool owner wallet (not the crank wallet)
# Uses the emergency_halt instruction
npx ts-node scripts/emergency-halt.ts
```

### Key rotation

If the crank keypair is compromised:

1. Generate a new keypair: `solana-keygen new -o new-crank.json`
2. Call `update_crank` from the pool owner wallet with the new pubkey
3. Update `CRANK_KEYPAIR_PATH` in `.env` to point to the new keypair
4. Restart: `pm2 restart brain-staking-crank`
5. Securely delete the old keypair

The `update_crank` instruction is owner-only — the crank wallet itself cannot rotate its own key.
