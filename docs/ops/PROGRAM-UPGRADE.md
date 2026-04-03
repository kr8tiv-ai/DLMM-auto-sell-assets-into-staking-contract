# Program Upgrade — Operational Runbook

> Step-by-step procedure for upgrading the Brain Staking program on mainnet.

---

## When to Use This Runbook

- **Bug fix** — patches to the on-chain program
- **Feature add** — new instructions or account fields
- **Security hardening** — address vulnerabilities
- **Optimization** — gas or compute savings

> **Do NOT use** for emergency halt — see EMERGENCY-HALT.md instead.

---

## Quick Reference

```bash
# Build → Deploy → Verify → Update IDL
wsl bash scripts/verifiable-build.sh
solana program deploy target/deploy/brain_staking.so \
  --program-id $PROGRAM_ID \
  --keypair $OWNER_KEYPAIR \
  --url $RPC_URL
solana-verify verify-from-repo --program-id $PROGRAM_ID --url $RPC_URL <REPO_URL>
anchor idl upgrade --filepath target/idl/brain_staking.json --provider.cluster $RPC_URL --provider.wallet $OWNER_KEYPAIR $PROGRAM_ID
```

---

## Prerequisites

```bash
export OWNER_KEYPAIR="/path/to/owner-keypair.json"
export RPC_URL="https://your-rpc-url"
export PROGRAM_ID="5o2uBwvKUy4oF78ziR4tEiqz59k7XBXuZBwiZFqCfca2"
export REPO_URL="https://github.com/your-org/brain-staking"
```

- [ ] Owner keypair accessible and funded (~0.1 SOL for tx fees)
- [ ] Upgrade authority confirmed (owner or multisig)
- [ ] Docker running (for verifiable build)
- [ ] No active emergencies

---

## Step-by-Step

### Step 1: Prepare Changes

1. **Make code changes** in `programs/brain-staking/src/`
2. **Add tests** for new functionality
3. **Run tests locally**:
   ```bash
   anchor test
   ```

### Step 2: Build Verifiable Binary

```bash
wsl bash scripts/verifiable-build.sh
```

**Expected output:**
```
Building brain_staking...
Verifiable build complete: target/deploy/brain_staking.so
SHA256: <hash>
```

> If verifiable build fails, see Troubleshooting below.

### Step 3: Verify Build Artifact

```bash
ls -lh target/deploy/brain_staking.so
```

Ensure:
- File exists and is non-empty
- Recent timestamp

### Step 4: Deploy Upgrade

```bash
solana program deploy target/deploy/brain_staking.so \
  --program-id $PROGRAM_ID \
  --keypair $OWNER_KEYPAIR \
  --url $RPC_URL \
  --upgrade-authority $OWNER_KEYPAIR
```

**Expected output:**
```
Deploying program... 
Program address: <PROGRAM_ID>
Signature: <TX_SIGNATURE>
```

### Step 5: Verify On-Chain Hash

```bash
solana-verify verify-from-repo \
  --program-id $PROGRAM_ID \
  --url $RPC_URL \
  $REPO_URL
```

**Expected output:**
```
Verified build hash matches on-chain program.
```

> If this fails, **do not proceed**. The deployed binary doesn't match the source.

### Step 6: Update IDL

If the interface changed (new instructions, changed accounts, or new fields):

```bash
anchor idl upgrade \
  --filepath target/idl/brain_staking.json \
  --provider.cluster $RPC_URL \
  --provider.wallet $OWNER_KEYPAIR \
  $PROGRAM_ID
```

**Verify IDL updated:**
```bash
anchor idl fetch $PROGRAM_ID --provider.cluster $RPC_URL | head -20
```

### Step 7: Run Integration Test

```bash
npx ts-node -P scripts/tsconfig.scripts.json scripts/mainnet-integration-test.ts \
  --rpc-url $RPC_URL \
  --program-id $PROGRAM_ID \
  --owner-keypair $OWNER_KEYPAIR \
  --brain-mint 7r9RJw6gWbj6s1N9pGKrdzzd5H7oK1sauuwkUDVKBAGS
```

