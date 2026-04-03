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

### DLMM Exit Tracking

These instructions track the lifecycle of Meteora DLMM position exits on-chain:

| Instruction | Description |
|------------|-------------|
| `initiate_exit` | Owner opens a new DLMM exit tracker for an asset/pool/position |
| `governance_initiate_exit` | Execute a passed governance vote to initiate a DLMM exit |
| `record_claim` | Owner or crank records SOL claimed from filled DLMM bins |
| `complete_exit` | Mark an exit as completed once all liquidity is removed |
| `terminate_exit` | Owner cancels an active exit |

### Governance

Stake-weighted on-chain voting for community decisions:

| Instruction | Description |
|------------|-------------|
| `initialize_governance` | Set up governance config (tied to the staking pool) |
| `create_proposal` | Create a proposal with title, description URI, type, options, and voting window |
| `cast_vote` | Vote on an active proposal (weight = your staked $BRAIN amount) |
| `close_proposal` | Close a proposal after voting ends — tallies votes, checks quorum, determines outcome |
| `set_quorum` | Set minimum vote participation threshold (basis points of total staked) |
| `set_auto_execute` | Toggle whether the crank can auto-execute passed sell proposals |

### Admin

| Instruction | Description |
|------------|-------------|
| `emergency_halt` | Pause the pool and terminate all active DLMM exits atomically |
| `resume` | Unpause the pool |
| `update_crank` | Rotate the crank wallet address |
| `update_treasury` | Change the treasury wallet |
| `update_pool_config` | Update minimum stake amount and/or protocol fee |
| `transfer_ownership` | Initiate two-step ownership transfer (sets pending owner) |
| `accept_ownership` | New owner accepts the pending transfer |

### Account Reallocation

These instructions handle on-chain account migration when new fields are added:

| Instruction | Description |
|------------|-------------|
| `realloc_staking_pool` | Expand StakingPool account for new fields (e.g. `pending_owner`) |
| `realloc_governance_config` | Expand GovernanceConfig for new fields (e.g. `min_quorum_bps`) |
| `realloc_dlmm_exit` | Expand DlmmExit for new fields (e.g. `proposal_id`) |
| `realloc_proposal` | Expand Proposal for new fields (e.g. `executed`) |

## Architecture

- **Anchor 0.31** on Solana
- **PDA-controlled vaults** — staked $BRAIN sits in a program-owned token account; SOL rewards sit in a PDA SystemAccount
- **Accumulator pattern** — `reward_per_share` tracks global reward distribution; per-user `reward_debt` handles fair pro-rata splits without iteration
- **Crank authority** — a separate wallet with limited permissions (deposit rewards, record claims, complete exits) enabling automated off-chain operations without exposing owner keys
- **Protocol fee** — configurable up to 5% (500 bps), split to treasury on each reward deposit
- **Emergency halt** — single transaction pauses the pool and terminates all active DLMM exits via `remaining_accounts` pattern
- **On-chain governance** — stake-weighted voting with configurable quorum, auto-execute for passed sell proposals, and proposal-linked DLMM exits
- **Two-step ownership transfer** — `transfer_ownership` + `accept_ownership` prevents accidental lockout

## Key Design Decisions

- **No chart damage**: Treasury assets from our fund are sold directly into DLMM liquidity — never dumped on the open market — protecting the charts of every token we support
- **Pre-cliff forfeiture**: Stakers who bail before 7 days earn nothing — forfeited rewards go back to loyal stakers
- **Unstake always works**: Even when the pool is paused, users can always withdraw their $BRAIN (safety guarantee)
- **Checked math everywhere**: All arithmetic uses `checked_*` operations to prevent overflow/underflow exploits
- **Safe u128-to-u64 casts**: Reward calculations use `u64::try_from()` instead of silent truncation
- **1e12 precision**: Reward calculations use 10^12 scaling to minimize rounding dust across small and large stakes
- **Rent-exempt safety**: Vault withdrawals check that remaining lamports stay above rent-exempt minimum
- **Compile-time layout assertions**: Emergency halt byte offsets verified at compile time via `const` assertions
- **ATA owner constraints**: Stake and unstake verify the token account is actually owned by the signer
- **Quorum enforcement**: Governance proposals require configurable minimum vote participation to pass

## Project Structure

```
programs/brain-staking/
  src/
    lib.rs              # Program entrypoint and instruction routing
    constants.rs        # Seeds, thresholds, limits
    errors.rs           # Custom error codes
    helpers.rs          # Multiplier tier calculation
    fuzz_tests.rs       # Property-based tests (proptest)
    instructions/       # All instruction handlers
    state/              # Account structs (StakingPool, StakerAccount, DlmmExit, Proposal, etc.)
crank/                  # Off-chain TypeScript crank service
  src/
    index.ts            # Main crank loop
    dlmm-lifecycle.ts   # DLMM exit state machine
    dust-detection.ts   # Small balance detection
    jito-bundle.ts      # Jito bundle submission
    monitor.ts          # Health monitoring
    emergency.ts        # Emergency halt trigger
tests/                  # Anchor integration tests
scripts/                # Deploy and build scripts
docs/                   # Deployment runbook
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
