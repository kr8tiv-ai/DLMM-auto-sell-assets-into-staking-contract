# Key Rotation — Operational Runbook

> Step-by-step procedures for rotating keys in the Brain Staking system.

---

## Quick Reference

| Key Type | Rotation Command | Authority | Downtime |
|----------|------------------|-----------|----------|
| Crank | `update_crank` | Owner | None |
| Owner | `transfer_ownership` + `accept_ownership` | Owner → Pending | None |
| Upgrade Authority | `solana program set-upgrade-authority` | Current owner | None |

---

## Prerequisites

```bash
export OWNER_KEYPAIR="/path/to/owner-keypair.json"
export NEW_KEYPAIR="/path/to/new-keypair.json"
export RPC_URL="https://your-rpc-url"
export PROGRAM_ID="5o2uBwvKUy4oF78ziR4tEiqz59k7XBXuZBwiZFqCfca2"
```

---

## 1. Crank Key Rotation

The crank key can be rotated by the pool owner at any time without affecting stakers or pausing operations.

### Step 1: Generate New Crank Keypair

```bash
# Generate new crank keypair
solana-keygen new -o /tmp/new-crank.json --no-bip39-passphrase

# Get the pubkey
solana-keygen pubkey /tmp/new-crank.json
```

### Step 2: Fund the New Crank

```bash
# Airdrop or transfer ~0.1 SOL for transaction fees
solana transfer <NEW_CRANK_PUBKEY> 0.1 \
  --keypair $OWNER_KEYPAIR \
  --url $RPC_URL
```

### Step 3: Rotate the Crank

```bash
npx ts-node -P scripts/tsconfig.scripts.json scripts/update-crank.ts \
  --rpc-url $RPC_URL \
  --owner-keypair $OWNER_KEYPAIR \
  --program-id $PROGRAM_ID \
  --new-crank <NEW_CRANK_PUBKEY>
```

### Step 4: Update Crank VPS

1. **On VPS**, update `.env`:
   ```bash
   CRANK_KEYPAIR_PATH=/opt/brain-staking-crank/crank-keypair.json
   ```

2. **Replace the keypair file**:
   ```bash
   scp /tmp/new-crank.json user@vps:/opt/brain-staking-crank/crank-keypair.json
   ssh user@vps "chmod 600 /opt/brain-staking-crank/crank-keypair.json"
   ```

3. **Restart the crank**:
   ```bash
   pm2 restart brain-staking-crank
   pm2 logs brain-staking-crank --lines 20
   ```

### Step 5: Verify

```bash
# Check crank is running
pm2 status brain-staking-crank

# Check heartbeat
cat /opt/brain-staking-crank/crank/heartbeat.txt
# Should be < 30 seconds old
```

### Step 6: Secure Delete Old Keypair (if rotating due to compromise)

```bash
# Only if the old key was compromised!
# NEVER do this for routine rotation
shred -u /path/to/old-crank.json
```

---

## 2. Owner Key Rotation

Two-step process prevents accidental lockout. The current owner sets a pending owner, then the new owner accepts.

### Step 1: Initiate Transfer (Current Owner)

```bash
npx ts-node -P scripts/tsconfig.scripts.json scripts/transfer-ownership.ts \
  --rpc-url $RPC_URL \
  --owner-keypair $OWNER_KEYPAIR \
  --program-id $PROGRAM_ID \
  --new-owner <NEW_OWNER_PUBKEY>
```

**Expected output:**
```
Setting pending owner: <NEW_OWNER_PUBKEY>
Signature: <TX_SIGNATURE>
```

### Step 2: Accept Transfer (New Owner)

The new owner must sign the acceptance transaction:

```bash
npx ts-node -P scripts/tsconfig.scripts.json scripts/accept-ownership.ts \
  --rpc-url $RPC_URL \
  --new-owner-keypair $NEW_KEYPAIR \
  --program-id $PROGRAM_ID
```

**Expected output:**
```
Ownership transferred to: <NEW_OWNER_PUBKEY>
Signature: <TX_SIGNATURE>
```

### Step 3: Verify