All 7 steps should pass:
- [ ] stake
- [ ] deposit_rewards
- [ ] claim
- [ ] unstake
- [ ] emergency_halt
- [ ] resume
- [ ] update_crank

### Step 8: Verify Pool State

```bash
anchor account brain_staking.StakingPool <POOL_PDA> \
  --provider.cluster $RPC_URL
```

Confirm:
- `owner` = expected owner
- `crank` = expected crank
- `paused` = false

---

## Post-Upgrade

### 1. Monitor for Issues

Watch for:
- Failed transactions on the program
- Unusual activity patterns
- Community reports

```bash
# Check recent program transactions
solana tx --url $RPC_URL --address $PROGRAM_ID --before 50
```

### 2. Restart Crank (if needed)

If the crank was paused during upgrade:

```bash
pm2 restart brain-staking-crank
pm2 logs brain-staking-crank --lines 30
```

### 3. Notify Community

If the upgrade affects user-facing functionality:

```
📢 Brain Staking Update v<X.Y.Z>

What's new:
- <feature/fix>

The program has been upgraded and verified on-chain.
Staking operations continue normally.
```

---

## Rollback (If Issues Detected)

If the upgrade causes critical issues:

### Option A: Deploy Previous Version

```bash
# Only if you have the previous .so file
solana program deploy target/deploy/brain_staking_prev.so \
  --program-id $PROGRAM_ID \
  --keypair $OWNER_KEYPAIR \
  --url $RPC_URL
```

### Option B: Emergency Halt

If funds are at risk:

```bash
# See EMERGENCY-HALT.md
npx ts-node scripts/emergency-halt.ts \
  --rpc-url $RPC_URL \
  --owner-keypair $OWNER_KEYPAIR \
  --program-id $PROGRAM_ID
```

---

## Troubleshooting

### Verifiable Build Fails

**Error**: `Docker not found` or `build failed`

**Solution**:
```bash
# Check Docker is running
docker info

# If using WSL, ensure Docker Desktop is running and WSL integration is enabled
```

### solana-verify Fails After Deploy

**Error**: `Build hash does not match on-chain program`

**Cause**: The deployed binary doesn't match the source code.

**Solution**:
1. Do NOT proceed with the upgrade
2. Investigate build environment differences
3. Ensure all environment variables match
4. Retry with clean build

### IDL Upgrade Fails

**Error**: `IDL requires migration`

**Solution**:
```bash
# Fetch current IDL
anchor idl fetch $PROGRAM_ID --provider.cluster $RPC_URL > old_idl.json

# Compare with new IDL
diff old_idl.json target/idl/brain_staking.json
```

The IDL may need manual migration for complex changes.

### Integration Test Fails

**Error**: One or more test steps fail

**Solution**:
1. Identify the failing instruction
2. Check if it's due to the upgrade or pre-existing issue
3. Fix in code → rebuild → redeploy

---

## Multisig Upgrades (Squads)

If using a multisig for upgrade authority:

### Step 1: Build and Test

```bash
anchor build
anchor test
```

### Step 2: Create Upgrade Transaction

Use Squads UI or CLI:

```bash
squads tx create \
  --multisig <MULTISIG_ADDRESS> \
  --title "Upgrade Brain Staking v1.2.0" \
  --instruction "solana program deploy target/deploy/brain_staking.so --program-id $PROGRAM_ID"
```

### Step 3: Collect Signatures

Collect required threshold signatures from multisig members.

### Step 4: Execute

```bash
# Once threshold is met, the transaction executes automatically
# Or execute manually:
squads tx execute <TX_ID> --multisig <MULTISIG_ADDRESS>
```

### Step 5: Verify

Follow Steps 5-8 from the main procedure.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | YYYY-MM-DD | Initial mainnet deployment |
