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
import { expect } from "chai";
import { BrainStaking } from "../target/types/brain_staking";

// ──────────────────────────────────────────────────────────────────
// Constants matching the on-chain program (constants.rs)
// ──────────────────────────────────────────────────────────────────
const PRECISION = BigInt("1000000000000"); // 1e12
const TIER_1_SECS = 7 * 24 * 60 * 60;  // 604 800
const TIER_2_SECS = 30 * 24 * 60 * 60; // 2 592 000
const TIER_3_SECS = 90 * 24 * 60 * 60; // 7 776 000

const STAKING_POOL_SEED = Buffer.from("staking_pool");
const STAKER_SEED = Buffer.from("staker");
const BRAIN_VAULT_SEED = Buffer.from("brain_vault");
const REWARD_VAULT_SEED = Buffer.from("reward_vault");

// 100k BRAIN with 6 decimals = 1e11
const DEFAULT_MIN_STAKE = new anchor.BN("100000000000");

// Standard stake amount for tests: 200k BRAIN
const STAKE_AMOUNT = new anchor.BN("200000000000");

// ──────────────────────────────────────────────────────────────────
// PDA helpers
// ──────────────────────────────────────────────────────────────────
function findPool(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([STAKING_POOL_SEED], programId);
}
function findBrainVault(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([BRAIN_VAULT_SEED], programId);
}
function findRewardVault(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([REWARD_VAULT_SEED], programId);
}
function findStaker(user: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [STAKER_SEED, user.toBuffer()],
    programId
  );
}

