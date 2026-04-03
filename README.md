# BRAIN Staking Contract

A Solana program built with [Anchor](https://www.anchor-lang.com/) that lets [$BRAIN](https://www.pinkyandthebrain.fun) token holders stake their tokens and earn SOL rewards — funded by automated DLMM liquidity exits from [Meteora](https://www.meteora.ag).

## How It Works

Pinky and the Brain operates a fund that holds positions in tokens we support. These assets are managed as DLMM (Dynamic Liquidity Market Maker) positions on Meteora. When it's time to take profits, dumping on the open market would hurt the charts of projects we believe in. Instead, this contract sells those assets directly into existing DLMM liquidity — no market orders, no chart impact — and routes the SOL proceeds into the staking contract as rewards for $BRAIN holders.

**The result**: Treasury assets are sold directly into existing DLMM liquidity — no market sells, no chart damage. The SOL proceeds flow straight to $BRAIN stakers as real yield.

### The Flow

```
Treasury DLMM Position (supported tokens)
        |
        v
  Crank initiates exit
  (assets sell directly into DLMM liquidity -- no market impact)
        |
        v
  SOL claimed from filled bins
        |
        v
  deposit_rewards() --> Protocol fee to treasury
        |
        v
  SOL distributed to $BRAIN stakers
  (weighted by tier multiplier)
```

## Staking Tiers

Longer stakers earn more. Rewards are weighted by a time-based multiplier:

| Tier | Duration | Multiplier | Description |
|------|----------|------------|-------------|
| Pre-cliff | < 7 days | 0x | No rewards earned yet |
| Tier 1 | 7+ days | 1x | Base reward rate |
| Tier 2 | 30+ days | 2x | Double rewards |
| Tier 3 | 90+ days | 3x | Maximum rewards |

Stakers who unstake before the 7-day cliff forfeit any pending rewards, which are redistributed to remaining stakers. Stakers who unstake after the cliff automatically claim all pending SOL rewards on exit. Your $BRAIN tokens are always returned in full regardless of when you unstake.

## Program Instructions

### Core Staking

| Instruction | Description |
|------------|-------------|
| `initialize` | Deploy the staking pool with mint, treasury, fee, and minimum stake config |
| `stake` | Stake $BRAIN tokens into the vault (creates a per-user PDA account) |
| `claim` | Claim accumulated SOL rewards (settles any multiplier tier upgrades) |
| `unstake` | Exit your position — returns all $BRAIN + auto-claims SOL if post-cliff |
| `deposit_rewards` | Deposit SOL into the reward pool (owner or crank); protocol fee split to treasury |
| `emergency_rescue` | Recover staked $BRAIN even if the pool is paused or admin keys are compromised |

### DLMM Exit Tracking

These instructions track the lifecycle of Meteora DLMM position exits on-chain:

| Instruction | Description |
|------------|-------------|
| `initiate_exit` | Owner opens a new DLMM exit tracker for an asset/pool/position |
| `governance_initiate_exit` | Execute a passed governance vote to initiate a DLMM exit (48h timelock) |
| `record_claim` | Owner or crank records SOL claimed from filled DLMM bins (idempotency protected) |
| `complete_exit` | Mark an exit as completed once all liquidity is removed |
| `terminate_exit` | Owner cancels an active exit |
| `close_dlmm_exit` | Close a completed/terminated exit account and reclaim rent |

### Governance

Stake-weighted on-chain voting for community decisions:

| Instruction | Description |
|------------|-------------|
| `initialize_governance` | Set up governance config (tied to the staking pool) |
| `create_proposal` | Create a proposal with title, description URI, type, options, and voting window |
| `cast_vote` | Vote on an active proposal (weight = your staked $BRAIN amount) |
| `close_proposal` | Close a proposal after voting ends — tallies votes, checks quorum, determines outcome |
| `close_vote_record` | Close a vote record after proposal ends and reclaim rent |
| `set_quorum` | Set minimum vote participation threshold (basis points of total staked) |
| `set_auto_execute` | Toggle whether the crank can auto-execute passed sell proposals |
| `update_treasury_by_governance` | Change treasury wallet via passed governance proposal (48h timelock) |
| `update_pool_config_by_governance` | Update min stake / fee via passed governance proposal (48h timelock) |

### Admin

| Instruction | Description |
|------------|-------------|
| `emergency_halt` | Pause the pool and terminate all active DLMM exits atomically |
| `resume` | Unpause the pool |
| `update_crank` | Rotate the crank wallet address |
| `update_treasury` | Change the treasury wallet (owner-only) |
| `update_pool_config` | Update minimum stake amount and/or protocol fee |
| `transfer_ownership` | Initiate two-step ownership transfer (sets pending owner) |
| `accept_ownership` | New owner accepts the pending transfer |
| `renounce_ownership` | Permanently burn the owner key — makes the protocol fully decentralized |

### Account Reallocation

These instructions handle on-chain account migration when new fields are added:

| Instruction | Description |
|------------|-------------|
| `realloc_staking_pool` | Expand StakingPool for new fields (e.g. `pending_owner`) |
| `realloc_governance_config` | Expand GovernanceConfig for new fields (e.g. `min_quorum_bps`) |
| `realloc_dlmm_exit` | Expand DlmmExit for new fields (e.g. `proposal_id`, `last_claimed_amount`) |
| `realloc_proposal` | Expand Proposal for new fields (e.g. `executed`, `passed_at`, `quorum_snapshot`) |

## Architecture

- **Anchor 0.31** on Solana
- **PDA-controlled vaults** — staked $BRAIN sits in a program-owned token account; SOL rewards sit in a PDA SystemAccount
- **Accumulator pattern** — `reward_per_share` tracks global reward distribution; per-user `reward_debt` handles fair pro-rata splits without iteration
- **Crank authority** — a separate wallet with limited permissions (deposit rewards, record claims, complete exits) enabling automated off-chain operations without exposing owner keys
- **Protocol fee** — configurable up to 5% (500 bps), split to treasury on each reward deposit
- **Emergency halt** — single transaction pauses the pool and terminates all active DLMM exits via `remaining_accounts` pattern with pool-ownership validation
- **Emergency rescue** — users can always recover their $BRAIN, even when the pool is paused or admin keys are compromised
- **On-chain governance** — stake-weighted voting with configurable quorum, auto-execute for passed sell proposals, 48-hour execution timelock, and proposal-linked DLMM exits
- **Governance-gated config** — treasury and pool config changes can be routed through governance proposals with timelocks
- **Two-step ownership transfer** — `transfer_ownership` + `accept_ownership` prevents accidental lockout
- **Ownership renouncement** — irreversible path to full decentralization

## Security

- **Checked math everywhere** — all arithmetic uses `checked_*` operations to prevent overflow/underflow
- **Safe u128-to-u64 casts** — reward calculations use `u64::try_from()` instead of silent truncation
- **1e12 precision** — reward calculations use 10^12 scaling to minimize rounding dust
- **Rent-exempt safety** — vault withdrawals check remaining lamports stay above rent-exempt minimum
- **Emergency vault threshold** — pool auto-pauses if reward vault drops below 5 SOL
- **Compile-time layout assertions** — emergency halt byte offsets verified at compile time via `const` assertions
- **ATA owner constraints** — stake and unstake verify the token account is actually owned by the signer
- **Quorum enforcement** — governance proposals require configurable minimum vote participation to pass
- **Quorum snapshots** — total weighted stake captured at proposal creation, preventing manipulation
- **Execution timelocks** — 48-hour delay between proposal passing and execution
- **Idempotency guards** — `record_claim` tracks last claimed amount to prevent replay
- **Pool-ownership validation** — emergency halt verifies DlmmExit accounts belong to this pool
- **Zero-address guards** — crank, treasury, and ownership transfers reject `Pubkey::default()`
- **Max stake cap** — 10M $BRAIN per position to prevent whale concentration
- **Min reward deposit** — 1 SOL minimum to prevent dust attacks on the reward pool
- **Treasury type safety** — `SystemAccount` type validation (defense-in-depth from Cashio exploit pattern)

## Project Structure

```
programs/brain-staking/
  src/
    lib.rs              # Program entrypoint and instruction routing
    constants.rs        # Seeds, thresholds, limits
    errors.rs           # Custom error codes
    helpers.rs          # Multiplier tier calculation
    fuzz_tests.rs       # Property-based tests (proptest)
    instructions/       # All 30+ instruction handlers
    state/              # Account structs (StakingPool, StakerAccount, DlmmExit,
                        #   Proposal, GovernanceConfig, VoteRecord)
crank/                  # Off-chain TypeScript crank service
  src/
    index.ts            # Main crank loop
    dlmm-lifecycle.ts   # DLMM exit state machine
    dust-detection.ts   # Small balance detection
    jito-bundle.ts      # Jito bundle submission
    jito-tip.ts         # Dynamic Jito tip calculation
    metrics.ts          # Prometheus-style observability
    monitor.ts          # Health monitoring
    emergency.ts        # Emergency halt trigger
  scripts/              # Ops scripts (alerts, balance checks, heartbeat)
tests/                  # Anchor integration + security attack tests
scripts/                # Deploy, build, and sync scripts
docs/                   # Deployment runbook and ops procedures
```

## Development

```bash
# Install dependencies
yarn install

# Build the program
anchor build

# Run tests
anchor test

# Deploy
anchor deploy
```

## Program ID

```
5o2uBwvKUy4oF78ziR4tEiqz59k7XBXuZBwiZFqCfca2
```

## Links

- **Website**: [pinkyandthebrain.fun](https://www.pinkyandthebrain.fun)
- **Meteora DLMM**: [meteora.ag](https://www.meteora.ag)

## License

All rights reserved.
