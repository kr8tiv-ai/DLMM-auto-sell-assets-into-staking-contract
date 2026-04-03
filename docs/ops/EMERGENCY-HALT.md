# Emergency Halt — Operational Runbook

> Step-by-step procedure for halting the Brain Staking pool in case of critical vulnerability, security incident, or operational emergency.

---

## When to Use This Runbook

- **Critical vulnerability** discovered in the program
- **Security incident** — keys compromised, suspicious activity detected
- **DLMM pool exploited** — funds at risk in connected liquidity positions
- **Regulatory or legal directive** to suspend operations
- **Severe market event** requiring time to assess

> **Do NOT use** for routine maintenance — use the normal upgrade process instead.

---

## Quick Reference

| Command | What It Does |
|---------|-------------|
| `emergency_halt` | Pauses pool + terminates all DLMM exits |
| `resume` | Unpauses pool (after fix deployed) |

---

## Pre-Requisites

- Owner wallet keypair funded and accessible
- Program ID confirmed
- RPC URL with sufficient rate limits

```bash
export OWNER_KEYPAIR="/path/to/owner-keypair.json"
export RPC_URL="https://your-rpc-url"
export PROGRAM_ID="5o2uBwvKUy4oF78ziR4tEiqz59k7XBXuZBwiZFqCfca2"
```

---

## Step-by-Step

### Step 1: Confirm Emergency

1. **Verify the issue** — Don't panic. Check:
   - Is it a real vulnerability or expected behavior?
   - Are funds actively being exploited?
   - What's the scope of impact?

2. **Notify team** (if applicable):
   ```
   📢 Alert team: @channel Critical — Brain Staking emergency halt required
   Reason: <brief description>
   ```

3. **Document** — Record:
   - Time of discovery
   - Description of issue
   - Any transactions already observed

### Step 2: Execute Emergency Halt

**Using Anchor CLI:**

```bash
npx ts-node -P scripts/tsconfig.scripts.json scripts/emergency-halt.ts \
  --rpc-url $RPC_URL \
  --owner-keypair $OWNER_KEYPAIR \
  --program-id $PROGRAM_ID
```

**Manual via solana program:**

```bash
# Get the staking pool PDA
python3 -c "
from solana.publickey import PublicKey
pool = PublicKey.find_program_address([b'staking_pool'], PublicKey('$PROGRAM_ID'))
print(pool[0])
"

# Execute halt via anchor
anchor run emergency-halt --provider.cluster mainnet-beta
```

**Expected output:**
```
Executing emergency_halt...
Pool paused: true
Exits terminated: 3
Signature: <TX_SIGNATURE>
```

### Step 3: Verify Halt State

```bash
# Check pool is paused
anchor account brain_staking.StakingPool <POOL_PDA> \
  --provider.cluster mainnet-beta | grep paused

# Should show: paused: true
```

```bash
# Verify DLMM exits are terminated
anchor account brain_staking.DlmmExit <EXIT_PDA> \
  --provider.cluster mainnet-beta | grep status

# Should show: status: 2 (Terminated)
```

### Step 4: Assess & Plan

1. **Analyze the issue** — Determine:
   - Root cause
   - Affected functionality
   - Fix scope

2. **Decide next steps**:
   - **Fixable**: Deploy upgrade (see PROGRAM-UPGRADE.md)
   - **Permanent**: Liquidate positions, return funds to stakers
   - **Unsure**: Engage third-party audit

### Step 5: Resume Operations (if applicable)

After deploying a fix:

```bash
npx ts-node -P scripts/tsconfig.scripts.json scripts/resume.ts \
  --rpc-url $RPC_URL \
  --owner-keypair $OWNER_KEYPAIR \
  --program-id $PROGRAM_ID
```

**Verify resume:**
```bash
anchor account brain_staking.StakingPool <POOL_PDA> \
  --provider.cluster mainnet-beta | grep paused
# Should show: paused: false
```

---

## Post-Incident

### 1. Incident Report

Within 24 hours, document:

```
## Incident Report

**Date:** YYYY-MM-DD
**Severity:** Critical / High / Medium
**Duration:** <start> to <end>
**Impact:** <description>

### Root Cause
<technical explanation>

### Response Taken
1. <action>
2. <action>

### Lessons Learned
- <lesson 1>
- <lesson 2>

### Preventive Measures
- <measure>
```

### 2. Update Runbooks

If the incident reveals gaps in this runbook, update it.

### 3. Notify Community

If funds were at risk or operations paused:

- Announce on social channels
- Provide timeline for resolution
- Publish post-mortem after resolution

---

## Rollback (If Needed)

If the fix itself causes issues:

```bash
# Deploy previous version (if you have the .so)
solana program deploy target/deploy/brain_staking.so \
  --program-id $PROGRAM_ID \
  --keypair $OWNER_KEYPAIR \
  --url $RPC_URL \
  --upgrade-authority $OWNER_KEYPAIR
```

> Only do this if the issue is worse than the original emergency.

---

## Contacts

| Role | Contact |
|------|---------|
| Protocol Lead | @<handle> |
| On-Call Dev | @<handle> |
| Security | @<handle> |
| External Audit | @<firm> |

---

## Appendix

### Emergency Halt Instruction Details

| Field | Value |
|-------|-------|
| Instruction | `emergency_halt` |
| Authority | Owner only |
| Effects | Sets `pool.paused = true`, sets all `DlmmExit.status = 2` |
| Accounts Modified | StakingPool, all DlmmExit accounts via `remaining_accounts` |

### Resume Instruction Details

| Field | Value |
|-------|-------|
| Instruction | `resume` |
| Authority | Owner only |
| Effects | Sets `pool.paused = false` |
| Accounts Modified | StakingPool only |
