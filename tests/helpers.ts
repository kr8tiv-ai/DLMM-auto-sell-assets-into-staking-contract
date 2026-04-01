import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { BrainStaking } from "../target/types/brain_staking";

// Seeds must match constants.rs
export const STAKING_POOL_SEED = Buffer.from("staking_pool");
export const STAKER_SEED = Buffer.from("staker");
export const BRAIN_VAULT_SEED = Buffer.from("brain_vault");
export const REWARD_VAULT_SEED = Buffer.from("reward_vault");
export const DLMM_EXIT_SEED = Buffer.from("dlmm_exit");

// Constants matching the program
export const PRECISION = BigInt("1000000000000"); // 1e12
export const TIER_1_SECONDS = 7 * 24 * 60 * 60;  // 7 days
export const TIER_2_SECONDS = 30 * 24 * 60 * 60;  // 30 days
export const TIER_3_SECONDS = 90 * 24 * 60 * 60;  // 90 days
export const DEFAULT_MIN_STAKE = BigInt("100000000000"); // 100k BRAIN w/ 6 decimals

/**
 * Derive the staking pool PDA.
 */
export function findStakingPool(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([STAKING_POOL_SEED], programId);
}

/**
 * Derive the BRAIN vault PDA.
 */
export function findBrainVault(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([BRAIN_VAULT_SEED], programId);
}

/**
 * Derive the SOL reward vault PDA.
 */
export function findRewardVault(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([REWARD_VAULT_SEED], programId);
}

/**
 * Derive a staker account PDA.
 */
export function findStakerAccount(
  userPubkey: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [STAKER_SEED, userPubkey.toBuffer()],
    programId
  );
}

/**
 * Full test context — returned by setupTestEnv.
 */
export interface TestContext {
  program: Program<BrainStaking>;
  provider: anchor.AnchorProvider;
  owner: Keypair;
  crank: Keypair;
  treasury: Keypair;
  brainMint: PublicKey;
  stakingPool: PublicKey;
  brainVault: PublicKey;
  rewardVault: PublicKey;
  poolBump: number;
  minStake: anchor.BN;
  protocolFeeBps: number;
}

/**
 * Set up a full test environment:
 * - Create BRAIN mint
 * - Initialize the staking pool
 * Returns everything needed for downstream tests.
 */
