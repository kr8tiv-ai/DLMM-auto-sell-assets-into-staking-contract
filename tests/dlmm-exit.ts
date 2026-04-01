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
  DLMM_EXIT_SEED,
  DEFAULT_MIN_STAKE,
  initiateExit,
  recordClaim,
  completeExit,
  terminateExit,
  fetchDlmmExit,
  findDlmmExit,
} from "./helpers";

describe("dlmm-exit", () => {
  let ctx: TestContext;

  // Fake pubkeys for test assets — we just need distinct keys for PDA derivation
  const assetMint1 = Keypair.generate().publicKey;
  const dlmmPool1 = Keypair.generate().publicKey;
  const position1 = Keypair.generate().publicKey;

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

    // The pool may already be initialized by brain-staking.ts (same test run).
    // Try to initialize; if the PDA already exists, catch and continue.
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
      // Pool already initialized by brain-staking.ts — that's expected.
      // Our crank keypair won't match the pool's crank, but the owner
      // is authorized for all DlmmExit operations, so tests work fine.
      // Fetch existing pool state for the brainMint field.
      const poolState = await program.account.stakingPool.fetch(stakingPool);
      brainMint = poolState.brainMint;
    }

    ctx = {
      program,
      provider,
      owner,
      crank, // may not match pool's crank if pool was pre-initialized
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

  it("initiate_exit — owner creates exit, PDA fields correct", async () => {
    await initiateExit(ctx, ctx.owner, assetMint1, dlmmPool1, position1);

    const exit = await fetchDlmmExit(ctx, assetMint1, dlmmPool1);

    expect(exit.pool.toBase58()).to.equal(ctx.stakingPool.toBase58());
    expect(exit.owner.toBase58()).to.equal(ctx.owner.publicKey.toBase58());
    expect(exit.assetMint.toBase58()).to.equal(assetMint1.toBase58());
    expect(exit.dlmmPool.toBase58()).to.equal(dlmmPool1.toBase58());
    expect(exit.position.toBase58()).to.equal(position1.toBase58());
    expect(exit.status).to.equal(0); // Active
    expect(exit.totalSolClaimed.toNumber()).to.equal(0);
    expect(exit.createdAt.toNumber()).to.be.greaterThan(0);
    expect(exit.completedAt.toNumber()).to.equal(0);
  });

  it("record_claim — owner records claim, total_sol_claimed increments", async () => {
    // Use owner (authorized as pool owner) to call record_claim
    const amount1 = new anchor.BN(1_000_000); // 0.001 SOL
    await recordClaim(ctx, ctx.owner, assetMint1, dlmmPool1, amount1);

    let exit = await fetchDlmmExit(ctx, assetMint1, dlmmPool1);
    expect(exit.totalSolClaimed.toNumber()).to.equal(1_000_000);

    // Second claim accumulates
    const amount2 = new anchor.BN(2_500_000);
    await recordClaim(ctx, ctx.owner, assetMint1, dlmmPool1, amount2);

    exit = await fetchDlmmExit(ctx, assetMint1, dlmmPool1);
    expect(exit.totalSolClaimed.toNumber()).to.equal(3_500_000);
    expect(exit.status).to.equal(0); // still Active
  });

  it("complete_exit — owner completes exit, status=1 and completed_at set", async () => {
    await completeExit(ctx, ctx.owner, assetMint1, dlmmPool1);

    const exit = await fetchDlmmExit(ctx, assetMint1, dlmmPool1);
    expect(exit.status).to.equal(1); // Completed
    expect(exit.completedAt.toNumber()).to.be.greaterThan(0);
    expect(exit.totalSolClaimed.toNumber()).to.equal(3_500_000); // preserved
  });

  it("terminate_exit — owner terminates an Active exit, status=2", async () => {
    // Need a fresh exit to terminate
    const assetMintTerm = Keypair.generate().publicKey;
    const dlmmPoolTerm = Keypair.generate().publicKey;
    const positionTerm = Keypair.generate().publicKey;

    await initiateExit(ctx, ctx.owner, assetMintTerm, dlmmPoolTerm, positionTerm);

    let exit = await fetchDlmmExit(ctx, assetMintTerm, dlmmPoolTerm);
    expect(exit.status).to.equal(0); // Active

    await terminateExit(ctx, ctx.owner, assetMintTerm, dlmmPoolTerm);

    exit = await fetchDlmmExit(ctx, assetMintTerm, dlmmPoolTerm);
    expect(exit.status).to.equal(2); // Terminated
    expect(exit.completedAt.toNumber()).to.be.greaterThan(0);
  });

  // ─── Multiple concurrent exits (R009) ─────────────────────────

  it("multiple concurrent exits — 3 independent exits with status=0", async () => {
    const exits: { mint: PublicKey; pool: PublicKey; pos: PublicKey }[] = [];

    for (let i = 0; i < 3; i++) {
      const mint = Keypair.generate().publicKey;
      const pool = Keypair.generate().publicKey;
      const pos = Keypair.generate().publicKey;
      exits.push({ mint, pool, pos });

      await initiateExit(ctx, ctx.owner, mint, pool, pos);
    }

    // Verify all three exist independently with Active status
    for (const e of exits) {
      const exit = await fetchDlmmExit(ctx, e.mint, e.pool);
      expect(exit.status).to.equal(0);
      expect(exit.assetMint.toBase58()).to.equal(e.mint.toBase58());
      expect(exit.dlmmPool.toBase58()).to.equal(e.pool.toBase58());
      expect(exit.position.toBase58()).to.equal(e.pos.toBase58());
      expect(exit.totalSolClaimed.toNumber()).to.equal(0);
    }
  });

  // ─── Error cases ───────────────────────────────────────────────

  it("error: non-owner initiate_exit → Unauthorized", async () => {
    const randomWallet = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(
      randomWallet.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(sig, "confirmed");

    const mint = Keypair.generate().publicKey;
    const pool = Keypair.generate().publicKey;
    const pos = Keypair.generate().publicKey;

    try {
      await initiateExit(ctx, randomWallet, mint, pool, pos);
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.toString()).to.contain("Unauthorized");
    }
  });

  it("error: non-owner terminate_exit → Unauthorized", async () => {
    // Create an exit to attempt termination on
    const mint = Keypair.generate().publicKey;
    const pool = Keypair.generate().publicKey;
    const pos = Keypair.generate().publicKey;

    await initiateExit(ctx, ctx.owner, mint, pool, pos);

    // Random wallet (not owner) tries to terminate — should fail
    const randomWallet = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(
      randomWallet.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(sig, "confirmed");

    try {
      await terminateExit(ctx, randomWallet, mint, pool);
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.toString()).to.contain("Unauthorized");
    }
  });

  it("error: record_claim on completed exit → ExitNotActive", async () => {
    // Use the exit we completed earlier (assetMint1/dlmmPool1 — status=1)
    try {
      await recordClaim(
        ctx,
        ctx.owner,
        assetMint1,
        dlmmPool1,
        new anchor.BN(100)
      );
      expect.fail("Should have thrown ExitNotActive");
    } catch (err: any) {
      expect(err.toString()).to.contain("ExitNotActive");
    }
  });

  it("error: complete_exit on terminated exit → ExitNotActive", async () => {
    // Create and terminate an exit
    const mint = Keypair.generate().publicKey;
    const pool = Keypair.generate().publicKey;
    const pos = Keypair.generate().publicKey;

    await initiateExit(ctx, ctx.owner, mint, pool, pos);
    await terminateExit(ctx, ctx.owner, mint, pool);

    // Try completing the terminated exit
    try {
      await completeExit(ctx, ctx.owner, mint, pool);
      expect.fail("Should have thrown ExitNotActive");
    } catch (err: any) {
      expect(err.toString()).to.contain("ExitNotActive");
    }
  });

  it("error: random wallet record_claim → Unauthorized", async () => {
    // Create a fresh exit
    const mint = Keypair.generate().publicKey;
    const pool = Keypair.generate().publicKey;
    const pos = Keypair.generate().publicKey;

    await initiateExit(ctx, ctx.owner, mint, pool, pos);

    const randomWallet = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(
      randomWallet.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(sig, "confirmed");

    try {
      await recordClaim(ctx, randomWallet, mint, pool, new anchor.BN(500));
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.toString()).to.contain("Unauthorized");
    }
  });

  it("error: duplicate initiate_exit → anchor init constraint error", async () => {
    // assetMint1/dlmmPool1 already has an exit account from the first test
    try {
      await initiateExit(ctx, ctx.owner, assetMint1, dlmmPool1, position1);
      expect.fail("Should have thrown — PDA already initialized");
    } catch (err: any) {
      // Anchor init constraint produces a "custom program error" or
      // account-already-in-use / already been created error
      const msg = err.toString().toLowerCase();
      expect(
        msg.includes("already in use") ||
          msg.includes("already been created") ||
          msg.includes("constraint") ||
          msg.includes("0x0") // account already initialized
      ).to.be.true;
    }
  });
});