```bash
anchor account brain_staking.StakingPool <POOL_PDA> \
  --provider.cluster mainnet-beta | grep -E "owner|pending"
```

Should show:
```
owner: <NEW_OWNER_PUBKEY>
pendingOwner: <DEFAULT_PUBKEY> (or empty)
```

### Step 4: Update Deployment Credentials

If you use the owner key for deployments, update:

1. **Deploy script**: Update `WALLET` path
2. **Runbook references**: Update `$OWNER_KEYPAIR` paths
3. **Team knowledge base**: Document new key location

### Rollback (If Needed)

If the new owner cannot complete acceptance:

```bash
# Current owner can cancel by setting pending_owner back to default
# (This is not directly supported — requires owner to remain)
```

> **Best Practice**: Always keep a backup of the original owner key in cold storage.

---

## 3. Upgrade Authority Rotation

Rotate to a multisig (e.g., Squads) for higher security.

### Step 1: Create Multisig

1. Go to https://v4.squads.so
2. Create a new multisig with your desired threshold (e.g., 2-of-3)
3. Record the vault address: `<MULTISIG_VAULT>`

### Step 2: Transfer Authority

```bash
solana program set-upgrade-authority $PROGRAM_ID \
  --new-upgrade-authority <MULTISIG_VAULT> \
  --keypair $OWNER_KEYPAIR \
  --url $RPC_URL
```

### Step 3: Verify

```bash
solana program show $PROGRAM_ID --url $RPC_URL | grep Authority
```

Should show:
```
Upgrade Authority: <MULTISIG_VAULT>
```

### Step 4: Test an Upgrade

Before relying on the multisig for critical upgrades, test:

```bash
# Deploy a minor upgrade (e.g., just rebuild without changes)
solana program deploy target/deploy/brain_staking.so \
  --program-id $PROGRAM_ID \
  --keypair <MULTISIG_MEMBERS_KEYPAIR> \
  --url $RPC_URL
```

### Multisig Signing for Future Upgrades

When using a Squads multisig:

```bash
# Build the upgrade
anchor build

# Use Squads CLI or UI to sign and execute the deployment
squads tx create \
  --multisig <MULTISIG_ADDRESS> \
  --authority <MEMBER_KEYPAIR> \
  --instruction "solana program deploy target/deploy/brain_staking.so"
```

---

## 4. Treasury Key Rotation

The treasury address receives protocol fees. It can be updated by the owner.

### Step 1: Verify New Treasury

```bash
# Ensure the new treasury address exists and can receive SOL
solana balance <NEW_TREASURY>
```

### Step 2: Rotate Treasury

```bash
npx ts-node -P scripts/tsconfig.scripts.json scripts/update-treasury.ts \
  --rpc-url $RPC_URL \
  --owner-keypair $OWNER_KEYPAIR \
  --program-id $PROGRAM_ID \
  --new-treasury <NEW_TREASURY_PUBKEY>
```

### Step 3: Verify

```bash
anchor account brain_staking.StakingPool <POOL_PDA> \
  --provider.cluster mainnet-beta | grep treasury
```

---

## Emergency: Revoke Upgrade Authority

If the upgrade authority key is compromised:

```bash
# Immediately set authority to a burn address (irreversible!)
solana program set-upgrade-authority $PROGRAM_ID \
  --new-upgrade-authority /dev/null \
  --keypair $COMPROMISED_KEYPAIR \
  --url $RPC_URL
```

> **WARNING**: This makes the program IMMUTABLE. You can no longer upgrade it. Only do this as a last resort.

---

## Key Storage Recommendations

| Key | Storage | Access |
|-----|---------|--------|
| Owner | Cold storage / HSM | Rare (upgrades, emergencies) |
| Upgrade Authority | Multisig | On upgrade only |
| Crank | Hot wallet (VPS) | 24/7 crank operations |
| Treasury | Cold storage / exchange | Fee collection |

### File Permissions

```bash
# On VPS
chmod 600 /opt/brain-staking-crank/crank-keypair.json
chmod 600 /opt/brain-staking-crank/.env
```
