import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import { expect } from "chai";
import { BrainStaking } from "../target/types/brain_staking";

import {
  TestContext,
  findStakingPool,
  findBrainVault,
  findRewardVault,
  findDlmmExit,
  DEFAULT_MIN_STAKE,
  setupTestEnv,
  createStaker,
  stakeTokens,
  claimRewards,
  unstakeTokens,
  initiateExit,
  terminateExit,
  fetchDlmmExit,
  fetchPool,
  emergencyHalt,
  resume,
} from "./helpers";

describe("emergency-controls", () => {
  let ctx: TestContext;

  before(async () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.BrainStaking as Program<BrainStaking>;

    const owner = (provider.wallet as anchor.Wallet).payer;
    const crank = Keypair.generate();
    const treasury = Keypair.generate();

    // Airdrop to crank
    const sig = await provider.connection.requestAirdrop(
      crank.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    const [stakingPool, poolBump] = findStakingPool(program.programId);
    const [brainVault] = findBrainVault(program.programId);
    const [rewardVault] = findRewardVault(program.programId);

    // Pool may already be initialized by prior test files in the same run.
    let brainMint: PublicKey;
    try {
      brainMint = await createMint(
        provider.connection,
        owner,
        owner.publicKey,
        null,
        6
      );

      await program.methods
        .initialize(
          crank.publicKey,
          200,
          new anchor.BN(DEFAULT_MIN_STAKE.toString())
        )
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
    } catch (_err) {
      // Pool already initialized — fetch existing state.
      const poolState = await program.account.stakingPool.fetch(stakingPool);
      brainMint = poolState.brainMint;
    }

    ctx = {
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
      minStake: new anchor.BN(DEFAULT_MIN_STAKE.toString()),
      protocolFeeBps: 200,
    };

    // Ensure pool starts unpaused for our tests
    const poolState = await fetchPool(ctx);
    if (poolState.isPaused) {
      await resume(ctx, ctx.owner);
    }
  });

  // Helper: ensure pool is unpaused before each test that needs it
  async function ensureUnpaused(): Promise<void> {
    const pool = await fetchPool(ctx);
    if (pool.isPaused) {
      await resume(ctx, ctx.owner);
    }
  }

  // Helper: create a fresh DlmmExit in Active status (status=0)
  async function createActiveExit(): Promise<{
    assetMint: PublicKey;
    dlmmPool: PublicKey;
    position: PublicKey;
    dlmmExitPda: PublicKey;
  }> {
    const assetMint = Keypair.generate().publicKey;
    const dlmmPool = Keypair.generate().publicKey;
    const position = Keypair.generate().publicKey;
    const [dlmmExitPda] = findDlmmExit(assetMint, dlmmPool, ctx.program.programId);

    await initiateExit(ctx, ctx.owner, assetMint, dlmmPool, position);

    return { assetMint, dlmmPool, position, dlmmExitPda };
  }

  // ─── emergency_halt ────────────────────────────────────────────

  it("emergency_halt with active exits — terminates all and pauses pool", async () => {
    await ensureUnpaused();

    // Create 2 active exits
    const exit1 = await createActiveExit();
    const exit2 = await createActiveExit();

    // Both should be Active (status=0)
    let e1 = await fetchDlmmExit(ctx, exit1.assetMint, exit1.dlmmPool);
    let e2 = await fetchDlmmExit(ctx, exit2.assetMint, exit2.dlmmPool);
    expect(e1.status).to.equal(0);
    expect(e2.status).to.equal(0);

    // Emergency halt with both exits as remaining_accounts
    await emergencyHalt(ctx, ctx.owner, [exit1.dlmmExitPda, exit2.dlmmExitPda]);

    // Pool should be paused
    const pool = await fetchPool(ctx);
    expect(pool.isPaused).to.be.true;

    // Both exits should be Terminated (status=2)
    e1 = await fetchDlmmExit(ctx, exit1.assetMint, exit1.dlmmPool);
    e2 = await fetchDlmmExit(ctx, exit2.assetMint, exit2.dlmmPool);
    expect(e1.status).to.equal(2);
    expect(e2.status).to.equal(2);
    expect(e1.completedAt.toNumber()).to.be.greaterThan(0);
    expect(e2.completedAt.toNumber()).to.be.greaterThan(0);
  });

  it("emergency_halt non-owner rejected — Unauthorized", async () => {
    await ensureUnpaused();

    const randomWallet = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(
      randomWallet.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(sig, "confirmed");

    try {
      await emergencyHalt(ctx, randomWallet, []);
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.toString()).to.contain("Unauthorized");
    }
  });

  it("emergency_halt with no remaining_accounts — just pauses the pool", async () => {
    await ensureUnpaused();

    // Verify pool is unpaused
    let pool = await fetchPool(ctx);
    expect(pool.isPaused).to.be.false;

    // Emergency halt with no exits
    await emergencyHalt(ctx, ctx.owner, []);

    // Pool should be paused
    pool = await fetchPool(ctx);
    expect(pool.isPaused).to.be.true;
  });

  it("emergency_halt with mixed statuses — only active exits terminated", async () => {
    await ensureUnpaused();

    // Create one active exit and one that we'll terminate before the halt
    const activeExit = await createActiveExit();
    const preTerminatedExit = await createActiveExit();

    // Terminate the second exit manually first
    await terminateExit(ctx, ctx.owner, preTerminatedExit.assetMint, preTerminatedExit.dlmmPool);
    let preTermState = await fetchDlmmExit(ctx, preTerminatedExit.assetMint, preTerminatedExit.dlmmPool);
    expect(preTermState.status).to.equal(2); // Already Terminated

    // Emergency halt with both exits as remaining_accounts
    await emergencyHalt(ctx, ctx.owner, [
      activeExit.dlmmExitPda,
      preTerminatedExit.dlmmExitPda,
    ]);

    // Pool should be paused
    const pool = await fetchPool(ctx);
    expect(pool.isPaused).to.be.true;

    // Active exit should now be Terminated
    const activeState = await fetchDlmmExit(ctx, activeExit.assetMint, activeExit.dlmmPool);
    expect(activeState.status).to.equal(2);

    // Pre-terminated exit should still be Terminated (status unchanged)
    preTermState = await fetchDlmmExit(ctx, preTerminatedExit.assetMint, preTerminatedExit.dlmmPool);
    expect(preTermState.status).to.equal(2);
  });

  // ─── resume ────────────────────────────────────────────────────

  it("resume by owner — unpauses pool", async () => {
    // Ensure pool is paused first
    const poolBefore = await fetchPool(ctx);
    if (!poolBefore.isPaused) {
      await emergencyHalt(ctx, ctx.owner, []);
    }

    let pool = await fetchPool(ctx);
    expect(pool.isPaused).to.be.true;

    // Resume
    await resume(ctx, ctx.owner);

    pool = await fetchPool(ctx);
    expect(pool.isPaused).to.be.false;
  });

  it("resume non-owner rejected — Unauthorized", async () => {
    // Ensure pool is paused
    const poolBefore = await fetchPool(ctx);
    if (!poolBefore.isPaused) {
      await emergencyHalt(ctx, ctx.owner, []);
    }

    const randomWallet = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(
      randomWallet.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(sig, "confirmed");

    try {
      await resume(ctx, randomWallet);
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.toString()).to.contain("Unauthorized");
    }

    // Clean up — resume for subsequent tests
    await resume(ctx, ctx.owner);
  });

  // ─── paused-state guards ───────────────────────────────────────

  it("paused pool blocks stake — PoolPaused", async () => {
    await ensureUnpaused();

    // Create a staker with BRAIN tokens
    const staker = await createStaker(ctx, BigInt(200_000_000_000)); // 200k BRAIN

    // Pause the pool
    await emergencyHalt(ctx, ctx.owner, []);
    const pool = await fetchPool(ctx);
    expect(pool.isPaused).to.be.true;

    // Attempt to stake — should fail with PoolPaused
    try {
      await stakeTokens(
        ctx,
        staker.keypair,
        staker.brainAta,
        new anchor.BN("200000000000")
      );
      expect.fail("Should have thrown PoolPaused");
    } catch (err: any) {
      expect(err.toString()).to.contain("PoolPaused");
    }
  });

  it("paused pool blocks claim — PoolPaused", async () => {
    await ensureUnpaused();

    // Create and stake before pausing
    const staker = await createStaker(ctx, BigInt(200_000_000_000));
    await stakeTokens(
      ctx,
      staker.keypair,
      staker.brainAta,
      new anchor.BN("200000000000")
    );

    // Pause the pool
    await emergencyHalt(ctx, ctx.owner, []);
    const pool = await fetchPool(ctx);
    expect(pool.isPaused).to.be.true;

    // Attempt to claim — should fail with PoolPaused
    try {
      await claimRewards(ctx, staker.keypair);
      expect.fail("Should have thrown PoolPaused");
    } catch (err: any) {
      expect(err.toString()).to.contain("PoolPaused");
    }
  });

  it("paused pool allows unstake (D008)", async () => {
    // Pool is still paused from the claim test above
    // (or ensure it's paused)
    let pool = await fetchPool(ctx);
    if (!pool.isPaused) {
      await emergencyHalt(ctx, ctx.owner, []);
    }
    pool = await fetchPool(ctx);
    expect(pool.isPaused).to.be.true;

    // Create a staker and stake BEFORE pausing — we need an active stake.
    // But pool is paused, so we need to unpause, stake, then re-pause.
    await resume(ctx, ctx.owner);

    const staker = await createStaker(ctx, BigInt(200_000_000_000));
    await stakeTokens(
      ctx,
      staker.keypair,
      staker.brainAta,
      new anchor.BN("200000000000")
    );

    // Re-pause the pool
    await emergencyHalt(ctx, ctx.owner, []);
    pool = await fetchPool(ctx);
    expect(pool.isPaused).to.be.true;

    // Unstake should succeed even while paused
    await unstakeTokens(ctx, staker.keypair, staker.brainAta);

    // Verify staker got their tokens back
    const balance = await import("@solana/spl-token").then((spl) =>
      spl.getAccount(ctx.provider.connection, staker.brainAta)
    );
    expect(Number(balance.amount)).to.equal(200_000_000_000);
  });
});