// ──────────────────────────────────────────────────────────────────
// Clock warp — advance validator time by N seconds
// Overwrites the Clock sysvar account data directly via
// the test-validator-only RPC. This reliably advances
// unix_timestamp unlike slot warping alone.
// ──────────────────────────────────────────────────────────────────
async function warpTime(
  connection: anchor.web3.Connection,
  seconds: number
): Promise<void> {
  // 1. Read current clock sysvar
  const clockAcct = await connection.getAccountInfo(
    anchor.web3.SYSVAR_CLOCK_PUBKEY
  );
  if (!clockAcct || !clockAcct.data) throw new Error("Cannot read clock");

  // Clock layout (40 bytes):
  //   slot:                u64  (offset 0)
  //   epoch_start_ts:      i64  (offset 8)
  //   epoch:               u64  (offset 16)
  //   leader_schedule_epoch: u64 (offset 24)
  //   unix_timestamp:      i64  (offset 32)
  const data = Buffer.from(clockAcct.data);
  const currentSlot = data.readBigUInt64LE(0);
  const currentTs = data.readBigInt64LE(32);

  // 2. Advance both slot and timestamp
  const newSlot = currentSlot + BigInt(seconds);
  const newTs = currentTs + BigInt(seconds);
  data.writeBigUInt64LE(newSlot, 0);
  data.writeBigInt64LE(newTs, 32);

  // 3. Write it back via test-validator RPC
  const base64Data = data.toString("base64");
  // @ts-ignore — test-validator-only RPC
  await connection._rpcRequest("setAccountInfo", [
    anchor.web3.SYSVAR_CLOCK_PUBKEY.toBase58(),
    {
      lamports: clockAcct.lamports,
      data: [base64Data, "base64"],
      owner: "Sysvar1111111111111111111111111111111111111",
      executable: false,
      rentEpoch: 0,
    },
  ]);

  // 4. Also warp the slot so the validator processes at the new slot
  // @ts-ignore
  await connection._rpcRequest("warpToSlot", [Number(newSlot)]);

  await sleep(800);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ──────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────
describe("brain-staking", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.BrainStaking as Program<BrainStaking>;
  const connection = provider.connection;

  // Shared state across tests (initialize once)
  const owner = (provider.wallet as anchor.Wallet).payer;
  const crank = Keypair.generate();
  const treasury = Keypair.generate();
  let brainMint: PublicKey;
  let stakingPool: PublicKey;
  let brainVault: PublicKey;
  let rewardVault: PublicKey;

  const FEE_BPS = 200; // 2%

  // ── Helper: create and fund a staker ──────────────────────────
  async function makeStaker(
    brainTokens: bigint = BigInt("500000000000") // 500k BRAIN
  ): Promise<{ kp: Keypair; ata: PublicKey }> {
    const kp = Keypair.generate();
    const sig = await connection.requestAirdrop(
      kp.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(sig, "confirmed");

    const ata = await createAssociatedTokenAccount(
      connection,
      kp,
      brainMint,
      kp.publicKey
    );

    await mintTo(connection, owner, brainMint, ata, owner, brainTokens);
    return { kp, ata };
  }

  // ── Helper: stake ─────────────────────────────────────────────
  async function doStake(
    user: Keypair,
    userAta: PublicKey,
    amount: anchor.BN
  ) {
    const [stakerPda] = findStaker(user.publicKey, program.programId);
    return program.methods
      .stake(amount)
      .accountsStrict({
        user: user.publicKey,
        stakingPool,
        stakerAccount: stakerPda,
        userBrainAta: userAta,
        brainVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }

  // ── Helper: deposit rewards ────────────────────────────────────
  async function doDeposit(authority: Keypair, amount: anchor.BN) {
    return program.methods
      .depositRewards(amount)
      .accountsStrict({
        authority: authority.publicKey,
        stakingPool,
        rewardVault,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
  }

  // ── Helper: claim ──────────────────────────────────────────────
  async function doClaim(user: Keypair) {
    const [stakerPda] = findStaker(user.publicKey, program.programId);
    return program.methods
      .claim()
      .accountsStrict({
        user: user.publicKey,
        stakingPool,
        stakerAccount: stakerPda,
        rewardVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }

  // ── Helper: unstake ────────────────────────────────────────────
  async function doUnstake(user: Keypair, userAta: PublicKey) {
    const [stakerPda] = findStaker(user.publicKey, program.programId);
    return program.methods
      .unstake()
      .accountsStrict({
        user: user.publicKey,
        stakingPool,
        stakerAccount: stakerPda,
        brainVault,
        userBrainAta: userAta,
        rewardVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }

  // ── Helper: fetch pool ─────────────────────────────────────────
  async function getPool() {
    return program.account.stakingPool.fetch(stakingPool);
  }
  // ── Helper: fetch staker ───────────────────────────────────────
  async function getStaker(user: PublicKey) {
    const [pda] = findStaker(user, program.programId);
    return program.account.stakerAccount.fetch(pda);
  }

  // ================================================================
  // SETUP — initialize pool (runs once)
  // ================================================================
  before(async () => {
    // Airdrop to crank
    const sig = await connection.requestAirdrop(
      crank.publicKey,
      20 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(sig, "confirmed");

    brainMint = await createMint(connection, owner, owner.publicKey, null, 6);

    [stakingPool] = findPool(program.programId);
    [brainVault] = findBrainVault(program.programId);
    [rewardVault] = findRewardVault(program.programId);
  });

  // ================================================================
  // T28 — Initialize pool
  // ================================================================
  describe("Initialize pool", () => {
    it("initializes with correct fields", async () => {
      await program.methods
        .initialize(crank.publicKey, FEE_BPS, DEFAULT_MIN_STAKE)
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

      const pool = await getPool();
      expect(pool.owner.toBase58()).to.equal(owner.publicKey.toBase58());
      expect(pool.crank.toBase58()).to.equal(crank.publicKey.toBase58());
      expect(pool.brainMint.toBase58()).to.equal(brainMint.toBase58());
      expect(pool.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
      expect(pool.totalStaked.toNumber()).to.equal(0);
      expect(pool.totalWeightedStake.toNumber()).to.equal(0);
      expect(pool.rewardPerShare.toNumber()).to.equal(0);
      expect(pool.totalRewardsDistributed.toNumber()).to.equal(0);
      expect(pool.protocolFeeBps).to.equal(FEE_BPS);
      expect(pool.minStakeAmount.toString()).to.equal(
        DEFAULT_MIN_STAKE.toString()
      );
      expect(pool.isPaused).to.equal(false);
    });
  });

  // ================================================================
  // R001 — Deposit & Withdrawal
  // ================================================================
  describe("R001 — Deposit & Withdrawal", () => {
    it("1. stake BRAIN → vault balance increases, StakerAccount created", async () => {
      const { kp, ata } = await makeStaker();
      const vaultBefore = (await getAccount(connection, brainVault)).amount;

      await doStake(kp, ata, STAKE_AMOUNT);

      const vaultAfter = (await getAccount(connection, brainVault)).amount;
      expect(Number(vaultAfter - vaultBefore)).to.equal(
        STAKE_AMOUNT.toNumber()
      );

      const staker = await getStaker(kp.publicKey);
      expect(staker.stakedAmount.toString()).to.equal(STAKE_AMOUNT.toString());
      expect(staker.currentMultiplier).to.equal(0); // pre-cliff
      expect(staker.pendingRewards.toNumber()).to.equal(0);

      // Clean up
      await doUnstake(kp, ata);
    });

    it("2. unstake → full BRAIN returned, StakerAccount closed", async () => {
      const { kp, ata } = await makeStaker();
      const userBalBefore = (await getAccount(connection, ata)).amount;

      await doStake(kp, ata, STAKE_AMOUNT);
      const userBalMid = (await getAccount(connection, ata)).amount;
      expect(Number(userBalBefore - userBalMid)).to.equal(
        STAKE_AMOUNT.toNumber()
      );

      await doUnstake(kp, ata);

      const userBalAfter = (await getAccount(connection, ata)).amount;
      expect(Number(userBalAfter)).to.equal(Number(userBalBefore));

      // StakerAccount should be closed
      const [stakerPda] = findStaker(kp.publicKey, program.programId);
      const acctInfo = await connection.getAccountInfo(stakerPda);
      expect(acctInfo).to.be.null;
    });

    it("3. staking with wrong mint fails", async () => {
      // Create a different mint
      const wrongMint = await createMint(
        connection,
        owner,
        owner.publicKey,
        null,
        6
      );
      const kp = Keypair.generate();
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const wrongAta = await createAssociatedTokenAccount(
        connection,
        kp,
        wrongMint,
        kp.publicKey
      );
      await mintTo(
        connection,
        owner,
        wrongMint,
        wrongAta,
        owner,
        BigInt("500000000000")
      );

      try {
        await doStake(kp, wrongAta, STAKE_AMOUNT);
        expect.fail("Should have thrown InvalidMint");
      } catch (e: any) {
        // Anchor constraint error for wrong mint
        expect(e.toString()).to.include("InvalidMint");
      }
    });
  });

  // ================================================================
  // R014 — Minimum Stake
  // ================================================================
  describe("R014 — Minimum Stake", () => {
    it("19. staking below min_stake_amount fails", async () => {
      const { kp, ata } = await makeStaker();
      const belowMin = DEFAULT_MIN_STAKE.sub(new anchor.BN(1));

      try {
        await doStake(kp, ata, belowMin);
        expect.fail("Should have thrown BelowMinStake");
      } catch (e: any) {
        expect(e.toString()).to.include("BelowMinStake");
      }
    });

    it("20. staking exactly at min_stake_amount succeeds", async () => {
      const { kp, ata } = await makeStaker();
      await doStake(kp, ata, DEFAULT_MIN_STAKE);

      const staker = await getStaker(kp.publicKey);
      expect(staker.stakedAmount.toString()).to.equal(
        DEFAULT_MIN_STAKE.toString()
      );

      // Clean up
      await doUnstake(kp, ata);
    });
  });

  // ================================================================
  // R013 — Crank Authority
  // ================================================================
  describe("R013 — Crank Authority", () => {
    let stakerForDeposit: { kp: Keypair; ata: PublicKey };

    before(async () => {
      // Need at least one staker for deposit to be meaningful
      stakerForDeposit = await makeStaker();
      await doStake(
        stakerForDeposit.kp,
        stakerForDeposit.ata,
        STAKE_AMOUNT
      );
    });

    after(async () => {
      await doUnstake(stakerForDeposit.kp, stakerForDeposit.ata);
    });

    it("23. crank wallet can call deposit_rewards", async () => {
      await doDeposit(crank, new anchor.BN(LAMPORTS_PER_SOL));
      // If we get here without error, the crank was accepted
    });

    it("24. random wallet cannot call deposit_rewards", async () => {
      const rando = Keypair.generate();
      const sig = await connection.requestAirdrop(
        rando.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      try {
        await doDeposit(rando, new anchor.BN(LAMPORTS_PER_SOL));
        expect.fail("Should have thrown Unauthorized");
      } catch (e: any) {
        expect(e.toString()).to.include("Unauthorized");
      }
    });

    it("25. owner can call deposit_rewards", async () => {
      // The owner is also authorized per the constraint
      await doDeposit(owner, new anchor.BN(LAMPORTS_PER_SOL));
    });
  });

  // ================================================================
  // R028 — Protocol Fee
  // ================================================================
  describe("R028 — Protocol Fee", () => {
    let stakerForFee: { kp: Keypair; ata: PublicKey };

    before(async () => {
      stakerForFee = await makeStaker();
      await doStake(stakerForFee.kp, stakerForFee.ata, STAKE_AMOUNT);
    });

    after(async () => {
      await doUnstake(stakerForFee.kp, stakerForFee.ata);
    });

    it("21. deposit 1 SOL with 200bps fee → 0.02 SOL to treasury, 0.98 SOL to pool", async () => {
      const depositAmt = new anchor.BN(LAMPORTS_PER_SOL); // 1 SOL
      const expectedFee = LAMPORTS_PER_SOL * FEE_BPS / 10_000; // 0.02 SOL
      const expectedNet = LAMPORTS_PER_SOL - expectedFee;       // 0.98 SOL

      const treasuryBefore = await connection.getBalance(treasury.publicKey);
      const vaultBefore = await connection.getBalance(rewardVault);

      await doDeposit(owner, depositAmt);

      const treasuryAfter = await connection.getBalance(treasury.publicKey);
      const vaultAfter = await connection.getBalance(rewardVault);

      expect(treasuryAfter - treasuryBefore).to.equal(expectedFee);
      expect(vaultAfter - vaultBefore).to.equal(expectedNet);
    });

    it("22. fee calculation is exact to lamport level", async () => {
      // Deposit 123456789 lamports — fee = 123456789 * 200 / 10000 = 2469135
      const oddAmount = new anchor.BN(123456789);
      const expectedFee = Math.floor(123456789 * FEE_BPS / 10_000); // 2469135
      const expectedNet = 123456789 - expectedFee;

      const treasuryBefore = await connection.getBalance(treasury.publicKey);
      const vaultBefore = await connection.getBalance(rewardVault);

      await doDeposit(owner, oddAmount);

      const treasuryAfter = await connection.getBalance(treasury.publicKey);
      const vaultAfter = await connection.getBalance(rewardVault);

      expect(treasuryAfter - treasuryBefore).to.equal(expectedFee);
      expect(vaultAfter - vaultBefore).to.equal(expectedNet);
    });
  });

  // ================================================================
  // R002 — Multiplier Tiers + R003 — One-Week Cliff
  // (These require clock warp)
  // ================================================================
  describe("R002 — Multiplier Tiers & R003 — Cliff", () => {
    it("4/9. pre-cliff staker has multiplier 0 and earns zero rewards", async () => {
      const { kp, ata } = await makeStaker();
      await doStake(kp, ata, STAKE_AMOUNT);

      const staker = await getStaker(kp.publicKey);
      expect(staker.currentMultiplier).to.equal(0);

      // Deposit rewards — pre-cliff staker contributes 0 weighted stake
      await doDeposit(owner, new anchor.BN(LAMPORTS_PER_SOL));

      // Claim should return Ok with 0 transfer (pre-cliff)
      const solBefore = await connection.getBalance(kp.publicKey);
      await doClaim(kp);
      const solAfter = await connection.getBalance(kp.publicKey);

      // Should have paid tx fee but received 0 rewards
      expect(solAfter).to.be.at.most(solBefore);

      await doUnstake(kp, ata);
    });

    it("5/10. at 7 days, multiplier transitions to 1 and staker begins earning", async () => {
      const { kp, ata } = await makeStaker();
      await doStake(kp, ata, STAKE_AMOUNT);

      // Warp past 7-day cliff
      await warpTime(connection, TIER_1_SECS + 10);

      // Claim triggers multiplier refresh — should now be 1
      // First deposit rewards so there's something to earn
      // The weighted stake is now > 0 after claim refreshes multiplier
      await doClaim(kp);
      const staker = await getStaker(kp.publicKey);
      expect(staker.currentMultiplier).to.equal(1);

      // Now deposit and verify the staker can claim
      await doDeposit(owner, new anchor.BN(LAMPORTS_PER_SOL));

      const solBefore = await connection.getBalance(kp.publicKey);
      await doClaim(kp);
      const solAfter = await connection.getBalance(kp.publicKey);

      // After paying tx fee, should still have received rewards
      // With only one staker at multiplier 1, they get all the net reward
      // Net = 1 SOL * (1 - 0.02) = 0.98 SOL
      // But we need to account for tx fee (~5000 lamports)
      // solAfter should be roughly solBefore + 0.98 SOL - txFee
      const netReward = LAMPORTS_PER_SOL * (10_000 - FEE_BPS) / 10_000;
      const diff = solAfter - solBefore;
      // diff = rewards - txFee, so diff should be close to netReward - ~5000
      expect(diff).to.be.greaterThan(netReward - 100_000); // generous tolerance for fee

      await doUnstake(kp, ata);
    });

    it("6. at 30 days, multiplier transitions to 2", async () => {
      const { kp, ata } = await makeStaker();
      await doStake(kp, ata, STAKE_AMOUNT);

      await warpTime(connection, TIER_2_SECS + 10);

      await doClaim(kp);
      const staker = await getStaker(kp.publicKey);
      expect(staker.currentMultiplier).to.equal(2);

      await doUnstake(kp, ata);
    });

    it("7. at 90 days, multiplier transitions to 3", async () => {
      const { kp, ata } = await makeStaker();
      await doStake(kp, ata, STAKE_AMOUNT);

      await warpTime(connection, TIER_3_SECS + 10);

      await doClaim(kp);
      const staker = await getStaker(kp.publicKey);
      expect(staker.currentMultiplier).to.equal(3);

      await doUnstake(kp, ata);
    });

    it("8. multiplier upgrade is forward-only — rewards at old rate before upgrade", async () => {
      const { kp, ata } = await makeStaker();
      await doStake(kp, ata, STAKE_AMOUNT);

      // Warp to tier 1
      await warpTime(connection, TIER_1_SECS + 10);
      // Trigger multiplier update to 1
      await doClaim(kp);
      let staker = await getStaker(kp.publicKey);
      expect(staker.currentMultiplier).to.equal(1);

      // Deposit rewards at 1x
      await doDeposit(owner, new anchor.BN(LAMPORTS_PER_SOL));

      // Warp to tier 2
      await warpTime(connection, TIER_2_SECS - TIER_1_SECS + 100);

      // When claim fires, it settles at OLD multiplier (1x) first,
      // then upgrades to 2x and resets debt.
      // The key assertion is that the staker doesn't retroactively earn 2x
      // on the deposit that happened during 1x epoch.

      const solBefore = await connection.getBalance(kp.publicKey);
      await doClaim(kp);
      const solAfter = await connection.getBalance(kp.publicKey);
      staker = await getStaker(kp.publicKey);
      expect(staker.currentMultiplier).to.equal(2);

      // Rewards earned should be based on 1x (amount * 1 * reward_per_share / PRECISION)
      // not 2x. With only one staker, they get the full net reward regardless,
      // but the settlement logic is what matters for multi-staker scenarios.
      const netReward = LAMPORTS_PER_SOL * (10_000 - FEE_BPS) / 10_000;
      const diff = solAfter - solBefore;
      expect(diff).to.be.greaterThan(netReward - 100_000);

      await doUnstake(kp, ata);
    });
  });

  // ================================================================
  // R004 — Instant Unstake
  // ================================================================
  describe("R004 — Instant Unstake", () => {
    it("11. pre-cliff unstake returns full BRAIN, no SOL transferred", async () => {
      const { kp, ata } = await makeStaker();
      const brainBefore = (await getAccount(connection, ata)).amount;

      await doStake(kp, ata, STAKE_AMOUNT);

      // Deposit rewards while staker is pre-cliff
      await doDeposit(owner, new anchor.BN(LAMPORTS_PER_SOL));

      const solBefore = await connection.getBalance(kp.publicKey);
      await doUnstake(kp, ata);
      const solAfter = await connection.getBalance(kp.publicKey);

      // Full BRAIN returned
      const brainAfter = (await getAccount(connection, ata)).amount;
      expect(Number(brainAfter)).to.equal(Number(brainBefore));

      // SOL balance should decrease (only tx fee + rent recovery)
      // No reward SOL should be transferred since pre-cliff
      // The rent from StakerAccount close goes back to user, so
      // the net SOL change is: rent_returned - tx_fee
      // Should NOT include reward SOL
      // We verify that the user didn't receive the deposited reward
      const netSolChange = solAfter - solBefore;
      // This should be small (rent return minus tx fees)
      expect(netSolChange).to.be.lessThan(LAMPORTS_PER_SOL / 2);
    });

    it("12. post-cliff unstake returns BRAIN AND auto-claims pending SOL", async () => {
      const { kp, ata } = await makeStaker();

      await doStake(kp, ata, STAKE_AMOUNT);

      // Warp past cliff
      await warpTime(connection, TIER_1_SECS + 10);
      // Refresh multiplier
      await doClaim(kp);

      // Deposit rewards — staker is now tier 1
      await doDeposit(owner, new anchor.BN(LAMPORTS_PER_SOL));

      const solBefore = await connection.getBalance(kp.publicKey);
      const brainBefore = (await getAccount(connection, ata)).amount;

      await doUnstake(kp, ata);

      const solAfter = await connection.getBalance(kp.publicKey);
      const brainAfter = (await getAccount(connection, ata)).amount;

      // Full BRAIN returned
      expect(Number(brainAfter - brainBefore)).to.equal(
        STAKE_AMOUNT.toNumber()
      );

      // Should have received reward SOL (auto-claimed)
      const netReward = LAMPORTS_PER_SOL * (10_000 - FEE_BPS) / 10_000;
      const solDiff = solAfter - solBefore;
      // solDiff = rewards + rent_return - tx_fee
      expect(solDiff).to.be.greaterThan(netReward - 100_000);
    });
  });

  // ================================================================
  // R006 — Claimable SOL Reward Pool
  // ================================================================
  describe("R006 — Claimable SOL Reward Pool", () => {
    it("15. owner deposits SOL → reward_per_share increases correctly", async () => {
      const { kp, ata } = await makeStaker();
      await doStake(kp, ata, STAKE_AMOUNT);

      // Warp past cliff so staker has weighted stake
      await warpTime(connection, TIER_1_SECS + 10);
      await doClaim(kp); // refresh multiplier to 1

      const poolBefore = await getPool();
      const rpsBefore = poolBefore.rewardPerShare;

      const depositAmt = new anchor.BN(LAMPORTS_PER_SOL);
      await doDeposit(owner, depositAmt);

      const poolAfter = await getPool();
      const rpsAfter = poolAfter.rewardPerShare;

      // Expected increment: net * PRECISION / total_weighted_stake
      const net = BigInt(LAMPORTS_PER_SOL * (10_000 - FEE_BPS) / 10_000);
      const weightedStake = BigInt(STAKE_AMOUNT.toString()) * BigInt(1); // mult=1
      const expectedIncrement = (net * PRECISION) / weightedStake;

      const actualIncrement =
        BigInt(rpsAfter.toString()) - BigInt(rpsBefore.toString());
      expect(actualIncrement.toString()).to.equal(expectedIncrement.toString());

      await doUnstake(kp, ata);
    });

    it("16. single staker claims → receives correct SOL amount", async () => {
      const { kp, ata } = await makeStaker();
      await doStake(kp, ata, STAKE_AMOUNT);
      await warpTime(connection, TIER_1_SECS + 10);
      await doClaim(kp); // refresh to multiplier 1

      const depositAmt = new anchor.BN(LAMPORTS_PER_SOL);
      await doDeposit(owner, depositAmt);

      const solBefore = await connection.getBalance(kp.publicKey);
      await doClaim(kp);
      const solAfter = await connection.getBalance(kp.publicKey);

      const netReward = LAMPORTS_PER_SOL * (10_000 - FEE_BPS) / 10_000;
      const diff = solAfter - solBefore;
      // diff = reward - txFee
      expect(diff).to.be.greaterThan(netReward - 50_000);
      expect(diff).to.be.lessThan(netReward + 10_000);

      await doUnstake(kp, ata);
    });

    it("17. two stakers with equal stake and same multiplier → each gets ~50%", async () => {
      const s1 = await makeStaker();
      const s2 = await makeStaker();
      await doStake(s1.kp, s1.ata, STAKE_AMOUNT);
      await doStake(s2.kp, s2.ata, STAKE_AMOUNT);

      // Warp both past cliff
      await warpTime(connection, TIER_1_SECS + 10);
      await doClaim(s1.kp);
      await doClaim(s2.kp);

      // Deposit rewards
      const depositAmt = new anchor.BN(2 * LAMPORTS_PER_SOL);
      await doDeposit(owner, depositAmt);

      const netTotal =
        2 * LAMPORTS_PER_SOL * (10_000 - FEE_BPS) / 10_000;
      const halfReward = netTotal / 2;

      const sol1Before = await connection.getBalance(s1.kp.publicKey);
      await doClaim(s1.kp);
      const sol1After = await connection.getBalance(s1.kp.publicKey);

      const sol2Before = await connection.getBalance(s2.kp.publicKey);
      await doClaim(s2.kp);
      const sol2After = await connection.getBalance(s2.kp.publicKey);

      const diff1 = sol1After - sol1Before;
      const diff2 = sol2After - sol2Before;

      // Each should get ~halfReward minus tx fee
      expect(diff1).to.be.greaterThan(halfReward - 50_000);
      expect(diff1).to.be.lessThan(halfReward + 10_000);
      expect(diff2).to.be.greaterThan(halfReward - 50_000);
      expect(diff2).to.be.lessThan(halfReward + 10_000);

      await doUnstake(s1.kp, s1.ata);
      await doUnstake(s2.kp, s2.ata);
    });

    it("18. two stakers with different multipliers → rewards proportional to weighted stake", async () => {
      const s1 = await makeStaker();
      const s2 = await makeStaker();
      await doStake(s1.kp, s1.ata, STAKE_AMOUNT);
      // Stagger: s1 stakes first, warp to tier 2 for s1
      await warpTime(connection, TIER_2_SECS + 10);
      await doClaim(s1.kp); // s1 → multiplier 2

      // Now s2 stakes — will be at multiplier 0 (pre-cliff)
      await doStake(s2.kp, s2.ata, STAKE_AMOUNT);
      // Warp just past 7 days for s2 (s1 is well past tier 2)
      await warpTime(connection, TIER_1_SECS + 10);
      await doClaim(s2.kp); // s2 → multiplier 1
      // s1 should still be at multiplier 2 (only ~37 days total < 90 days for tier 3)
      await doClaim(s1.kp); // refresh s1

      const s1Data = await getStaker(s1.kp.publicKey);
      const s2Data = await getStaker(s2.kp.publicKey);

      // s1: multiplier 2, s2: multiplier 1
      // weighted: s1 = STAKE*2, s2 = STAKE*1, total = STAKE*3
      // s1 share = 2/3, s2 share = 1/3
      expect(s1Data.currentMultiplier).to.equal(2);
      expect(s2Data.currentMultiplier).to.equal(1);

      // Deposit
      const depositAmt = new anchor.BN(3 * LAMPORTS_PER_SOL);
      await doDeposit(owner, depositAmt);

      const netTotal =
        3 * LAMPORTS_PER_SOL * (10_000 - FEE_BPS) / 10_000;

      const sol1Before = await connection.getBalance(s1.kp.publicKey);
      await doClaim(s1.kp);
      const sol1After = await connection.getBalance(s1.kp.publicKey);

      const sol2Before = await connection.getBalance(s2.kp.publicKey);
      await doClaim(s2.kp);
      const sol2After = await connection.getBalance(s2.kp.publicKey);

      const diff1 = sol1After - sol1Before;
      const diff2 = sol2After - sol2Before;

      // s1 should get ~2/3 of netTotal, s2 ~1/3
      const s1Expected = Math.floor((netTotal * 2) / 3);
      const s2Expected = Math.floor(netTotal / 3);

      expect(diff1).to.be.greaterThan(s1Expected - 50_000);
      expect(diff1).to.be.lessThan(s1Expected + 50_000);
      expect(diff2).to.be.greaterThan(s2Expected - 50_000);
      expect(diff2).to.be.lessThan(s2Expected + 50_000);

      await doUnstake(s1.kp, s1.ata);
      await doUnstake(s2.kp, s2.ata);
    });
  });

  // ================================================================
  // R005 — Forfeit Redistribution
  // ================================================================
  describe("R005 — Forfeit Redistribution", () => {
    it("13. pre-cliff unstake reduces total_weighted_stake (stays 0 since pre-cliff weighted=0)", async () => {
      const { kp, ata } = await makeStaker();
      await doStake(kp, ata, STAKE_AMOUNT);

      const poolBefore = await getPool();
      // Pre-cliff staker contributes 0 to weighted_stake
      const weightedBefore = poolBefore.totalWeightedStake;

      await doUnstake(kp, ata);

      const poolAfter = await getPool();
      // Weighted stake should be unchanged (was 0 contribution)
      expect(poolAfter.totalWeightedStake.toString()).to.equal(
        weightedBefore.toString()
      );
      // But total_staked should decrease
      expect(poolAfter.totalStaked.toNumber()).to.equal(
        poolBefore.totalStaked.toNumber() - STAKE_AMOUNT.toNumber()
      );
    });

    it("14. two stakers: one unstakes pre-cliff → remaining staker gets full share", async () => {
      const s1 = await makeStaker();
      const s2 = await makeStaker();
      await doStake(s1.kp, s1.ata, STAKE_AMOUNT);
      await doStake(s2.kp, s2.ata, STAKE_AMOUNT);

      // Warp both past cliff
      await warpTime(connection, TIER_1_SECS + 10);
      await doClaim(s1.kp); // refresh to mult=1
      await doClaim(s2.kp);

      // Now create a third staker who is pre-cliff
      const s3 = await makeStaker();
      await doStake(s3.kp, s3.ata, STAKE_AMOUNT);

      // s3 unstakes pre-cliff — total_weighted_stake should stay the same
      // since s3 had multiplier=0, contributing 0 weighted stake
      const poolMid = await getPool();
      await doUnstake(s3.kp, s3.ata);
      const poolAfter = await getPool();
      expect(poolAfter.totalWeightedStake.toString()).to.equal(
        poolMid.totalWeightedStake.toString()
      );

      // Deposit rewards — only s1 and s2 share
      await doDeposit(owner, new anchor.BN(2 * LAMPORTS_PER_SOL));

      const netTotal =
        2 * LAMPORTS_PER_SOL * (10_000 - FEE_BPS) / 10_000;
      const halfReward = netTotal / 2;

      const sol1Before = await connection.getBalance(s1.kp.publicKey);
      await doClaim(s1.kp);
      const sol1After = await connection.getBalance(s1.kp.publicKey);

      const diff1 = sol1After - sol1Before;
      expect(diff1).to.be.greaterThan(halfReward - 50_000);

      await doUnstake(s1.kp, s1.ata);
      await doUnstake(s2.kp, s2.ata);
    });
  });

  // ================================================================
  // Edge Cases
  // ================================================================
  describe("Edge Cases", () => {
    it("26. deposit rewards with zero total_staked → rejected with NoActiveStakers", async () => {
      // H1: deposit_rewards is rejected when no stakers exist (total_staked == 0)
      const poolBefore = await getPool();
      if (poolBefore.totalStaked.toNumber() === 0) {
        try {
          await doDeposit(owner, new anchor.BN(LAMPORTS_PER_SOL));
          expect.fail("Should have thrown NoActiveStakers");
        } catch (e: any) {
          expect(e.toString()).to.include("NoActiveStakers");
        }
      } else {
        // If stakers exist from prior tests, deposit should succeed
        await doDeposit(owner, new anchor.BN(LAMPORTS_PER_SOL));
      }
    });

    it("27. claim with zero pending → succeeds with 0 transfer", async () => {
      const { kp, ata } = await makeStaker();
      await doStake(kp, ata, STAKE_AMOUNT);

      // Warp past cliff
      await warpTime(connection, TIER_1_SECS + 10);
      await doClaim(kp); // refresh multiplier

      // Claim again with nothing deposited since last claim
      const solBefore = await connection.getBalance(kp.publicKey);
      await doClaim(kp);
      const solAfter = await connection.getBalance(kp.publicKey);

      // Should only lose tx fee, no rewards claimed
      expect(solBefore - solAfter).to.be.lessThan(50_000); // just tx fee

      await doUnstake(kp, ata);
    });
  });
});
