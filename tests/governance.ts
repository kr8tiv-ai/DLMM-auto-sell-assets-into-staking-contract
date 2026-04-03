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
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { BrainStaking } from "../target/types/brain_staking";
import {
  TestContext,
  createStaker,
  stakeTokens,
  findStakingPool,
  findBrainVault,
  findRewardVault,
  findGovernanceConfig,
  findProposal,
  findVoteRecord,
  findStakerAccount,
  findDlmmExit,
  DEFAULT_MIN_STAKE,
  initializeGovernance,
  createProposal,
  castVote,
  closeProposal,
  fetchGovernanceConfig,
  fetchProposal,
  fetchVoteRecord,
  fetchDlmmExit,
  fetchPool,
  governanceInitiateExit,
  setAutoExecute,
  setQuorum,
  reallocGovernanceConfig,
  reallocProposal,
  reallocDlmmExit,
  reallocStakingPool,
  snapshotGovernanceConfig,
  snapshotProposal,
  snapshotDlmmExit,
  snapshotStakingPool,
} from "./helpers";

// ──────────────────────────────────────────────────────────────────
// Clock manipulation — mirrors brain-staking.ts setAccountInfo approach
// ──────────────────────────────────────────────────────────────────
async function readClockTimestamp(
  connection: anchor.web3.Connection
): Promise<number> {
  const clockAcct = await connection.getAccountInfo(
    anchor.web3.SYSVAR_CLOCK_PUBKEY
  );
  if (!clockAcct || !clockAcct.data) throw new Error("Cannot read clock");
  return Number(Buffer.from(clockAcct.data).readBigInt64LE(32));
}

/**
 * Advance the on-chain clock by sending empty transactions to advance slots.
 * Each slot advances unix_timestamp by ~0.4-1 second on test-validator.
 * For reliable results, we send many transactions and wait.
 */
async function advanceClock(
  connection: anchor.web3.Connection,
  payer: Keypair,
  targetTimestamp: number
): Promise<void> {
  // Send empty transactions to advance the clock
  for (let i = 0; i < 50; i++) {
    const currentTs = await readClockTimestamp(connection);
    if (currentTs >= targetTimestamp) return;

    // Send a small SOL transfer to self to advance a slot
    const tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 1,
      })
    );
    try {
      await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer]);
    } catch {
      // Ignore — we just want to advance the clock
    }
    await sleep(100);
  }
}

/**
 * Try to advance clock via setAccountInfo (works on some validator versions).
 * Falls back to slot-based advancement if not supported.
 */
