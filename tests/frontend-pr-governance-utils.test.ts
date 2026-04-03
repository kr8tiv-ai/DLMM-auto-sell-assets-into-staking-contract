import { expect } from "chai";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  BRAIN_STAKING_PROGRAM_ID,
  ProposalStatus,
  createCloseProposalInstruction,
  createGovernanceInitiateExitInstruction,
  createSetAutoExecuteInstruction,
  createSetQuorumInstruction,
  findGovernanceConfig,
  findProposal,
  findStakingPool,
  proposalStatusLabel,
} from "../frontend-pr/utils/governance";
import { findProposal as findProposalFromHelpers } from "./helpers";

const TEST_PROGRAM_ID = BRAIN_STAKING_PROGRAM_ID;

describe("frontend-pr governance utils", () => {
  it("derives proposal PDA with pool seed parity to canonical helper", () => {
    const [stakingPool] = findStakingPool(TEST_PROGRAM_ID);
    const proposalId = 42;

    const [fromFrontend] = findProposal(proposalId, stakingPool, TEST_PROGRAM_ID);
    const [fromHelpers] = findProposalFromHelpers(
      proposalId,
      stakingPool,
      TEST_PROGRAM_ID
    );

    expect(fromFrontend.toBase58()).to.equal(fromHelpers.toBase58());
  });

  it("findProposal rejects malformed proposal ids", () => {
    const [stakingPool] = findStakingPool(TEST_PROGRAM_ID);

    expect(() => findProposal(-1, stakingPool, TEST_PROGRAM_ID)).to.throw(
      "proposalId"
    );
    expect(() => findProposal(1.25, stakingPool, TEST_PROGRAM_ID)).to.throw(
      "proposalId"
    );
  });

  it("findProposal changes when pool seed input changes", () => {
    const [poolA] = findStakingPool(TEST_PROGRAM_ID);
    const poolB = keyFromSeed(91);

    const [proposalA] = findProposal(12, poolA, TEST_PROGRAM_ID);
    const [proposalB] = findProposal(12, poolB, TEST_PROGRAM_ID);

    expect(proposalA.toBase58()).to.not.equal(proposalB.toBase58());
  });

  it("proposal status label handles unknown code and known pass/reject semantics", () => {
    expect(proposalStatusLabel(ProposalStatus.Active)).to.equal("Active");
    expect(proposalStatusLabel(ProposalStatus.Passed)).to.equal("Passed");
    expect(proposalStatusLabel(ProposalStatus.Rejected)).to.equal("Rejected");
    expect(proposalStatusLabel(255)).to.equal("Unknown");

    // Executed proposals remain status=Passed; executed is a separate field.
    expect(proposalStatusLabel(ProposalStatus.Passed)).to.equal("Passed");
  });

  it("close_proposal builder wires stakingPool + governanceConfig + proposal accounts", async () => {
    const [stakingPool] = findStakingPool(TEST_PROGRAM_ID);
    const [governanceConfig] = findGovernanceConfig(TEST_PROGRAM_ID);
    const [proposal] = findProposal(7, stakingPool, TEST_PROGRAM_ID);

    const captured = createMethodCaptureProgram();

    await createCloseProposalInstruction(
      captured.program,
      captured.signer,
      7,
      TEST_PROGRAM_ID,
      stakingPool
    );

    expect(captured.methodName).to.equal("closeProposal");
    expect(captured.accountsStrict?.anyone?.toBase58()).to.equal(
      captured.signer.toBase58()
    );
    expect(captured.accountsStrict?.stakingPool?.toBase58()).to.equal(
      stakingPool.toBase58()
    );
    expect(captured.accountsStrict?.governanceConfig?.toBase58()).to.equal(
      governanceConfig.toBase58()
    );
    expect(captured.accountsStrict?.proposal?.toBase58()).to.equal(
      proposal.toBase58()
    );
  });

  it("governance initiate exit builder wires proposal + governance config + dlmm exit", async () => {
    const [stakingPool] = findStakingPool(TEST_PROGRAM_ID);
    const [governanceConfig] = findGovernanceConfig(TEST_PROGRAM_ID);
    const assetMint = keyFromSeed(7);
    const dlmmPool = keyFromSeed(33);
    const position = keyFromSeed(55);
    const [proposal] = findProposal(5, stakingPool, TEST_PROGRAM_ID);

    const captured = createMethodCaptureProgram();

    await createGovernanceInitiateExitInstruction(
      captured.program,
      captured.signer,
      5,
      assetMint,
      dlmmPool,
      position,
      TEST_PROGRAM_ID,
      stakingPool
    );

    expect(captured.methodName).to.equal("governanceInitiateExit");
    expect(captured.accountsStrict?.authority?.toBase58()).to.equal(
      captured.signer.toBase58()
    );
    expect(captured.accountsStrict?.stakingPool?.toBase58()).to.equal(
      stakingPool.toBase58()
    );
    expect(captured.accountsStrict?.governanceConfig?.toBase58()).to.equal(
      governanceConfig.toBase58()
    );
    expect(captured.accountsStrict?.proposal?.toBase58()).to.equal(
      proposal.toBase58()
    );
    expect(captured.accountsStrict?.dlmmExit).to.be.instanceOf(PublicKey);
    expect(captured.accountsStrict?.systemProgram?.toBase58()).to.equal(
      SystemProgram.programId.toBase58()
    );
  });

  it("admin builders wire owner + stakingPool + governanceConfig", async () => {
    const [stakingPool] = findStakingPool(TEST_PROGRAM_ID);
    const [governanceConfig] = findGovernanceConfig(TEST_PROGRAM_ID);

    const autoExecCapture = createMethodCaptureProgram();
    await createSetAutoExecuteInstruction(
      autoExecCapture.program,
      autoExecCapture.signer,
      true,
      TEST_PROGRAM_ID
    );

    expect(autoExecCapture.methodName).to.equal("setAutoExecute");
    expect(autoExecCapture.accountsStrict?.owner?.toBase58()).to.equal(
      autoExecCapture.signer.toBase58()
    );
    expect(autoExecCapture.accountsStrict?.stakingPool?.toBase58()).to.equal(
      stakingPool.toBase58()
    );
    expect(autoExecCapture.accountsStrict?.governanceConfig?.toBase58()).to.equal(
      governanceConfig.toBase58()
    );

    const quorumCapture = createMethodCaptureProgram();
    await createSetQuorumInstruction(
      quorumCapture.program,
      quorumCapture.signer,
      2500,
      TEST_PROGRAM_ID
    );

    expect(quorumCapture.methodName).to.equal("setQuorum");
    expect(quorumCapture.accountsStrict?.owner?.toBase58()).to.equal(
      quorumCapture.signer.toBase58()
    );
    expect(quorumCapture.accountsStrict?.stakingPool?.toBase58()).to.equal(
      stakingPool.toBase58()
    );
    expect(quorumCapture.accountsStrict?.governanceConfig?.toBase58()).to.equal(
      governanceConfig.toBase58()
    );
  });

  it("setQuorum builder rejects out-of-range quorum values", () => {
    const captured = createMethodCaptureProgram();

    expect(() =>
      createSetQuorumInstruction(
        captured.program,
        captured.signer,
        -1,
        TEST_PROGRAM_ID
      )
    ).to.throw("minQuorumBps");

    expect(() =>
      createSetQuorumInstruction(
        captured.program,
        captured.signer,
        10001,
        TEST_PROGRAM_ID
      )
    ).to.throw("minQuorumBps");
  });
});

function keyFromSeed(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (seed + i) % 255;
  }
  return new PublicKey(bytes);
}

function createMethodCaptureProgram() {
  const signer = keyFromSeed(123);

  const state: {
    methodName: string | null;
    accountsStrict: Record<string, any> | null;
  } = {
    methodName: null,
    accountsStrict: null,
  };

  const makeBuilder = (methodName: string) => {
    state.methodName = methodName;

    return {
      accountsStrict(accounts: Record<string, any>) {
        state.accountsStrict = accounts;
        return {
          instruction: async () =>
            ({
              programId: TEST_PROGRAM_ID,
              keys: [],
              data: Buffer.alloc(0),
            }) as TransactionInstruction,
        };
      },
    };
  };

  return {
    signer,
    get methodName() {
      return state.methodName;
    },
    get accountsStrict() {
      return state.accountsStrict;
    },
    program: {
      methods: {
        closeProposal: () => makeBuilder("closeProposal"),
        governanceInitiateExit: () => makeBuilder("governanceInitiateExit"),
        setAutoExecute: () => makeBuilder("setAutoExecute"),
        setQuorum: () => makeBuilder("setQuorum"),
      },
    } as any,
  };
}