export async function setupTestEnv(
  protocolFeeBps = 200,
  minStakeAmount?: anchor.BN
): Promise<TestContext> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.BrainStaking as Program<BrainStaking>;

  const owner = (provider.wallet as anchor.Wallet).payer;
  const crank = Keypair.generate();
  const treasury = Keypair.generate();

  // Airdrop to crank so it can call deposit_rewards
  const sig = await provider.connection.requestAirdrop(
    crank.publicKey,
    10 * LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(sig, "confirmed");

  // Create BRAIN mint (6 decimals)
  const brainMint = await createMint(
    provider.connection,
    owner,
    owner.publicKey, // mint authority
    null,            // freeze authority
    6                // decimals
  );

  // Derive PDAs
  const [stakingPool, poolBump] = findStakingPool(program.programId);
  const [brainVault] = findBrainVault(program.programId);
  const [rewardVault] = findRewardVault(program.programId);

  const minStake = minStakeAmount || new anchor.BN(DEFAULT_MIN_STAKE.toString());

  // Initialize pool
  await program.methods
    .initialize(crank.publicKey, protocolFeeBps, minStake)
    .accountsStrict({
      owner: owner.publicKey,
      stakingPool,
      brainMint,
      brainVault,
      rewardVault,
      treasury: treasury.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  return {
    program,
    provider,
    owner,
    crank,
    treasury,
    brainMint,
    stakingPool,
    brainVault,
    rewardVault,
    poolBump,
    minStake,
    protocolFeeBps,
  };
}

/**
 * Create a staker: generate keypair, airdrop SOL, create BRAIN ATA, mint BRAIN tokens.
 */
export async function createStaker(
  ctx: TestContext,
  brainAmount: bigint
): Promise<{ keypair: Keypair; brainAta: PublicKey }> {
  const keypair = Keypair.generate();

  // Airdrop SOL for tx fees + rent
  const sig = await ctx.provider.connection.requestAirdrop(
    keypair.publicKey,
    5 * LAMPORTS_PER_SOL
  );
  await ctx.provider.connection.confirmTransaction(sig, "confirmed");

  // Create BRAIN ATA for the staker
  const brainAta = await createAssociatedTokenAccount(
    ctx.provider.connection,
    keypair,
    ctx.brainMint,
    keypair.publicKey
  );

  // Mint BRAIN tokens to the staker
  await mintTo(
    ctx.provider.connection,
    ctx.owner, // payer (mint authority)
    ctx.brainMint,
    brainAta,
    ctx.owner, // mint authority
    brainAmount
  );

  return { keypair, brainAta };
}

/**
 * Execute the stake instruction for a user.
 */
export async function stakeTokens(
  ctx: TestContext,
  user: Keypair,
  userBrainAta: PublicKey,
  amount: anchor.BN
): Promise<string> {
  const [stakerAccount] = findStakerAccount(user.publicKey, ctx.program.programId);

  return ctx.program.methods
    .stake(amount)
    .accountsStrict({
      user: user.publicKey,
      stakingPool: ctx.stakingPool,
      stakerAccount,
      userBrainAta,
      brainVault: ctx.brainVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([user])
    .rpc();
}

/**
 * Execute deposit_rewards as the given authority (owner or crank).
 */
export async function depositRewards(
  ctx: TestContext,
  authority: Keypair,
  amount: anchor.BN
): Promise<string> {
  return ctx.program.methods
    .depositRewards(amount)
    .accountsStrict({
      authority: authority.publicKey,
      stakingPool: ctx.stakingPool,
      rewardVault: ctx.rewardVault,
      treasury: ctx.treasury.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
}

/**
 * Execute claim for a user.
 */
export async function claimRewards(
  ctx: TestContext,
  user: Keypair
): Promise<string> {
  const [stakerAccount] = findStakerAccount(user.publicKey, ctx.program.programId);

  return ctx.program.methods
    .claim()
    .accountsStrict({
      user: user.publicKey,
      stakingPool: ctx.stakingPool,
      stakerAccount,
      rewardVault: ctx.rewardVault,
      systemProgram: SystemProgram.programId,
    })
    .signers([user])
    .rpc();
}

/**
 * Execute unstake for a user.
 */
export async function unstakeTokens(
  ctx: TestContext,
  user: Keypair,
  userBrainAta: PublicKey
): Promise<string> {
  const [stakerAccount] = findStakerAccount(user.publicKey, ctx.program.programId);

  return ctx.program.methods
    .unstake()
    .accountsStrict({
      user: user.publicKey,
      stakingPool: ctx.stakingPool,
      stakerAccount,
      brainVault: ctx.brainVault,
      userBrainAta,
      rewardVault: ctx.rewardVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([user])
    .rpc();
}

/**
 * Fetch the StakingPool account data.
 */
export async function fetchPool(ctx: TestContext) {
  return ctx.program.account.stakingPool.fetch(ctx.stakingPool);
}

/**
 * Fetch a StakerAccount.
 */
export async function fetchStaker(ctx: TestContext, userPubkey: PublicKey) {
  const [stakerAccount] = findStakerAccount(userPubkey, ctx.program.programId);
  return ctx.program.account.stakerAccount.fetch(stakerAccount);
}

/**
 * Get BRAIN token balance for an ATA.
 */
export async function getBrainBalance(
  ctx: TestContext,
  ata: PublicKey
): Promise<bigint> {
  const account = await getAccount(ctx.provider.connection, ata);
  return account.amount;
}

/**
 * Get SOL balance in lamports.
 */
export async function getSolBalance(
  ctx: TestContext,
  pubkey: PublicKey
): Promise<number> {
  return ctx.provider.connection.getBalance(pubkey);
}

/**
 * Warp the validator clock forward by `seconds`.
 * Works with solana-test-validator via the warpToSlot RPC or direct clock set.
 */
export async function warpTime(
  ctx: TestContext,
  seconds: number
): Promise<void> {
  // Get current clock
  const clock = await ctx.provider.connection.getAccountInfo(
    anchor.web3.SYSVAR_CLOCK_PUBKEY
  );
  if (!clock || !clock.data) throw new Error("Cannot read clock sysvar");

  // Clock sysvar layout: slot(u64) + epoch_start_ts(i64) + epoch(u64) + leader_schedule_epoch(u64) + unix_timestamp(i64)
  // unix_timestamp is at offset 8+8+8+8 = 32, 8 bytes, little-endian i64
  const currentTs = Number(clock.data.readBigInt64LE(32));
  const newTs = currentTs + seconds;

  // We need to also advance slot since the validator won't process at old slots
  const currentSlot = await ctx.provider.connection.getSlot();
  // Approximate: ~2.5 slots per second on test validator, use a generous factor
  const slotsToAdvance = Math.ceil(seconds * 3);
  const newSlot = currentSlot + slotsToAdvance;

  // Use the undocumented but standard warpToSlot method for test validators
  // @ts-ignore — this is a test-validator-only RPC
  await (ctx.provider.connection as any)._rpcRequest("warpToSlot", [newSlot]);

  // Now set the clock timestamp via the SysvarClock hack
  // Unfortunately direct clock manipulation isn't easy via RPC.
  // The standard approach with anchor test is to manipulate the clock sysvar directly.
  // For solana-test-validator, we can use the clockWorkspace approach.

  // Alternative: use sysvarClockUpdate if available.
  // Most reliable: just advance enough slots that the clock advances naturally.
  // At default 400ms/slot, slotsToAdvance slots = slotsToAdvance * 0.4 seconds real time.
  // But the test validator advances unix_timestamp by 1 per slot approximately.

  // Wait for the warp to take effect
  await sleep(1000);
}

/**
 * Simple warp that advances slots. The test validator increments
 * unix_timestamp roughly 1:1 with slots on test-validator.
 * This is the most reliable cross-platform approach.
 */
export async function warpSlots(
  ctx: TestContext,
  slots: number
): Promise<void> {
  const currentSlot = await ctx.provider.connection.getSlot();
  // @ts-ignore — test-validator RPC
  await (ctx.provider.connection as any)._rpcRequest("warpToSlot", [
    currentSlot + slots,
  ]);
  // Give the validator a moment to process
  await sleep(500);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ──────────────────────────────────────────────────────────────────
// DlmmExit helpers
// ──────────────────────────────────────────────────────────────────

/**
 * Derive the DlmmExit PDA from asset_mint and dlmm_pool.
 */
export function findDlmmExit(
  assetMint: PublicKey,
  dlmmPool: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DLMM_EXIT_SEED, assetMint.toBuffer(), dlmmPool.toBuffer()],
    programId
  );
}

/**
 * Call initiate_exit — owner only.
 */
export async function initiateExit(
  ctx: TestContext,
  authority: Keypair,
  assetMint: PublicKey,
  dlmmPool: PublicKey,
  position: PublicKey
): Promise<string> {
  const [dlmmExit] = findDlmmExit(assetMint, dlmmPool, ctx.program.programId);

  return ctx.program.methods
    .initiateExit(assetMint, dlmmPool, position)
    .accountsStrict({
      authority: authority.publicKey,
      stakingPool: ctx.stakingPool,
      dlmmExit,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
}

/**
 * Call record_claim — owner or crank.
 */
export async function recordClaim(
  ctx: TestContext,
  authority: Keypair,
  assetMint: PublicKey,
  dlmmPool: PublicKey,
  amount: anchor.BN
): Promise<string> {
  const [dlmmExit] = findDlmmExit(assetMint, dlmmPool, ctx.program.programId);

  return ctx.program.methods
    .recordClaim(amount)
    .accountsStrict({
      authority: authority.publicKey,
      stakingPool: ctx.stakingPool,
      dlmmExit,
    })
    .signers([authority])
    .rpc();
}

/**
 * Call complete_exit — owner or crank.
 */
export async function completeExit(
  ctx: TestContext,
  authority: Keypair,
  assetMint: PublicKey,
  dlmmPool: PublicKey
): Promise<string> {
  const [dlmmExit] = findDlmmExit(assetMint, dlmmPool, ctx.program.programId);

  return ctx.program.methods
    .completeExit()
    .accountsStrict({
      authority: authority.publicKey,
      stakingPool: ctx.stakingPool,
      dlmmExit,
    })
    .signers([authority])
    .rpc();
}

/**
 * Call terminate_exit — owner only.
 */
export async function terminateExit(
  ctx: TestContext,
  authority: Keypair,
  assetMint: PublicKey,
  dlmmPool: PublicKey
): Promise<string> {
  const [dlmmExit] = findDlmmExit(assetMint, dlmmPool, ctx.program.programId);

  return ctx.program.methods
    .terminateExit()
    .accountsStrict({
      authority: authority.publicKey,
      stakingPool: ctx.stakingPool,
      dlmmExit,
    })
    .signers([authority])
    .rpc();
}

/**
 * Fetch a DlmmExit account by asset_mint + dlmm_pool.
 */
export async function fetchDlmmExit(
  ctx: TestContext,
  assetMint: PublicKey,
  dlmmPool: PublicKey
) {
  const [dlmmExit] = findDlmmExit(assetMint, dlmmPool, ctx.program.programId);
  return ctx.program.account.dlmmExit.fetch(dlmmExit);
}

// ──────────────────────────────────────────────────────────────────
// Emergency control helpers
// ──────────────────────────────────────────────────────────────────

/**
 * Call emergency_halt — owner only.
 * Pauses the pool and terminates any DlmmExit accounts passed as remaining_accounts.
 */
export async function emergencyHalt(
  ctx: TestContext,
  authority: Keypair,
  remainingAccounts: PublicKey[] = []
): Promise<string> {
  const remaining = remainingAccounts.map((pubkey) => ({
    pubkey,
    isWritable: true,
    isSigner: false,
  }));

  return ctx.program.methods
    .emergencyHalt()
    .accountsStrict({
      authority: authority.publicKey,
      stakingPool: ctx.stakingPool,
    })
    .remainingAccounts(remaining)
    .signers([authority])
    .rpc();
}

/**
 * Call resume — owner only.
 * Unpauses the pool.
 */
export async function resume(
  ctx: TestContext,
  authority: Keypair
): Promise<string> {
  return ctx.program.methods
    .resume()
    .accountsStrict({
      authority: authority.publicKey,
      stakingPool: ctx.stakingPool,
    })
    .signers([authority])
    .rpc();
}

/**
 * Call update_crank — owner only.
 * Rotates the crank wallet pubkey.
 */
export async function updateCrank(
  ctx: TestContext,
  authority: Keypair,
  newCrank: PublicKey
): Promise<string> {
  return ctx.program.methods
    .updateCrank(newCrank)
    .accountsStrict({
      authority: authority.publicKey,
      stakingPool: ctx.stakingPool,
    })
    .signers([authority])
    .rpc();
}