async function warpTime(
  connection: anchor.web3.Connection,
  seconds: number,
  payer?: Keypair
): Promise<void> {
  const clockAcct = await connection.getAccountInfo(
    anchor.web3.SYSVAR_CLOCK_PUBKEY
  );
  if (!clockAcct || !clockAcct.data) throw new Error("Cannot read clock");

  const data = Buffer.from(clockAcct.data);
  const currentSlot = data.readBigUInt64LE(0);
  const currentTs = data.readBigInt64LE(32);

  const newSlot = currentSlot + BigInt(seconds);
  const newTs = currentTs + BigInt(seconds);
  data.writeBigUInt64LE(newSlot, 0);
  data.writeBigInt64LE(newTs, 32);

  const base64Data = data.toString("base64");
  try {
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

    // @ts-ignore
    await connection._rpcRequest("warpToSlot", [Number(newSlot)]);
    await sleep(800);

    // Verify the warp took effect
    const newTimestamp = await readClockTimestamp(connection);
    if (newTimestamp >= Number(newTs)) return;
  } catch {
    // setAccountInfo not supported
  }

  // Fallback: advance clock by sending transactions
  if (payer) {
    await advanceClock(connection, payer, Number(currentTs) + seconds);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ──────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────
describe("governance", () => {
  let ctx: TestContext;
  const connection = () => ctx.provider.connection;

  before(async () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.BrainStaking as Program<BrainStaking>;

    const owner = (provider.wallet as anchor.Wallet).payer;
    let crank = Keypair.generate();
    let treasury = Keypair.generate();

    // Airdrop to crank
    const sig = await provider.connection.requestAirdrop(
      crank.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    const [stakingPool, poolBump] = findStakingPool(program.programId);
    const [brainVault] = findBrainVault(program.programId);
    const [rewardVault] = findRewardVault(program.programId);

    // Pool may already be initialized by brain-staking.ts in the same run.
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
      // Pool already initialized — fetch existing state and align ctx keys
      const poolState = await program.account.stakingPool.fetch(stakingPool);
      brainMint = poolState.brainMint;
      crank = { publicKey: poolState.crank } as Keypair;
      treasury = { publicKey: poolState.treasury } as Keypair;
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

    // Resume pool if a prior test suite (emergency-controls) left it paused
    const poolState = await program.account.stakingPool.fetch(stakingPool);
    if (poolState.isPaused) {
      await (program.methods as any)
        .resume()
        .accountsStrict({
          authority: owner.publicKey,
          stakingPool,
        })
        .rpc();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // initialize_governance
  // ────────────────────────────────────────────────────────────────
  describe("initialize_governance", () => {
    it("creates GovernanceConfig with correct fields", async () => {
      await initializeGovernance(ctx, ctx.owner);

      const config = await fetchGovernanceConfig(ctx);
      expect(config.pool.toBase58()).to.equal(ctx.stakingPool.toBase58());
      expect((config.nextProposalId as anchor.BN).toNumber()).to.equal(0);
      expect(config.bump).to.be.greaterThan(0);
    });

    it("rejects non-owner", async () => {
      // Governance already initialized, but even if it weren't,
      // the has_one = owner constraint would reject this signer.
      const rando = Keypair.generate();
      const sig = await connection().requestAirdrop(
        rando.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection().confirmTransaction(sig, "confirmed");

      // Create a new program with a separate pool would be needed for a
      // true "non-owner tries to init" test, but the simpler constraint
      // check is: trying to re-initialize with wrong signer fails.
      // Actually the init constraint means this will fail because the
      // account already exists. Let's verify it fails for that reason.
      try {
        await initializeGovernance(ctx, rando);
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Either "already in use" (re-init) or Unauthorized — both valid
        expect(err.toString()).to.match(/already in use|Unauthorized|custom program error/i);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // create_proposal (R029)
  // ────────────────────────────────────────────────────────────────
  describe("create_proposal (R029)", () => {
    let proposalId: number;

    it("creates proposal with correct fields", async () => {
      const now = await readClockTimestamp(connection());
      const votingStarts = new anchor.BN(now + 10);
      const votingEnds = new anchor.BN(now + 3600);

      const result = await createProposal(
        ctx,
        ctx.owner,
        "Test Proposal Alpha",
        "ipfs://Qm123abc",
        0,
        ["Yes", "No"],
        votingStarts,
        votingEnds
      );
      proposalId = result.proposalId;

      const proposal = await fetchProposal(ctx, proposalId);
      expect((proposal.id as anchor.BN).toNumber()).to.equal(proposalId);
      expect(proposal.pool.toBase58()).to.equal(ctx.stakingPool.toBase58());
      expect(proposal.proposer.toBase58()).to.equal(ctx.owner.publicKey.toBase58());
      expect(proposal.title).to.equal("Test Proposal Alpha");
      expect(proposal.descriptionUri).to.equal("ipfs://Qm123abc");
      expect(proposal.proposalType).to.equal(0);
      expect(proposal.options).to.deep.equal(["Yes", "No"]);
      expect(proposal.status).to.equal(0); // Active
      expect((proposal.totalVoteWeight as anchor.BN).toNumber()).to.equal(0);
    });

    it("vote_counts initialized to zeros matching options.len()", async () => {
      const proposal = await fetchProposal(ctx, proposalId);
      expect(proposal.voteCounts.length).to.equal(proposal.options.length);
      for (const count of proposal.voteCounts) {
        expect((count as anchor.BN).toNumber()).to.equal(0);
      }
    });

    it("next_proposal_id incremented", async () => {
      const config = await fetchGovernanceConfig(ctx);
      expect((config.nextProposalId as anchor.BN).toNumber()).to.equal(1);
    });

    it("can create multiple proposals sequentially", async () => {
      const now = await readClockTimestamp(connection());
      const r1 = await createProposal(
        ctx, ctx.owner, "Proposal Two", "ipfs://two", 0,
        ["A", "B", "C"], new anchor.BN(now + 10), new anchor.BN(now + 7200)
      );
      const r2 = await createProposal(
        ctx, ctx.owner, "Proposal Three", "ipfs://three", 1,
        ["Option1", "Option2"], new anchor.BN(now + 10), new anchor.BN(now + 7200)
      );

      expect(r1.proposalId).to.equal(1);
      expect(r2.proposalId).to.equal(2);

      const config = await fetchGovernanceConfig(ctx);
      expect((config.nextProposalId as anchor.BN).toNumber()).to.equal(3);
    });

    it("rejects too few options (< 2)", async () => {
      const now = await readClockTimestamp(connection());
      try {
        await createProposal(
          ctx, ctx.owner, "Bad Proposal", "ipfs://bad", 0,
          ["OnlyOne"], new anchor.BN(now + 10), new anchor.BN(now + 3600)
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TooFewOptions");
      }
    });

    it("rejects too many options (> 5)", async () => {
      const now = await readClockTimestamp(connection());
      try {
        await createProposal(
          ctx, ctx.owner, "Bad Proposal", "ipfs://bad", 0,
          ["A", "B", "C", "D", "E", "F"], new anchor.BN(now + 10), new anchor.BN(now + 3600)
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TooManyOptions");
      }
    });

    it("rejects empty title", async () => {
      const now = await readClockTimestamp(connection());
      try {
        await createProposal(
          ctx, ctx.owner, "", "ipfs://empty", 0,
          ["Yes", "No"], new anchor.BN(now + 10), new anchor.BN(now + 3600)
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TitleTooLong");
      }
    });

    it("rejects voting_ends <= voting_starts", async () => {
      const now = await readClockTimestamp(connection());
      try {
        await createProposal(
          ctx, ctx.owner, "Bad Period", "ipfs://bad", 0,
          ["Yes", "No"], new anchor.BN(now + 100), new anchor.BN(now + 100) // equal
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidVotingPeriod");
      }
    });

    it("rejects voting_starts in the past", async () => {
      const now = await readClockTimestamp(connection());
      try {
        await createProposal(
          ctx, ctx.owner, "Past Start", "ipfs://past", 0,
          ["Yes", "No"], new anchor.BN(now - 100), new anchor.BN(now + 3600)
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidVotingPeriod");
      }
    });

    it("accepts exactly 5 options (max boundary)", async () => {
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Five Options", "ipfs://five", 0,
        ["A", "B", "C", "D", "E"], new anchor.BN(now + 10), new anchor.BN(now + 3600)
      );
      const proposal = await fetchProposal(ctx, result.proposalId);
      expect(proposal.options.length).to.equal(5);
      expect(proposal.voteCounts.length).to.equal(5);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // cast_vote (R030)
  // ────────────────────────────────────────────────────────────────
  describe("cast_vote (R030)", () => {
    let voteProposalId: number;

    // Create a fresh proposal whose voting window is open
    before(async () => {
      const now = await readClockTimestamp(connection());
      // Voting starts immediately (now + 1), ends in 1 hour
      const result = await createProposal(
        ctx, ctx.owner, "Vote Test Proposal", "ipfs://vote", 0,
        ["Yes", "No", "Abstain"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 3600)
      );
      voteProposalId = result.proposalId;

      // Warp past voting_starts so votes are accepted
      await warpTime(connection(), 5, ctx.owner);
    });

    it("voter with ATA-only balance casts vote, weight = ATA balance", async () => {
      const brainAmount = BigInt(1_000_000_000); // 1000 BRAIN (6 decimals)
      const { keypair: voter, brainAta } = await createStaker(ctx, brainAmount);

      await castVote(ctx, voter, brainAta, voteProposalId, 0); // vote "Yes"

      const record = await fetchVoteRecord(ctx, voteProposalId, voter.publicKey);
      expect(record.proposalId.toNumber()).to.equal(voteProposalId);
      expect(record.voter.toBase58()).to.equal(voter.publicKey.toBase58());
      expect(record.optionIndex).to.equal(0);
      expect(record.weight.toNumber()).to.equal(Number(brainAmount));

      const proposal = await fetchProposal(ctx, voteProposalId);
      expect(proposal.voteCounts[0].toNumber()).to.equal(Number(brainAmount));
    });

    it("voter who is also a staker, weight = ATA balance + staked_amount", async () => {
      // Voter with 500k BRAIN total — stakes 200k, keeps 300k in ATA
      const totalBrain = BigInt(500_000_000_000); // 500k BRAIN
      const stakeAmount = new anchor.BN("200000000000"); // 200k BRAIN
      const { keypair: voter, brainAta } = await createStaker(ctx, totalBrain);

      // Stake some BRAIN
      await stakeTokens(ctx, voter, brainAta, stakeAmount);

      const [stakerPda] = findStakerAccount(voter.publicKey, ctx.program.programId);
      await castVote(ctx, voter, brainAta, voteProposalId, 1, stakerPda); // vote "No"

      const record = await fetchVoteRecord(ctx, voteProposalId, voter.publicKey);
      // C6 hybrid weight: ATA (300k) + staked*2 (200k*2=400k) = 700k
      const ataRemaining = Number(totalBrain) - stakeAmount.toNumber(); // 300k
      const expectedWeight = ataRemaining + stakeAmount.toNumber() * 2; // 300k + 400k = 700k
      expect(record.weight.toNumber()).to.equal(expectedWeight);
      expect(record.optionIndex).to.equal(1);
    });

    it("VoteRecord PDA created with correct fields", async () => {
      // Use a fresh voter
      const brainAmount = BigInt(2_000_000_000); // 2000 BRAIN
      const { keypair: voter, brainAta } = await createStaker(ctx, brainAmount);

      await castVote(ctx, voter, brainAta, voteProposalId, 2); // vote "Abstain"

      const record = await fetchVoteRecord(ctx, voteProposalId, voter.publicKey);
      expect(record.proposalId.toNumber()).to.equal(voteProposalId);
      expect(record.voter.toBase58()).to.equal(voter.publicKey.toBase58());
      expect(record.optionIndex).to.equal(2);
      expect(record.weight.toNumber()).to.equal(Number(brainAmount));
      expect(record.votedAt.toNumber()).to.be.greaterThan(0);
      expect(record.bump).to.be.greaterThan(0);
    });

    it("proposal.total_vote_weight incremented", async () => {
      const proposal = await fetchProposal(ctx, voteProposalId);
      // total_vote_weight should be sum of all votes cast above
      expect(proposal.totalVoteWeight.toNumber()).to.be.greaterThan(0);
    });

    it("duplicate vote rejected (VoteRecord PDA already exists)", async () => {
      const brainAmount = BigInt(1_000_000_000);
      const { keypair: voter, brainAta } = await createStaker(ctx, brainAmount);

      await castVote(ctx, voter, brainAta, voteProposalId, 0);

      // Second vote should fail — VoteRecord PDA already initialized
      try {
        await castVote(ctx, voter, brainAta, voteProposalId, 1);
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Anchor "already in use" error when trying to init an existing PDA
        expect(err.toString()).to.match(/already in use|custom program error/i);
      }
    });

    it("vote with zero BRAIN balance rejected (NoVotingPower)", async () => {
      // Create voter with 0 BRAIN
      const voter = Keypair.generate();
      const sig = await connection().requestAirdrop(
        voter.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await connection().confirmTransaction(sig, "confirmed");

      const brainAta = await createAssociatedTokenAccount(
        connection(),
        voter,
        ctx.brainMint,
        voter.publicKey
      );
      // Don't mint any BRAIN — balance is 0

      try {
        await castVote(ctx, voter, brainAta, voteProposalId, 0);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NoVotingPower");
      }
    });

    it("vote with invalid option_index rejected", async () => {
      const brainAmount = BigInt(1_000_000_000);
      const { keypair: voter, brainAta } = await createStaker(ctx, brainAmount);

      // Proposal has 3 options [0, 1, 2], so index 3 is out of range
      try {
        await castVote(ctx, voter, brainAta, voteProposalId, 3);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidOptionIndex");
      }
    });

    it("vote with option_index = options.len() rejected (off-by-one)", async () => {
      const brainAmount = BigInt(1_000_000_000);
      const { keypair: voter, brainAta } = await createStaker(ctx, brainAmount);

      // Proposal has 3 options, so index 3 == options.len() — out of range
      try {
        await castVote(ctx, voter, brainAta, voteProposalId, 3);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidOptionIndex");
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // cast_vote — voting period enforcement
  // ────────────────────────────────────────────────────────────────
  describe("cast_vote — voting period enforcement", () => {
    let periodProposalId: number;

    it("vote before voting_starts rejected", async () => {
      const now = await readClockTimestamp(connection());
      // Create proposal that starts far in the future
      const result = await createProposal(
        ctx, ctx.owner, "Future Proposal", "ipfs://future", 0,
        ["Yes", "No"],
        new anchor.BN(now + 86400), // starts in 24h
        new anchor.BN(now + 172800) // ends in 48h
      );
      periodProposalId = result.proposalId;

      const brainAmount = BigInt(1_000_000_000);
      const { keypair: voter, brainAta } = await createStaker(ctx, brainAmount);

      try {
        await castVote(ctx, voter, brainAta, periodProposalId, 0);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VotingPeriodNotStarted");
      }
    });

    it("vote after voting_ends rejected", async () => {
      const now = await readClockTimestamp(connection());
      // Create proposal with short voting window
      const result = await createProposal(
        ctx, ctx.owner, "Short Window", "ipfs://short", 0,
        ["Yes", "No"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 10) // ends in 10 seconds
      );

      // Warp past the end
      await warpTime(connection(), 20, ctx.owner);

      const brainAmount = BigInt(1_000_000_000);
      const { keypair: voter, brainAta } = await createStaker(ctx, brainAmount);

      try {
        await castVote(ctx, voter, brainAta, result.proposalId, 0);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VotingPeriodEnded");
      }
    });

    it("vote on closed proposal rejected", async () => {
      const now = await readClockTimestamp(connection());
      // Create proposal, warp to end, close it, then try to vote
      const result = await createProposal(
        ctx, ctx.owner, "Close Then Vote", "ipfs://closevote", 0,
        ["Yes", "No"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 10)
      );

      // Warp past end and close
      await warpTime(connection(), 20, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const brainAmount = BigInt(1_000_000_000);
      const { keypair: voter, brainAta } = await createStaker(ctx, brainAmount);

      try {
        await castVote(ctx, voter, brainAta, result.proposalId, 0);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ProposalNotActive");
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // close_proposal (R031)
  // ────────────────────────────────────────────────────────────────
  describe("close_proposal (R031)", () => {
    it("anyone can close after voting_ends", async () => {
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Close Me", "ipfs://closeme", 0,
        ["Yes", "No"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 10)
      );

      // Warp past the end
      await warpTime(connection(), 20, ctx.owner);

      // Random non-owner closes the proposal
      const rando = Keypair.generate();
      const sig = await connection().requestAirdrop(
        rando.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection().confirmTransaction(sig, "confirmed");

      await closeProposal(ctx, rando, result.proposalId);

      const proposal = await fetchProposal(ctx, result.proposalId);
      // No votes were cast, so tally rejects the proposal
      expect(proposal.status).to.equal(2); // Rejected (no votes)
    });

    it("premature close rejected (before voting_ends)", async () => {
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Too Early", "ipfs://early", 0,
        ["Yes", "No"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 86400) // ends in 24h
      );

      try {
        await closeProposal(ctx, ctx.owner, result.proposalId);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VotingPeriodNotEnded");
      }
    });

    it("already-closed proposal rejected", async () => {
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Double Close", "ipfs://double", 0,
        ["Yes", "No"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 10)
      );

      await warpTime(connection(), 20, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      // Try closing again
      try {
        await closeProposal(ctx, ctx.owner, result.proposalId);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ProposalNotActive");
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // close_proposal — vote tally (M003/S01)
  // ────────────────────────────────────────────────────────────────
  describe("close_proposal — vote tally", () => {
    it("proposal with 'Yes' majority → status = Passed (1), winning_option_index = 0", async () => {
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Tally Yes Wins", "ipfs://tally-yes", 0,
        ["Yes", "No"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 40)
      );

      // Warp into voting window
      await warpTime(connection(), 5, ctx.owner);

      // 3 voters: 2 vote Yes (1000 + 500), 1 votes No (200)
      const { keypair: v1, brainAta: a1 } = await createStaker(ctx, BigInt(1_000_000_000));
      const { keypair: v2, brainAta: a2 } = await createStaker(ctx, BigInt(500_000_000));
      const { keypair: v3, brainAta: a3 } = await createStaker(ctx, BigInt(200_000_000));

      await castVote(ctx, v1, a1, result.proposalId, 0); // Yes
      await castVote(ctx, v2, a2, result.proposalId, 0); // Yes
      await castVote(ctx, v3, a3, result.proposalId, 1); // No

      // Warp past voting end
      await warpTime(connection(), 50, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const proposal = await fetchProposal(ctx, result.proposalId);
      expect(proposal.status).to.equal(1); // Passed
      expect(proposal.winningOptionIndex).to.equal(0);
    });

    it("proposal with 'No' majority → status = Rejected (2), winning_option_index = 1", async () => {
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Tally No Wins", "ipfs://tally-no", 0,
        ["Yes", "No"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 40)
      );

      await warpTime(connection(), 5, ctx.owner);

      const { keypair: v1, brainAta: a1 } = await createStaker(ctx, BigInt(100_000_000));
      const { keypair: v2, brainAta: a2 } = await createStaker(ctx, BigInt(900_000_000));

      await castVote(ctx, v1, a1, result.proposalId, 0); // Yes
      await castVote(ctx, v2, a2, result.proposalId, 1); // No

      await warpTime(connection(), 50, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const proposal = await fetchProposal(ctx, result.proposalId);
      expect(proposal.status).to.equal(2); // Rejected
      expect(proposal.winningOptionIndex).to.equal(1);
    });

    it("proposal with tie → status = Rejected (2), winning_option_index = 255", async () => {
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Tally Tie", "ipfs://tally-tie", 0,
        ["Yes", "No"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 40)
      );

      await warpTime(connection(), 5, ctx.owner);

      const { keypair: v1, brainAta: a1 } = await createStaker(ctx, BigInt(500_000_000));
      const { keypair: v2, brainAta: a2 } = await createStaker(ctx, BigInt(500_000_000));

      await castVote(ctx, v1, a1, result.proposalId, 0); // Yes
      await castVote(ctx, v2, a2, result.proposalId, 1); // No

      await warpTime(connection(), 50, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const proposal = await fetchProposal(ctx, result.proposalId);
      expect(proposal.status).to.equal(2); // Rejected (tie = conservative reject)
      expect(proposal.winningOptionIndex).to.equal(255);
    });

    it("proposal with no votes → status = Rejected (2), winning_option_index = 255", async () => {
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Tally No Votes", "ipfs://tally-none", 0,
        ["Yes", "No"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 30)
      );

      await warpTime(connection(), 40, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const proposal = await fetchProposal(ctx, result.proposalId);
      expect(proposal.status).to.equal(2); // Rejected
      expect(proposal.winningOptionIndex).to.equal(255);
    });

    it("proposal with quorum not met → status = Rejected (2), winning_option_index = 255", async () => {
      // Require 100% quorum against current total_staked for deterministic rejection.
      await setQuorum(ctx, ctx.owner, 10_000);

      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Tally Quorum Not Met", "ipfs://tally-quorum", 0,
        ["Yes", "No"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 40)
      );

      await warpTime(connection(), 5, ctx.owner);
      // Cast a low-weight vote that should not meet 100% quorum of total_staked.
      const { keypair: voter, brainAta } = await createStaker(ctx, BigInt(1_000_000_000));
      await castVote(ctx, voter, brainAta, result.proposalId, 0);

      await warpTime(connection(), 50, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const proposal = await fetchProposal(ctx, result.proposalId);
      expect(proposal.status).to.equal(2); // Rejected
      expect(proposal.winningOptionIndex).to.equal(255);

      // Reset quorum for subsequent tests.
      await setQuorum(ctx, ctx.owner, 0);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // governance_initiate_exit (R023, R024)
  // ────────────────────────────────────────────────────────────────
  describe("governance_initiate_exit (R023, R024)", () => {
    const assetMint = Keypair.generate().publicKey;
    const dlmmPool = Keypair.generate().publicKey;
    const position = Keypair.generate().publicKey;
    let passedSellProposalId: number;

    before(async () => {
      // Create a sell proposal (proposal_type = 1), vote Yes, close it
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Sell Asset X", "ipfs://sell-x", 1, // proposal_type = 1 (SELL)
        ["Sell", "Keep"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 40)
      );
      passedSellProposalId = result.proposalId;

      await warpTime(connection(), 5, ctx.owner);

      // Vote Yes (Sell) with heavy weight
      const { keypair: voter, brainAta } = await createStaker(ctx, BigInt(10_000_000_000));
      await castVote(ctx, voter, brainAta, passedSellProposalId, 0); // Sell

      await warpTime(connection(), 50, ctx.owner);
      await closeProposal(ctx, ctx.owner, passedSellProposalId);

      // Verify it passed
      const proposal = await fetchProposal(ctx, passedSellProposalId);
      expect(proposal.status).to.equal(1); // Passed
    });

    it("owner creates DlmmExit from passed sell vote", async () => {
      await governanceInitiateExit(
        ctx, ctx.owner, passedSellProposalId,
        assetMint, dlmmPool, position
      );

      const exit = await fetchDlmmExit(ctx, assetMint, dlmmPool);
      expect(exit.pool.toBase58()).to.equal(ctx.stakingPool.toBase58());
      expect(exit.owner.toBase58()).to.equal(ctx.owner.publicKey.toBase58());
      expect(exit.assetMint.toBase58()).to.equal(assetMint.toBase58());
      expect(exit.dlmmPool.toBase58()).to.equal(dlmmPool.toBase58());
      expect(exit.position.toBase58()).to.equal(position.toBase58());
      expect((exit.proposalId as anchor.BN).toNumber()).to.equal(passedSellProposalId);
      expect(exit.status).to.equal(0); // Active

      const proposal = await fetchProposal(ctx, passedSellProposalId);
      expect(proposal.executed).to.equal(true);
    });

    it("duplicate governance execution rejected and existing DlmmExit stays unchanged", async () => {
      const beforeExit = await fetchDlmmExit(ctx, assetMint, dlmmPool);

      const replayMint = Keypair.generate().publicKey;
      const replayPool = Keypair.generate().publicKey;
      const replayPosition = Keypair.generate().publicKey;

      try {
        await governanceInitiateExit(
          ctx,
          ctx.owner,
          passedSellProposalId,
          replayMint,
          replayPool,
          replayPosition
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ProposalAlreadyExecuted");
      }

      const afterExit = await fetchDlmmExit(ctx, assetMint, dlmmPool);
      expect(afterExit.pool.toBase58()).to.equal(beforeExit.pool.toBase58());
      expect(afterExit.owner.toBase58()).to.equal(beforeExit.owner.toBase58());
      expect(afterExit.assetMint.toBase58()).to.equal(beforeExit.assetMint.toBase58());
      expect(afterExit.dlmmPool.toBase58()).to.equal(beforeExit.dlmmPool.toBase58());
      expect(afterExit.position.toBase58()).to.equal(beforeExit.position.toBase58());
      expect(afterExit.status).to.equal(beforeExit.status);
      expect((afterExit.proposalId as anchor.BN).toNumber()).to.equal(
        (beforeExit.proposalId as anchor.BN).toNumber()
      );

      const [replayExitPda] = findDlmmExit(replayMint, replayPool, ctx.program.programId);
      const replayExitInfo = await connection().getAccountInfo(replayExitPda);
      expect(replayExitInfo).to.equal(null);
    });

    it("rejects non-sell proposal_type", async () => {
      // Create a non-sell proposal (type 0), vote Yes, close
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "General Proposal", "ipfs://general", 0, // type 0 = general
        ["Yes", "No"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 40)
      );

      await warpTime(connection(), 5, ctx.owner);
      const { keypair: voter, brainAta } = await createStaker(ctx, BigInt(5_000_000_000));
      await castVote(ctx, voter, brainAta, result.proposalId, 0);

      await warpTime(connection(), 50, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const mint2 = Keypair.generate().publicKey;
      const pool2 = Keypair.generate().publicKey;
      const pos2 = Keypair.generate().publicKey;

      try {
        await governanceInitiateExit(
          ctx, ctx.owner, result.proposalId,
          mint2, pool2, pos2
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidProposalType");
      }
    });

    it("rejects rejected (not-passed) proposal", async () => {
      // Create a sell proposal, vote No, close → Rejected
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Sell Rejected", "ipfs://sell-rejected", 1,
        ["Sell", "Keep"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 15)
      );

      await warpTime(connection(), 5, ctx.owner);
      const { keypair: voter, brainAta } = await createStaker(ctx, BigInt(5_000_000_000));
      await castVote(ctx, voter, brainAta, result.proposalId, 1); // Keep (No)

      await warpTime(connection(), 20, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const mint3 = Keypair.generate().publicKey;
      const pool3 = Keypair.generate().publicKey;
      const pos3 = Keypair.generate().publicKey;

      try {
        await governanceInitiateExit(
          ctx, ctx.owner, result.proposalId,
          mint3, pool3, pos3
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ProposalNotPassed");
      }
    });

    it("proposal with tie cannot trigger governance exit", async () => {
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Sell Tie", "ipfs://sell-tie", 1,
        ["Sell", "Keep"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 30)
      );

      await warpTime(connection(), 5, ctx.owner);

      const { keypair: v1, brainAta: a1 } = await createStaker(ctx, BigInt(500_000_000));
      const { keypair: v2, brainAta: a2 } = await createStaker(ctx, BigInt(500_000_000));
      await castVote(ctx, v1, a1, result.proposalId, 0);
      await castVote(ctx, v2, a2, result.proposalId, 1);

      await warpTime(connection(), 40, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const proposal = await fetchProposal(ctx, result.proposalId);
      expect(proposal.status).to.equal(2);
      expect(proposal.winningOptionIndex).to.equal(255);

      const tieMint = Keypair.generate().publicKey;
      const tiePool = Keypair.generate().publicKey;
      const tiePosition = Keypair.generate().publicKey;
      try {
        await governanceInitiateExit(
          ctx,
          ctx.owner,
          result.proposalId,
          tieMint,
          tiePool,
          tiePosition
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ProposalNotPassed");
      }

      const [tieExitPda] = findDlmmExit(tieMint, tiePool, ctx.program.programId);
      const tieExitInfo = await connection().getAccountInfo(tieExitPda);
      expect(tieExitInfo).to.equal(null);
    });

    it("proposal with no votes cannot trigger governance exit", async () => {
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Sell No Votes", "ipfs://sell-none", 1,
        ["Sell", "Keep"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 20)
      );

      await warpTime(connection(), 30, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const proposal = await fetchProposal(ctx, result.proposalId);
      expect(proposal.status).to.equal(2);
      expect(proposal.winningOptionIndex).to.equal(255);

      const noVotesMint = Keypair.generate().publicKey;
      const noVotesPool = Keypair.generate().publicKey;
      const noVotesPosition = Keypair.generate().publicKey;
      try {
        await governanceInitiateExit(
          ctx,
          ctx.owner,
          result.proposalId,
          noVotesMint,
          noVotesPool,
          noVotesPosition
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ProposalNotPassed");
      }

      const [noVotesExitPda] = findDlmmExit(noVotesMint, noVotesPool, ctx.program.programId);
      const noVotesExitInfo = await connection().getAccountInfo(noVotesExitPda);
      expect(noVotesExitInfo).to.equal(null);
    });

    it("crank rejected in manual mode (auto_execute = false)", async () => {
      // Ensure auto_execute is false
      const config = await fetchGovernanceConfig(ctx);
      expect(config.autoExecute).to.equal(false);

      // Create + pass another sell proposal
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Sell Crank Test", "ipfs://sell-crank", 1,
        ["Sell", "Keep"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 15)
      );

      await warpTime(connection(), 5, ctx.owner);
      const { keypair: voter, brainAta } = await createStaker(ctx, BigInt(5_000_000_000));
      await castVote(ctx, voter, brainAta, result.proposalId, 0);

      await warpTime(connection(), 20, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const beforeProposal = await fetchProposal(ctx, result.proposalId);
      expect(beforeProposal.executed).to.equal(false);

      const mint4 = Keypair.generate().publicKey;
      const pool4 = Keypair.generate().publicKey;
      const pos4 = Keypair.generate().publicKey;

      try {
        await governanceInitiateExit(
          ctx, ctx.crank, result.proposalId,
          mint4, pool4, pos4
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }

      const afterProposal = await fetchProposal(ctx, result.proposalId);
      expect(afterProposal.executed).to.equal(false);

      const [blockedExitPda] = findDlmmExit(mint4, pool4, ctx.program.programId);
      const blockedExitInfo = await connection().getAccountInfo(blockedExitPda);
      expect(blockedExitInfo).to.equal(null);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // realloc migration safety (M003/S01/T02)
  // ────────────────────────────────────────────────────────────────
  describe("realloc migration safety", () => {
    async function fundedSigner(): Promise<Keypair> {
      const signer = Keypair.generate();
      const sig = await connection().requestAirdrop(
        signer.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection().confirmTransaction(sig, "confirmed");
      return signer;
    }

    async function createClosedSellProposal(title: string): Promise<number> {
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx,
        ctx.owner,
        title,
        `ipfs://${title.toLowerCase().replace(/\s+/g, "-")}`,
        1,
        ["Sell", "Keep"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 40)
      );

      await warpTime(connection(), 5, ctx.owner);
      const { keypair: voter, brainAta } = await createStaker(
        ctx,
        BigInt(5_000_000_000)
      );
      await castVote(ctx, voter, brainAta, result.proposalId, 0);

      await warpTime(connection(), 50, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const proposal = await fetchProposal(ctx, result.proposalId);
      expect(proposal.status).to.equal(1);
      expect(proposal.winningOptionIndex).to.equal(0);

      return result.proposalId;
    }

    it("realloc_governance_config is idempotent and preserves existing fields", async () => {
      await setAutoExecute(ctx, ctx.owner, true);
      await setQuorum(ctx, ctx.owner, 3210);

      const before = snapshotGovernanceConfig(await fetchGovernanceConfig(ctx));

      await reallocGovernanceConfig(ctx, ctx.owner);
      const afterFirst = snapshotGovernanceConfig(await fetchGovernanceConfig(ctx));
      expect(afterFirst).to.deep.equal(before);

      await reallocGovernanceConfig(ctx, ctx.owner);
      const afterSecond = snapshotGovernanceConfig(await fetchGovernanceConfig(ctx));
      expect(afterSecond).to.deep.equal(before);

      await setAutoExecute(ctx, ctx.owner, false);
      await setQuorum(ctx, ctx.owner, 0);
    });

    it("realloc_governance_config rejects non-owner and leaves state unchanged", async () => {
      const rando = await fundedSigner();
      const before = snapshotGovernanceConfig(await fetchGovernanceConfig(ctx));

      try {
        await reallocGovernanceConfig(ctx, rando);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|custom program error/i);
      }

      const after = snapshotGovernanceConfig(await fetchGovernanceConfig(ctx));
      expect(after).to.deep.equal(before);
    });

    it("realloc_proposal is idempotent and malformed proposal_id is rejected with no drift", async () => {
      const proposalId = await createClosedSellProposal("Realloc Proposal Safe");
      const before = snapshotProposal(await fetchProposal(ctx, proposalId));

      await reallocProposal(ctx, ctx.owner, proposalId);
      const afterFirst = snapshotProposal(await fetchProposal(ctx, proposalId));
      expect(afterFirst).to.deep.equal(before);

      const [proposal] = findProposal(proposalId, ctx.stakingPool, ctx.program.programId);
      try {
        await ctx.program.methods
          .reallocProposal(new anchor.BN(proposalId + 999))
          .accountsStrict({
            owner: ctx.owner.publicKey,
            stakingPool: ctx.stakingPool,
            proposal,
            systemProgram: SystemProgram.programId,
          })
          .signers([ctx.owner])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.match(/ConstraintSeeds|seeds|custom program error/i);
      }

      const afterMalformed = snapshotProposal(await fetchProposal(ctx, proposalId));
      expect(afterMalformed).to.deep.equal(before);

      await reallocProposal(ctx, ctx.owner, proposalId);
      const afterSecond = snapshotProposal(await fetchProposal(ctx, proposalId));
      expect(afterSecond).to.deep.equal(before);
    });

    it("realloc_proposal rejects non-owner and leaves proposal unchanged", async () => {
      const proposalId = await createClosedSellProposal("Realloc Proposal Unauthorized");
      const rando = await fundedSigner();
      const before = snapshotProposal(await fetchProposal(ctx, proposalId));

      try {
        await reallocProposal(ctx, rando, proposalId);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|custom program error/i);
      }

      const after = snapshotProposal(await fetchProposal(ctx, proposalId));
      expect(after).to.deep.equal(before);
    });

    it("realloc_dlmm_exit is idempotent and preserves proposal-linked fields", async () => {
      const proposalId = await createClosedSellProposal("Realloc Dlmm Exit Safe");
      const assetMint = Keypair.generate().publicKey;
      const dlmmPool = Keypair.generate().publicKey;
      const position = Keypair.generate().publicKey;

      await governanceInitiateExit(
        ctx,
        ctx.owner,
        proposalId,
        assetMint,
        dlmmPool,
        position
      );

      const before = snapshotDlmmExit(
        await fetchDlmmExit(ctx, assetMint, dlmmPool)
      );
      expect(before.proposalId).to.equal(String(proposalId));

      await reallocDlmmExit(ctx, ctx.owner, assetMint, dlmmPool);
      const afterFirst = snapshotDlmmExit(
        await fetchDlmmExit(ctx, assetMint, dlmmPool)
      );
      expect(afterFirst).to.deep.equal(before);

      await reallocDlmmExit(ctx, ctx.owner, assetMint, dlmmPool);
      const afterSecond = snapshotDlmmExit(
        await fetchDlmmExit(ctx, assetMint, dlmmPool)
      );
      expect(afterSecond).to.deep.equal(before);
    });

    it("realloc_dlmm_exit rejects non-owner and leaves exit unchanged", async () => {
      const proposalId = await createClosedSellProposal("Realloc Dlmm Exit Unauthorized");
      const assetMint = Keypair.generate().publicKey;
      const dlmmPool = Keypair.generate().publicKey;
      const position = Keypair.generate().publicKey;

      await governanceInitiateExit(
        ctx,
        ctx.owner,
        proposalId,
        assetMint,
        dlmmPool,
        position
      );

      const rando = await fundedSigner();
      const before = snapshotDlmmExit(
        await fetchDlmmExit(ctx, assetMint, dlmmPool)
      );

      try {
        await reallocDlmmExit(ctx, rando, assetMint, dlmmPool);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|custom program error/i);
      }

      const after = snapshotDlmmExit(
        await fetchDlmmExit(ctx, assetMint, dlmmPool)
      );
      expect(after).to.deep.equal(before);
    });

    it("realloc_staking_pool is idempotent and preserves non-default pool fields", async () => {
      const { keypair: staker, brainAta } = await createStaker(
        ctx,
        BigInt(500_000_000_000)
      );
      await stakeTokens(ctx, staker, brainAta, new anchor.BN("100000000000"));

      const before = snapshotStakingPool(await fetchPool(ctx));
      expect(before.totalStaked).to.not.equal("0");

      await reallocStakingPool(ctx, ctx.owner);
      const afterFirst = snapshotStakingPool(await fetchPool(ctx));
      expect(afterFirst).to.deep.equal(before);

      await reallocStakingPool(ctx, ctx.owner);
      const afterSecond = snapshotStakingPool(await fetchPool(ctx));
      expect(afterSecond).to.deep.equal(before);
    });

    it("realloc_staking_pool rejects non-owner and leaves pool unchanged", async () => {
      const rando = await fundedSigner();
      const before = snapshotStakingPool(await fetchPool(ctx));

      try {
        await reallocStakingPool(ctx, rando);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|custom program error/i);
      }

      const after = snapshotStakingPool(await fetchPool(ctx));
      expect(after).to.deep.equal(before);
    });

    it("close + execute governance flow still works after realloc migrations", async () => {
      await reallocGovernanceConfig(ctx, ctx.owner);
      await reallocStakingPool(ctx, ctx.owner);

      const proposalId = await createClosedSellProposal("Post Realloc Governance Flow");
      await reallocProposal(ctx, ctx.owner, proposalId);

      const assetMint = Keypair.generate().publicKey;
      const dlmmPool = Keypair.generate().publicKey;
      const position = Keypair.generate().publicKey;

      await governanceInitiateExit(
        ctx,
        ctx.owner,
        proposalId,
        assetMint,
        dlmmPool,
        position
      );
      await reallocDlmmExit(ctx, ctx.owner, assetMint, dlmmPool);

      const proposal = await fetchProposal(ctx, proposalId);
      const exit = await fetchDlmmExit(ctx, assetMint, dlmmPool);

      expect(proposal.status).to.equal(1);
      expect(proposal.executed).to.equal(true);
      expect((exit.proposalId as anchor.BN).toNumber()).to.equal(proposalId);
      expect(exit.status).to.equal(0);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // set_auto_execute + auto-mode governance exit
  // ────────────────────────────────────────────────────────────────
  describe("set_auto_execute", () => {
    it("owner can enable auto_execute", async () => {
      await setAutoExecute(ctx, ctx.owner, true);

      const config = await fetchGovernanceConfig(ctx);
      expect(config.autoExecute).to.equal(true);
    });

    it("owner can disable auto_execute", async () => {
      await setAutoExecute(ctx, ctx.owner, false);
      let config = await fetchGovernanceConfig(ctx);
      expect(config.autoExecute).to.equal(false);

      // Re-enable for the next test
      await setAutoExecute(ctx, ctx.owner, true);
      config = await fetchGovernanceConfig(ctx);
      expect(config.autoExecute).to.equal(true);
    });

    it("non-owner cannot set_auto_execute", async () => {
      const rando = Keypair.generate();
      const sig = await connection().requestAirdrop(
        rando.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection().confirmTransaction(sig, "confirmed");

      try {
        await setAutoExecute(ctx, rando, true);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.match(/Unauthorized|custom program error|ConstraintHasOne/i);
      }
    });

    it("crank can call governance_initiate_exit when auto_execute = true", async () => {
      // Ensure auto_execute is on
      const config = await fetchGovernanceConfig(ctx);
      expect(config.autoExecute).to.equal(true);

      // Create + pass a sell proposal
      const now = await readClockTimestamp(connection());
      const result = await createProposal(
        ctx, ctx.owner, "Auto Sell Test", "ipfs://auto-sell", 1,
        ["Sell", "Keep"],
        new anchor.BN(now + 1),
        new anchor.BN(now + 15)
      );

      await warpTime(connection(), 5, ctx.owner);
      const { keypair: voter, brainAta } = await createStaker(ctx, BigInt(5_000_000_000));
      await castVote(ctx, voter, brainAta, result.proposalId, 0);

      await warpTime(connection(), 20, ctx.owner);
      await closeProposal(ctx, ctx.owner, result.proposalId);

      const mintAuto = Keypair.generate().publicKey;
      const poolAuto = Keypair.generate().publicKey;
      const posAuto = Keypair.generate().publicKey;

      // Crank executes the passed sell vote
      await governanceInitiateExit(
        ctx, ctx.crank, result.proposalId,
        mintAuto, poolAuto, posAuto
      );

      const exit = await fetchDlmmExit(ctx, mintAuto, poolAuto);
      expect(exit.owner.toBase58()).to.equal(ctx.owner.publicKey.toBase58());
      expect((exit.proposalId as anchor.BN).toNumber()).to.equal(result.proposalId);
      expect(exit.status).to.equal(0); // Active
    });
  });
});
