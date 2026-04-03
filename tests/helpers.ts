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
// Governance helpers
// ──────────────────────────────────────────────────────────────────

export const GOVERNANCE_CONFIG_SEED = Buffer.from("governance_config");
export const PROPOSAL_SEED = Buffer.from("proposal");
export const VOTE_RECORD_SEED = Buffer.from("vote");

/**
 * Derive the GovernanceConfig PDA.
 */
export function findGovernanceConfig(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([GOVERNANCE_CONFIG_SEED], programId);
}

/**
 * Derive a Proposal PDA from its id.
 */
export function findProposal(
  proposalId: number,
  poolKey: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(proposalId));
  return PublicKey.findProgramAddressSync([PROPOSAL_SEED, poolKey.toBuffer(), buf], programId);
}

/**
 * Derive a VoteRecord PDA from proposal id + voter.
 */
export function findVoteRecord(
  proposalId: number,
  voter: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(proposalId));
  return PublicKey.findProgramAddressSync(
    [VOTE_RECORD_SEED, buf, voter.toBuffer()],
    programId
  );
}

/**
 * Initialize governance config. Only pool owner can call.
 */
export async function initializeGovernance(
  ctx: TestContext,
  authority: Keypair
): Promise<string> {
  const [governanceConfig] = findGovernanceConfig(ctx.program.programId);

  return ctx.program.methods
    .initializeGovernance()
    .accountsStrict({
      owner: authority.publicKey,
      stakingPool: ctx.stakingPool,
      governanceConfig,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
}

/**
 * Create a governance proposal. Derives the proposal PDA from next_proposal_id.
 */
export async function createProposal(
  ctx: TestContext,
  authority: Keypair,
  title: string,
  descriptionUri: string,
  proposalType: number,
  options: string[],
  votingStarts: anchor.BN,
  votingEnds: anchor.BN
): Promise<{ txSig: string; proposalId: number }> {
  const [governanceConfig] = findGovernanceConfig(ctx.program.programId);

  // Read current next_proposal_id to derive the correct PDA
  const config = await ctx.program.account.governanceConfig.fetch(governanceConfig);
  const proposalId = (config.nextProposalId as anchor.BN).toNumber();
  const [proposal] = findProposal(proposalId, ctx.stakingPool, ctx.program.programId);

  const txSig = await ctx.program.methods
    .createProposal(title, descriptionUri, proposalType, options, votingStarts, votingEnds)
    .accountsStrict({
      owner: authority.publicKey,
      stakingPool: ctx.stakingPool,
      governanceConfig,
      proposal,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  return { txSig, proposalId };
}

/**
 * Cast a vote on a proposal.
 */
export async function castVote(
  ctx: TestContext,
  voter: Keypair,
  voterBrainAta: PublicKey,
  proposalId: number,
  optionIndex: number,
  stakerAccount?: PublicKey
): Promise<string> {
  const [governanceConfig] = findGovernanceConfig(ctx.program.programId);
  const [proposal] = findProposal(proposalId, ctx.stakingPool, ctx.program.programId);
  const [voteRecord] = findVoteRecord(proposalId, voter.publicKey, ctx.program.programId);

  // Build remaining accounts for optional staker_account
  const remainingAccounts: anchor.web3.AccountMeta[] = [];

  // Use accountsStrict — staker_account is an Option<> field in the instruction
  const accounts: any = {
    voter: voter.publicKey,
    stakingPool: ctx.stakingPool,
    governanceConfig,
    proposal,
    voteRecord,
    voterBrainAta,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
  };

  if (stakerAccount) {
    accounts.stakerAccount = stakerAccount;
  } else {
    accounts.stakerAccount = null;
  }

  return ctx.program.methods
    .castVote(optionIndex)
    .accountsStrict(accounts)
    .signers([voter])
    .rpc();
}

/**
 * Close a proposal (permissionless — anyone can call after voting_ends).
 */
export async function closeProposal(
  ctx: TestContext,
  signer: Keypair,
  proposalId: number
): Promise<string> {
  const [proposal] = findProposal(proposalId, ctx.stakingPool, ctx.program.programId);
  const [governanceConfig] = findGovernanceConfig(ctx.program.programId);

  return ctx.program.methods
    .closeProposal()
    .accountsStrict({
      anyone: signer.publicKey,
      stakingPool: ctx.stakingPool,
      governanceConfig,
      proposal,
    })
    .signers([signer])
    .rpc();
}

/**
 * Fetch the GovernanceConfig account.
 */
export async function fetchGovernanceConfig(ctx: TestContext) {
  const [governanceConfig] = findGovernanceConfig(ctx.program.programId);
  return ctx.program.account.governanceConfig.fetch(governanceConfig);
}

/**
 * Fetch a Proposal account by id.
 */
export async function fetchProposal(ctx: TestContext, proposalId: number) {
  const [proposal] = findProposal(proposalId, ctx.stakingPool, ctx.program.programId);
  return ctx.program.account.proposal.fetch(proposal);
}

/**
 * Fetch a VoteRecord by proposal id and voter.
 */
export async function fetchVoteRecord(
  ctx: TestContext,
  proposalId: number,
  voter: PublicKey
) {
  const [voteRecord] = findVoteRecord(proposalId, voter, ctx.program.programId);
  return ctx.program.account.voteRecord.fetch(voteRecord);
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

// ──────────────────────────────────────────────────────────────────
// Governance exit helpers
// ──────────────────────────────────────────────────────────────────

/**
 * Call governance_initiate_exit — owner (manual) or crank (auto mode).
 * Creates a DlmmExit linked to a passed sell proposal.
 */
export async function governanceInitiateExit(
  ctx: TestContext,
  authority: Keypair,
  proposalId: number,
  assetMint: PublicKey,
  dlmmPool: PublicKey,
  position: PublicKey
): Promise<string> {
  const [governanceConfig] = findGovernanceConfig(ctx.program.programId);
  const [proposal] = findProposal(proposalId, ctx.stakingPool, ctx.program.programId);
  const [dlmmExit] = findDlmmExit(assetMint, dlmmPool, ctx.program.programId);

  return ctx.program.methods
    .governanceInitiateExit(assetMint, dlmmPool, position)
    .accountsStrict({
      authority: authority.publicKey,
      stakingPool: ctx.stakingPool,
      governanceConfig,
      proposal,
      dlmmExit,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
}

/**
 * Call set_auto_execute — owner only.
 */
export async function setAutoExecute(
  ctx: TestContext,
  authority: Keypair,
  enabled: boolean
): Promise<string> {
  const [governanceConfig] = findGovernanceConfig(ctx.program.programId);

  return ctx.program.methods
    .setAutoExecute(enabled)
    .accountsStrict({
      owner: authority.publicKey,
      stakingPool: ctx.stakingPool,
      governanceConfig,
    })
    .signers([authority])
    .rpc();
}

/**
 * Call set_quorum — owner only.
 */
export async function setQuorum(
  ctx: TestContext,
  authority: Keypair,
  minQuorumBps: number
): Promise<string> {
  const [governanceConfig] = findGovernanceConfig(ctx.program.programId);

  return ctx.program.methods
    .setQuorum(minQuorumBps)
    .accountsStrict({
      owner: authority.publicKey,
      stakingPool: ctx.stakingPool,
      governanceConfig,
    })
    .signers([authority])
    .rpc();
}

/**
 * Call realloc_governance_config — owner only, for migration.
 */
export async function reallocGovernanceConfig(
  ctx: TestContext,
  authority: Keypair
): Promise<string> {
  const [governanceConfig] = findGovernanceConfig(ctx.program.programId);

  return ctx.program.methods
    .reallocGovernanceConfig()
    .accountsStrict({
      owner: authority.publicKey,
      stakingPool: ctx.stakingPool,
      governanceConfig,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
}

/**
 * Call realloc_proposal — owner only, for migration.
 */
export async function reallocProposal(
  ctx: TestContext,
  authority: Keypair,
  proposalId: number
): Promise<string> {
  const [proposal] = findProposal(proposalId, ctx.stakingPool, ctx.program.programId);

  return ctx.program.methods
    .reallocProposal(new anchor.BN(proposalId))
    .accountsStrict({
      owner: authority.publicKey,
      stakingPool: ctx.stakingPool,
      proposal,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
}

/**
 * Call realloc_dlmm_exit — owner only, for migration.
 */
export async function reallocDlmmExit(
  ctx: TestContext,
  authority: Keypair,
  assetMint: PublicKey,
  dlmmPool: PublicKey
): Promise<string> {
  const [dlmmExit] = findDlmmExit(assetMint, dlmmPool, ctx.program.programId);

  return ctx.program.methods
    .reallocDlmmExit()
    .accountsStrict({
      owner: authority.publicKey,
      stakingPool: ctx.stakingPool,
      dlmmExit,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
}

/**
 * Call realloc_staking_pool — owner only, for migration.
 */
export async function reallocStakingPool(
  ctx: TestContext,
  authority: Keypair
): Promise<string> {
  return ctx.program.methods
    .reallocStakingPool()
    .accountsStrict({
      owner: authority.publicKey,
      stakingPool: ctx.stakingPool,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
}

export function snapshotGovernanceConfig(config: any) {
  return {
    pool: config.pool.toBase58(),
    nextProposalId: (config.nextProposalId as anchor.BN).toString(),
    autoExecute: config.autoExecute,
    minQuorumBps: config.minQuorumBps,
    bump: config.bump,
  };
}

export function snapshotProposal(proposal: any) {
  return {
    id: (proposal.id as anchor.BN).toString(),
    pool: proposal.pool.toBase58(),
    proposer: proposal.proposer.toBase58(),
    title: proposal.title,
    descriptionUri: proposal.descriptionUri,
    proposalType: proposal.proposalType,
    options: [...proposal.options],
    voteCounts: proposal.voteCounts.map((count: anchor.BN) => count.toString()),
    votingStarts: (proposal.votingStarts as anchor.BN).toString(),
    votingEnds: (proposal.votingEnds as anchor.BN).toString(),
    status: proposal.status,
    totalVoteWeight: (proposal.totalVoteWeight as anchor.BN).toString(),
    winningOptionIndex: proposal.winningOptionIndex,
    executed: proposal.executed,
    bump: proposal.bump,
  };
}

export function snapshotDlmmExit(dlmmExit: any) {
  return {
    pool: dlmmExit.pool.toBase58(),
    owner: dlmmExit.owner.toBase58(),
    assetMint: dlmmExit.assetMint.toBase58(),
    dlmmPool: dlmmExit.dlmmPool.toBase58(),
    position: dlmmExit.position.toBase58(),
    totalSolClaimed: (dlmmExit.totalSolClaimed as anchor.BN).toString(),
    status: dlmmExit.status,
    createdAt: (dlmmExit.createdAt as anchor.BN).toString(),
    completedAt: (dlmmExit.completedAt as anchor.BN).toString(),
    proposalId: (dlmmExit.proposalId as anchor.BN).toString(),
    bump: dlmmExit.bump,
  };
}

export function snapshotStakingPool(pool: any) {
  return {
    owner: pool.owner.toBase58(),
    crank: pool.crank.toBase58(),
    brainMint: pool.brainMint.toBase58(),
    brainVault: pool.brainVault.toBase58(),
    rewardVault: pool.rewardVault.toBase58(),
    treasury: pool.treasury.toBase58(),
    totalStaked: (pool.totalStaked as anchor.BN).toString(),
    totalWeightedStake: (pool.totalWeightedStake as anchor.BN).toString(),
    rewardPerShare: (pool.rewardPerShare as anchor.BN).toString(),
    totalRewardsDistributed: (pool.totalRewardsDistributed as anchor.BN).toString(),
    protocolFeeBps: pool.protocolFeeBps,
    minStakeAmount: (pool.minStakeAmount as anchor.BN).toString(),
    pendingOwner: pool.pendingOwner.toBase58(),
    isPaused: pool.isPaused,
    bump: pool.bump,
    brainVaultBump: pool.brainVaultBump,
    rewardVaultBump: pool.rewardVaultBump,
  };
}
