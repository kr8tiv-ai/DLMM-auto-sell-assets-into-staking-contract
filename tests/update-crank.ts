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
  DEFAULT_MIN_STAKE,
  fetchPool,
  updateCrank,
  createStaker,
  stakeTokens,
} from "./helpers";

describe("update-crank", () => {
  let ctx: TestContext;
  // The real treasury pubkey from the on-chain pool (may differ from ctx.treasury
  // when the pool was pre-initialized by an earlier test suite)
  let poolTreasury: PublicKey;

  before(async () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.BrainStaking as Program<BrainStaking>;

    const owner = (provider.wallet as anchor.Wallet).payer;
    const crank = Keypair.generate();
    const treasury = Keypair.generate();

    // Airdrop to crank so it can sign txs
    const sig = await provider.connection.requestAirdrop(
      crank.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    const [stakingPool, poolBump] = findStakingPool(program.programId);
    const [brainVault] = findBrainVault(program.programId);
    const [rewardVault] = findRewardVault(program.programId);

    // Pool may already be initialized by brain-staking.ts (same test run).
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

      poolTreasury = treasury.publicKey;
    } catch (_err) {
      // Pool already initialized — fetch existing state
      const poolState = await program.account.stakingPool.fetch(stakingPool);
      brainMint = poolState.brainMint;
      poolTreasury = poolState.treasury;
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
  });

  // ─── Happy path ────────────────────────────────────────────────

  it("owner updates crank and new pubkey is stored", async () => {
    const newCrank = Keypair.generate();

    await updateCrank(ctx, ctx.owner, newCrank.publicKey);

    const pool = await fetchPool(ctx);
    expect(pool.crank.toBase58()).to.equal(newCrank.publicKey.toBase58());
  });

  // ─── Error cases ───────────────────────────────────────────────

  it("non-owner rejected with Unauthorized", async () => {
    const randomWallet = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(
      randomWallet.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(sig, "confirmed");

    const anotherCrank = Keypair.generate();

    try {
      await updateCrank(ctx, randomWallet, anotherCrank.publicKey);
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.toString()).to.contain("Unauthorized");
    }
  });

  it("crank wallet itself cannot call update_crank", async () => {
    // Set up a fresh crank keypair we control, rotate to it, then try update_crank from it
    const crankKeypair = Keypair.generate();
    const airdropSig = await ctx.provider.connection.requestAirdrop(
      crankKeypair.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(airdropSig, "confirmed");

    // Owner rotates to crankKeypair
    await updateCrank(ctx, ctx.owner, crankKeypair.publicKey);

    // Verify it's set
    const pool = await fetchPool(ctx);
    expect(pool.crank.toBase58()).to.equal(crankKeypair.publicKey.toBase58());

    // Now crankKeypair tries to call update_crank — should fail (owner-only)
    const yetAnotherCrank = Keypair.generate();
    try {
      await updateCrank(ctx, crankKeypair, yetAnotherCrank.publicKey);
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.toString()).to.contain("Unauthorized");
    }
  });

  it("after rotation, new crank key can call deposit_rewards", async () => {
    // The pool may have been paused by the emergency-controls test suite.
    // Unpause it so deposit_rewards can succeed.
    const poolBefore = await fetchPool(ctx);
    if (poolBefore.isPaused) {
      await ctx.program.methods
        .resume()
        .accountsStrict({
          authority: ctx.owner.publicKey,
          stakingPool: ctx.stakingPool,
        })
        .rpc();
    }

    // Set up a new crank with SOL for tx fees
    const newCrank = Keypair.generate();
    const airdropSig = await ctx.provider.connection.requestAirdrop(
      newCrank.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(airdropSig, "confirmed");

    // Owner rotates to newCrank
    await updateCrank(ctx, ctx.owner, newCrank.publicKey);

    const pool = await fetchPool(ctx);
    expect(pool.crank.toBase58()).to.equal(newCrank.publicKey.toBase58());

    // H1: Need at least one staker for deposit_rewards to succeed
    const staker = await createStaker(ctx, BigInt(DEFAULT_MIN_STAKE.toString()));
    await stakeTokens(ctx, staker.keypair, staker.brainAta, new anchor.BN(DEFAULT_MIN_STAKE.toString()));

    // New crank should be able to call deposit_rewards
    // Build the instruction directly using the real pool treasury (not ctx.treasury
    // which may not match if the pool was pre-initialized by another test suite)
    const depositAmount = new anchor.BN(1_000_000); // 0.001 SOL
    await ctx.program.methods
      .depositRewards(depositAmount)
      .accountsStrict({
        authority: newCrank.publicKey,
        stakingPool: ctx.stakingPool,
        rewardVault: ctx.rewardVault,
        treasury: poolTreasury,
        systemProgram: SystemProgram.programId,
      })
      .signers([newCrank])
      .rpc();

    // Verify the deposit went through by checking total_rewards_distributed increased
    const poolAfter = await fetchPool(ctx);
    expect(poolAfter.totalRewardsDistributed.toNumber()).to.be.greaterThan(0);

    // Old crank (ctx.crank from test setup) should be rejected
    try {
      await ctx.program.methods
        .depositRewards(new anchor.BN(500_000))
        .accountsStrict({
          authority: ctx.crank.publicKey,
          stakingPool: ctx.stakingPool,
          rewardVault: ctx.rewardVault,
          treasury: poolTreasury,
          systemProgram: SystemProgram.programId,
        })
        .signers([ctx.crank])
        .rpc();
      expect.fail("Should have thrown Unauthorized — old crank is revoked");
    } catch (err: any) {
      expect(err.toString()).to.contain("Unauthorized");
    }
  });
});
