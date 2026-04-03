import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  PASSING_OPTION_INDEX,
  SELL_PROPOSAL_TYPE,
  GOVERNANCE_NOT_EXECUTABLE_ERROR_CODE,
  ensureExecutableSellProposal,
  evaluateExecutableSellProposal,
  getGovernanceInitiateExitInvalidationKeys,
  getSetAutoExecuteInvalidationKeys,
  getSetQuorumInvalidationKeys,
  governanceKeys,
  selectExecutableSellProposals,
} from "../frontend-pr/hooks/useGovernance";
import { ProposalStatus, type Proposal } from "../frontend-pr/utils/governance";

describe("frontend-pr governance hooks selectors", () => {
  it("marks passed, unexecuted SELL proposals with pass winner as executable", () => {
    const proposal = buildProposal();

    const state = evaluateExecutableSellProposal(proposal);

    expect(state.isExecutable).to.equal(true);
    expect(state.reasons).to.deep.equal([]);
    expect(state.proposalType).to.equal(SELL_PROPOSAL_TYPE);
    expect(state.status).to.equal(ProposalStatus.Passed);
    expect(state.winningOptionIndex).to.equal(PASSING_OPTION_INDEX);
    expect(state.executed).to.equal(false);
  });

  it("treats malformed proposal fields as non-executable", () => {
    const missingWinner = buildProposal({ winningOptionIndex: undefined as any });
    const mismatchedVotes = buildProposal({
      options: ["Sell", "Hold", "Abstain"],
      voteCounts: [new BN(10), new BN(2)],
    });
    const unsupportedType = buildProposal({ proposalType: 9 });

    const missingWinnerState = evaluateExecutableSellProposal(missingWinner);
    const mismatchedVotesState = evaluateExecutableSellProposal(mismatchedVotes);
    const unsupportedTypeState = evaluateExecutableSellProposal(unsupportedType);

    expect(missingWinnerState.isExecutable).to.equal(false);
    expect(missingWinnerState.reasons).to.include("winning_option_missing_or_invalid");

    expect(mismatchedVotesState.isExecutable).to.equal(false);
    expect(mismatchedVotesState.reasons).to.include("vote_counts_length_mismatch");

    expect(unsupportedTypeState.isExecutable).to.equal(false);
    expect(unsupportedTypeState.reasons).to.include("unsupported_proposal_type");
  });

  it("excludes tie/no-vote/rejected/executed proposals from executable selector", () => {
    const executable = buildProposal({ id: new BN(1) });
    const tieResult = buildProposal({
      id: new BN(2),
      winningOptionIndex: 1,
      voteCounts: [new BN(15), new BN(15)],
    });
    const noVoteRejected = buildProposal({
      id: new BN(3),
      status: ProposalStatus.Rejected,
      totalVoteWeight: new BN(0),
      winningOptionIndex: 255,
      voteCounts: [new BN(0), new BN(0)],
    });
    const rejected = buildProposal({ id: new BN(4), status: ProposalStatus.Rejected });
    const executed = buildProposal({ id: new BN(5), executed: true });

    const selected = selectExecutableSellProposals([
      executable,
      tieResult,
      noVoteRejected,
      rejected,
      executed,
    ]);

    expect(selected).to.have.length(1);
    expect((selected[0].id as BN).toNumber()).to.equal(1);
  });

  it("throws explicit non-executable error when execution preflight fails", () => {
    const alreadyExecuted = buildProposal({ executed: true, id: new BN(91) });

    let thrown: any = null;
    try {
      ensureExecutableSellProposal(alreadyExecuted);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect(thrown.code).to.equal(GOVERNANCE_NOT_EXECUTABLE_ERROR_CODE);
    expect(thrown.details.reasons).to.include("already_executed");
  });
});

describe("frontend-pr governance hooks invalidation keys", () => {
  it("uses narrow invalidation scope after governance initiate exit", () => {
    const keys = getGovernanceInitiateExitInvalidationKeys(77);

    expect(keys).to.deep.equal([
      governanceKeys.proposal(77),
      governanceKeys.proposals(),
      governanceKeys.exits(),
    ]);
  });

  it("invalidates config + proposals for auto-execute and quorum admin updates", () => {
    expect(getSetAutoExecuteInvalidationKeys()).to.deep.equal([
      governanceKeys.config(),
      governanceKeys.proposals(),
    ]);

    expect(getSetQuorumInvalidationKeys()).to.deep.equal([
      governanceKeys.config(),
      governanceKeys.proposals(),
    ]);
  });
});

function buildProposal(overrides: Partial<Proposal> = {}): Proposal {
  const proposal: Proposal = {
    id: new BN(1),
    pool: keyFromSeed(11),
    proposer: keyFromSeed(12),
    title: "Sell DLMM position",
    descriptionUri: "ipfs://proposal-1",
    proposalType: SELL_PROPOSAL_TYPE,
    options: ["Sell", "Do Nothing"],
    voteCounts: [new BN(100), new BN(5)],
    votingStarts: new BN(0),
    votingEnds: new BN(10),
    status: ProposalStatus.Passed,
    totalVoteWeight: new BN(105),
    winningOptionIndex: PASSING_OPTION_INDEX,
    executed: false,
    bump: 255,
  };

  return {
    ...proposal,
    ...overrides,
  };
}

function keyFromSeed(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (seed + i) % 255;
  }
  return new PublicKey(bytes);
}
