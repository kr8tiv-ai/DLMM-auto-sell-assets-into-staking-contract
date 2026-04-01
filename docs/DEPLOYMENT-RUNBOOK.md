# Brain Staking — Mainnet Deployment Runbook

> Complete step-by-step procedure for deploying the brain-staking program to Solana mainnet.
> All commands are copy-pasteable. Variables requiring substitution are marked with `<ANGLE_BRACKETS>`.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Pre-Deployment Checklist](#2-pre-deployment-checklist)
3. [Step-by-Step Deployment](#3-step-by-step-deployment)
4. [Post-Deployment Verification](#4-post-deployment-verification)
5. [Crank Setup](#5-crank-setup)
6. [Rollback Procedure](#6-rollback-procedure)
7. [Security Notes](#7-security-notes)

---

## 1. Prerequisites

### Required Tools

| Tool | Version | Install |
|------|---------|---------|
| Anchor CLI | 0.31.0 | `avm install 0.31.0 && avm use 0.31.0` |
| Solana CLI | 3.1.12 | [solana.com/docs/intro/installation](https://docs.solana.com/cli/install-solana-cli-tools) |
| Rust | 1.89 platform-tools | `rustup update` |
| solana-verify | latest | `cargo install solana-verify` |
| Docker | Desktop or Engine | Required for verifiable builds |
| Node.js | ≥ 18 | For integration test and crank |
| WSL (Windows) | 2 | Build environment (see K001) |

Verify your toolchain:

```bash
anchor --version    # anchor-cli 0.31.0
solana --version    # solana-cli 3.1.12
rustc --version     # 1.89.x
solana-verify --version
docker info         # must show daemon running
node --version      # v18+
```

### Wallet Setup

You need two keypairs:

1. **Deployer/Owner wallet** — pays for deployment, becomes upgrade authority and pool owner
2. **Crank wallet** — operates the DLMM exit crank (separate keypair, lower privilege)

Generate the crank keypair (if you don't have one yet):

```bash
solana-keygen new -o crank-keypair.json --no-bip39-passphrase
solana-keygen pubkey crank-keypair.json
# Save this pubkey — you'll need it for pool initialization
```

### SOL Funding Estimate

| Purpose | Estimated SOL |
|---------|--------------|
| Program deployment (account rent) | ~2.5 SOL |
| IDL publication | ~0.5 SOL |
| Pool initialization tx fee | ~0.01 SOL |
| Integration test tx fees | ~0.05 SOL |
| Buffer / headroom | ~0.5 SOL |
| **Total recommended** | **~3.6 SOL** |

Fund the deployer wallet:

```bash
# Check current balance
solana balance <DEPLOYER_PUBKEY> --url https://api.mainnet-beta.solana.com

# Transfer from exchange or another wallet — ensure ≥ 3.6 SOL
```

Also fund the crank wallet with a small amount (~0.1 SOL) for transaction fees.

### Production Parameters

These values are used during pool initialization:

| Parameter | Value | Notes |
|-----------|-------|-------|
| BRAIN mint | `7r9RJw6gWbj6s1N9pGKrdzzd5H7oK1sauuwkUDVKBAGS` | SPL token mint address |
| Treasury | `CzTn2G4uskfAC66QL1GoeSYEb3M3sUK4zxAoKDRGE4XV` | Protocol fee recipient |
| Protocol fee | `200` bps (2%) | Max allowed: 500 bps (5%) |
| Min stake | `100_000_000_000` | 100k BRAIN (6 decimals) |

---

## 2. Pre-Deployment Checklist

Run through each item before deploying. Do not proceed until all checks pass.

- [ ] **Toolchain versions match** — Anchor 0.31.0, Solana CLI 3.1.12, Rust 1.89
- [ ] **Docker is running** — `docker info` returns without error
- [ ] **Deployer wallet funded** — ≥ 3.6 SOL confirmed via `solana balance`
- [ ] **Crank keypair generated** — pubkey saved for pool initialization
- [ ] **Crank wallet funded** — ≥ 0.1 SOL for transaction fees
- [ ] **BRAIN mint verified** — confirm `7r9RJw6gWbj6s1N9pGKrdzzd5H7oK1sauuwkUDVKBAGS` is the correct production mint on-chain
- [ ] **Treasury address verified** — confirm `CzTn2G4uskfAC66QL1GoeSYEb3M3sUK4zxAoKDRGE4XV` is the correct recipient
- [ ] **Deployer keypair backed up** — secure offline copy exists
- [ ] **Crank keypair backed up** — secure offline copy exists
- [ ] **Git state clean** — `git status` shows no uncommitted changes
- [ ] **All tests pass locally** — `anchor test` on localnet passes
- [ ] **Anchor.toml has `[programs.mainnet]` section** — already added by T01
- [ ] **RPC endpoint selected** — dedicated RPC recommended for deployment (not public rate-limited endpoint)

---

## 3. Step-by-Step Deployment

### Step 3.1: Run Verifiable Build

The verifiable build uses Docker to produce a byte-for-byte reproducible `.so` binary.

```bash
# From the project root in WSL
wsl bash scripts/verifiable-build.sh
```

This will:
- Auto-detect Windows mount paths and sync source to WSL
- Verify toolchain versions
- Check Docker availability
- Run `solana-verify build --library-name brain_staking`
- Output: `target/deploy/brain_staking.so`

Verify the build artifact exists:

```bash
ls -lh target/deploy/brain_staking.so
```

**If the verifiable build fails:** Check Docker is running, ensure WSL has sufficient disk space, and verify Anchor/Solana versions match exactly.

### Step 3.2: Deploy Program (Upgradeable)

Option A — Use the orchestration script (recommended):

```bash
wsl bash scripts/deploy.sh \
  --wallet <PATH_TO_DEPLOYER_KEYPAIR> \
  --rpc <YOUR_RPC_URL> \
  --brain-mint 7r9RJw6gWbj6s1N9pGKrdzzd5H7oK1sauuwkUDVKBAGS \
  --treasury CzTn2G4uskfAC66QL1GoeSYEb3M3sUK4zxAoKDRGE4XV \
  --crank <CRANK_PUBKEY> \
  --skip-init
```

> **Note:** Use `--skip-init` on first run. Pool initialization is done separately after verifying the deployment (Step 3.5).

The script will:
1. Run pre-flight checks (toolchain, wallet balance)
2. Generate or reuse program keypair at `target/deploy/brain_staking-keypair.json`
3. Update `declare_id!()` in `lib.rs` to match the program keypair
4. Update `Anchor.toml` `[programs.mainnet]` with the program ID
5. Skip build (use `--skip-build` since we already built in Step 3.1)
6. Deploy as upgradeable with deployer as upgrade authority
7. Publish IDL on-chain

Option B — Manual deployment:

```bash
# Set config
solana config set --url <YOUR_RPC_URL> --keypair <PATH_TO_DEPLOYER_KEYPAIR>

# Deploy
solana program deploy \
  target/deploy/brain_staking.so \
  --program-id target/deploy/brain_staking-keypair.json \
  --keypair <PATH_TO_DEPLOYER_KEYPAIR> \
  --url <YOUR_RPC_URL> \
  --upgrade-authority <PATH_TO_DEPLOYER_KEYPAIR>
```

**Record the program ID** — you'll need it for all subsequent steps:

```bash
PROGRAM_ID=$(solana-keygen pubkey target/deploy/brain_staking-keypair.json)
echo "Program ID: $PROGRAM_ID"
```

### Step 3.3: Verify On-Chain Hash with solana-verify

After deployment, verify the on-chain binary matches the verifiable build:

```bash
solana-verify verify-from-repo \
  --program-id <PROGRAM_ID> \
  --url <YOUR_RPC_URL> \
  <YOUR_GIT_REPO_URL>
```

Expected output: hash match confirmation. If hashes differ, **do not proceed** — investigate the build environment.

### Step 3.4: Publish IDL

If `deploy.sh` didn't publish the IDL (or you used manual deployment):

```bash
anchor idl init \
  --filepath target/idl/brain_staking.json \
  --provider.cluster <YOUR_RPC_URL> \
  --provider.wallet <PATH_TO_DEPLOYER_KEYPAIR> \
  <PROGRAM_ID>
```

Verify IDL was published:

```bash
anchor idl fetch <PROGRAM_ID> --provider.cluster <YOUR_RPC_URL>
```

### Step 3.5: Initialize Staking Pool

Pool initialization requires a TypeScript transaction. Use the integration test script in init-only mode, or construct the transaction manually.

**Using the integration test script:**

```bash
npx ts-node -P scripts/tsconfig.scripts.json scripts/mainnet-integration-test.ts \
  --rpc-url <YOUR_RPC_URL> \
  --program-id <PROGRAM_ID> \
  --owner-keypair <PATH_TO_DEPLOYER_KEYPAIR> \
  --brain-mint 7r9RJw6gWbj6s1N9pGKrdzzd5H7oK1sauuwkUDVKBAGS
```

The `initialize` instruction creates these on-chain accounts:
- **Staking Pool PDA** — derived from seed `"staking_pool"`
- **BRAIN Vault PDA** — derived from seed `"brain_vault"` (holds staked BRAIN tokens)
- **Reward Vault PDA** — derived from seed `"reward_vault"` (holds SOL rewards)

Pool init parameters:
- `crank`: `<CRANK_PUBKEY>`
- `protocol_fee_bps`: `200`
- `min_stake_amount`: `100_000_000_000`

**Record the staking pool PDA** — the crank needs this:

```bash
# The pool PDA is deterministic from the program ID:
# seeds = ["staking_pool"], program = <PROGRAM_ID>
```

---

## 4. Post-Deployment Verification

### 4.1: Verify Program Is Deployed and Upgradeable

```bash
solana program show <PROGRAM_ID> --url <YOUR_RPC_URL>
```

Expected output should show:
- `Authority`: your deployer pubkey (upgrade authority)
- `Upgradeable`: yes
- `Data Length`: non-zero

### 4.2: Verify Upgrade Authority

```bash
solana program show <PROGRAM_ID> --url <YOUR_RPC_URL> | grep Authority
```

The authority should be your deployer wallet pubkey. If it says "none", the program was deployed as immutable — this is **not recoverable**.

### 4.3: Run Integration Test

Run the full lifecycle test against the deployed program:

```bash
npx ts-node -P scripts/tsconfig.scripts.json scripts/mainnet-integration-test.ts \
  --rpc-url <YOUR_RPC_URL> \
  --program-id <PROGRAM_ID> \
  --owner-keypair <PATH_TO_DEPLOYER_KEYPAIR> \
  --brain-mint 7r9RJw6gWbj6s1N9pGKrdzzd5H7oK1sauuwkUDVKBAGS
```

The test exercises 7 lifecycle steps:
1. **stake** — stakes BRAIN tokens
2. **deposit_rewards** — deposits SOL rewards
3. **claim** — claims earned SOL
4. **unstake** — withdraws staked BRAIN
5. **emergency_halt** — pauses the pool
6. **resume** — resumes the pool
7. **update_crank** — rotates crank key (and restores original)

Each step logs pass/fail independently. All 7 should pass.

### 4.4: Verify Pool State

```bash
# Fetch and inspect the staking pool account
anchor account brain_staking.StakingPool <STAKING_POOL_PDA> \
  --provider.cluster <YOUR_RPC_URL>
```

Confirm:
- `owner` = deployer pubkey
- `crank` = crank pubkey
- `brain_mint` = `7r9RJw6gWbj6s1N9pGKrdzzd5H7oK1sauuwkUDVKBAGS`
- `protocol_fee_bps` = `200`
- `min_stake_amount` = `100000000000`
- `paused` = `false`

---

## 5. Crank Setup

The DLMM exit crank is a Node.js service that monitors positions and automates fee claiming. Deploy it on a VPS for 24/7 operation.

### 5.1: Configure Crank Environment

```bash
cd crank
cp .env.example .env
chmod 600 .env
```

Edit `.env` with production values:

```env
# Required
SOLANA_RPC_URL=<YOUR_DEDICATED_RPC_URL>
CRANK_KEYPAIR_PATH=/opt/brain-staking-crank/crank-keypair.json
PROGRAM_ID=<PROGRAM_ID>
STAKING_POOL=<STAKING_POOL_PDA>

# Optional (defaults are sensible for production)
# IDL_PATH=../target/idl/brain_staking.json
# POLL_INTERVAL_MS=5000
# CLAIM_THRESHOLD_LAMPORTS=1000000
# JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf
# JITO_TIP_LAMPORTS=10000
# HEARTBEAT_PATH=./heartbeat.txt
```

### 5.2: VPS Deployment

Follow the full guide in [`crank/README.md`](../crank/README.md). Summary:

```bash
# On VPS — create dedicated user
sudo useradd -r -m -d /opt/brain-staking-crank -s /bin/bash crank

# Clone and install
sudo -u crank bash
cd /opt/brain-staking-crank
git clone <REPO_URL> .
cd crank
npm ci --production
npm run build

# Copy keypair (securely — do NOT commit to git)
# Transfer crank-keypair.json via scp or similar
chmod 600 /opt/brain-staking-crank/crank-keypair.json

# Configure environment
cp .env.example .env
chmod 600 .env
# Edit .env with production values (see 5.1)
```

### 5.3: Start with PM2 (Recommended)

```bash
npm install -g pm2

cd /opt/brain-staking-crank/crank
pm2 start ecosystem.config.js
pm2 startup   # Enable auto-start on reboot
pm2 save
```

Verify crank is running:

```bash
pm2 status
pm2 logs brain-staking-crank --lines 20
```

### 5.4: Health Monitoring

The crank writes a heartbeat file each cycle. Set up monitoring:

```bash
# Quick check — heartbeat should be < 30 seconds old
cat /opt/brain-staking-crank/crank/heartbeat.txt

# Automated check script (see crank/README.md for full version)
# Add to cron: */1 * * * * /opt/brain-staking-crank/check-heartbeat.sh
```

### 5.5: Firewall

The crank only needs outbound HTTPS — no inbound ports:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh    # keep SSH access
sudo ufw enable
```

---

## 6. Rollback Procedure

### If deployment fails mid-deploy (Step 3.2)

The program account may be in a partially-written state:

```bash
# Check if program exists
solana program show <PROGRAM_ID> --url <YOUR_RPC_URL>

# If it shows as a buffer (not deployed), close it to reclaim SOL
solana program close <PROGRAM_ID> \
  --keypair <PATH_TO_DEPLOYER_KEYPAIR> \
  --url <YOUR_RPC_URL> \
  --recipient <DEPLOYER_PUBKEY>
```

Then retry deployment from Step 3.2.

### If IDL publication fails (Step 3.4)

IDL publication is independent of the program. Retry:

```bash
anchor idl init \
  --filepath target/idl/brain_staking.json \
  --provider.cluster <YOUR_RPC_URL> \
  --provider.wallet <PATH_TO_DEPLOYER_KEYPAIR> \
  <PROGRAM_ID>
```

If the IDL was partially written, erase and re-init:

```bash
anchor idl erase -p <PROGRAM_ID> \
  --provider.cluster <YOUR_RPC_URL> \
  --provider.wallet <PATH_TO_DEPLOYER_KEYPAIR>

# Then re-init
anchor idl init --filepath target/idl/brain_staking.json \
  --provider.cluster <YOUR_RPC_URL> \
  --provider.wallet <PATH_TO_DEPLOYER_KEYPAIR> \
  <PROGRAM_ID>
```

### If pool initialization fails (Step 3.5)

Pool initialization is idempotent — the PDA derivation is deterministic. If the transaction fails, check:

1. Deployer has sufficient SOL for rent
2. BRAIN mint address is correct
3. Crank pubkey is valid

Then retry the initialization command. If the pool PDA already exists (previous partial init), the transaction will fail with "already in use" — the pool is already initialized.

### If a bug is found post-deployment

The program is deployed as upgradeable. To deploy a fix:

```bash
# 1. Fix the code and rebuild
wsl bash scripts/verifiable-build.sh

# 2. Deploy upgrade
solana program deploy \
  target/deploy/brain_staking.so \
  --program-id <PROGRAM_ID> \
  --keypair <PATH_TO_DEPLOYER_KEYPAIR> \
  --url <YOUR_RPC_URL> \
  --upgrade-authority <PATH_TO_DEPLOYER_KEYPAIR>

# 3. Re-verify on-chain hash
solana-verify verify-from-repo \
  --program-id <PROGRAM_ID> \
  --url <YOUR_RPC_URL> \
  <YOUR_GIT_REPO_URL>

# 4. Update IDL if interface changed
anchor idl upgrade \
  --filepath target/idl/brain_staking.json \
  --provider.cluster <YOUR_RPC_URL> \
  --provider.wallet <PATH_TO_DEPLOYER_KEYPAIR> \
  <PROGRAM_ID>
```

### Emergency halt

If a critical vulnerability is discovered and you need to stop all operations immediately:

```bash
# From the pool owner wallet — pauses the entire pool
# No new stakes, claims, or exits can be processed
npx ts-node scripts/emergency-halt.ts \
  --rpc-url <YOUR_RPC_URL> \
  --owner-keypair <PATH_TO_DEPLOYER_KEYPAIR> \
  --program-id <PROGRAM_ID>
```

To resume after the issue is resolved, call the `resume` instruction from the owner wallet.

---

## 7. Security Notes

### Keypair Storage

| Keypair | Storage Recommendation |
|---------|----------------------|
| Deployer/Owner | **Cold storage.** Keep offline after deployment. Only needed for upgrades, emergency halt, and admin operations. |
| Program keypair | **Archive.** Only needed if redeploying to the same address. Back up securely. |
| Crank keypair | **Hot wallet on VPS.** File permissions `600`, owned by the crank user. Minimally funded. |

**Never commit any keypair JSON to git.** Add to `.gitignore`:

```gitignore
*.json
!package.json
!tsconfig*.json
!Anchor.toml
crank-keypair.json
*-keypair.json
```

### Upgrade Authority Custody

The deployer wallet is the program's upgrade authority. This is the most sensitive key in the system — whoever holds it can deploy arbitrary code to the program.

**Recommended lifecycle:**

1. **Deploy phase** — deployer wallet is a single keypair (current setup)
2. **Stabilization phase** — after 2–4 weeks of stable operation, transfer upgrade authority to a Squads multisig
3. **Maturity phase** — consider making the program immutable (irreversible)

**Transfer upgrade authority to Squads multisig:**

```bash
# Create a Squads multisig at https://v4.squads.so
# Then transfer authority:
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_MULTISIG_VAULT_ADDRESS> \
  --keypair <PATH_TO_DEPLOYER_KEYPAIR> \
  --url <YOUR_RPC_URL>
```

> ⚠️ **This is irreversible.** After transfer, only the multisig can upgrade the program. Verify the multisig vault address carefully.

### Crank Key Rotation

If the crank keypair is compromised:

1. Generate a new keypair: `solana-keygen new -o new-crank.json --no-bip39-passphrase`
2. Call `update_crank` from the **owner wallet** (not the crank wallet):
   ```bash
   # The update_crank instruction rotates the authorized crank pubkey
   # Use the integration test script or a dedicated rotation script
   ```
3. Update `CRANK_KEYPAIR_PATH` in the crank's `.env` to point to the new keypair
4. Restart the crank: `pm2 restart brain-staking-crank`
5. Securely delete the compromised keypair: `shred -u old-crank.json`

The crank wallet cannot rotate its own key — only the pool owner can call `update_crank`.

### Network Security

- The crank VPS needs **only outbound HTTPS** (ports 443/8899) for RPC, Jito, Jupiter, and Pyth
- **No inbound ports** are required (except SSH for administration)
- Use UFW or equivalent firewall (see Section 5.5)
- Use a dedicated RPC endpoint — public endpoints have aggressive rate limits

### Operational Security Checklist

- [ ] Deployer keypair stored offline after deployment
- [ ] Crank keypair file permissions are `600`
- [ ] `.env` file permissions are `600`
- [ ] No keypairs committed to version control
- [ ] VPS firewall configured (deny incoming, allow outgoing + SSH)
- [ ] PM2 startup persistence enabled
- [ ] Heartbeat monitoring configured
- [ ] Upgrade authority transfer to multisig scheduled (2–4 week target)

---

## Quick Reference

### Key Addresses (fill in after deployment)

```
Program ID:          <PROGRAM_ID>
Staking Pool PDA:    <STAKING_POOL_PDA>
BRAIN Vault PDA:     <BRAIN_VAULT_PDA>
Reward Vault PDA:    <REWARD_VAULT_PDA>
Owner/Authority:     <DEPLOYER_PUBKEY>
Crank:               <CRANK_PUBKEY>
BRAIN Mint:          7r9RJw6gWbj6s1N9pGKrdzzd5H7oK1sauuwkUDVKBAGS
Treasury:            CzTn2G4uskfAC66QL1GoeSYEb3M3sUK4zxAoKDRGE4XV
```

### Key Scripts

| Script | Purpose |
|--------|---------|
| `scripts/verifiable-build.sh` | Docker-based reproducible build |
| `scripts/deploy.sh` | Full deployment orchestration |
| `scripts/mainnet-integration-test.ts` | Lifecycle integration test |

### Multiplier Tiers

| Duration | Multiplier | Threshold (seconds) |
|----------|-----------|---------------------|
| < 7 days | 0x (cliff) | 0 |
| 7–30 days | 1x | 604,800 |
| 30–90 days | 2x | 2,592,000 |
| > 90 days | 3x | 7,776,000 |
