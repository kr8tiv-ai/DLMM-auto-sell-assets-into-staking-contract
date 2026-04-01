import { expect } from "chai";
import * as sinon from "sinon";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  terminateSingleExit,
  emergencyHaltAll,
  EmergencyDeps,
  TerminateExitResult,
  EmergencyHaltResult,
} from "../src/emergency";
import { DlmmExitAccount, ExitStatus } from "../src/types";
import { CrankConfig } from "../src/config";

function makeConfig(overrides: Partial<CrankConfig> = {}): CrankConfig {
  return {
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    crankKeypairPath: "/tmp/test-keypair.json",
    programId: "11111111111111111111111111111111",
    pollIntervalMs: 100,
    claimThresholdLamports: 1000,
    jitoBlockEngineUrl: "https://jito.test",
    jitoTipLamports: 10000,
    idlPath: "../target/idl/brain_staking.json",
    stakingPool: "11111111111111111111111111111111",
    heartbeatPath: "./heartbeat.txt",
    ...overrides,
  };
}

function makeExit(overrides: Partial<DlmmExitAccount> = {}): DlmmExitAccount {
  return {
    pool: PublicKey.unique(),
    owner: PublicKey.unique(),
    assetMint: PublicKey.unique(),
    dlmmPool: PublicKey.unique(),
    position: PublicKey.unique(),
    totalSolClaimed: BigInt(5000),
    status: ExitStatus.Active,
    createdAt: Math.floor(Date.now() / 1000),
    completedAt: 0,
    bump: 255,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<EmergencyDeps> = {}): EmergencyDeps {
  return {
    fetchActiveExits: sinon.stub().resolves([]),
    closePosition: sinon.stub().resolves([new Transaction()]),
    claimFees: sinon.stub().resolves([new Transaction()]),
    unwrapWsol: sinon.stub().resolves(null),
    submitWithJitoFallback: sinon
      .stub()
      .resolves([{ bundleId: "mock-bundle", landed: true }]),
    buildTerminateExitTx: sinon.stub().returns(new Transaction()),
    buildEmergencyHaltTx: sinon.stub().returns(new Transaction()),
    buildDepositRewardsTx: sinon.stub().returns(new Transaction()),
    transferAssetToTreasury: sinon.stub().resolves("mock-sig"),
    ...overrides,
  };
}

describe("emergency", () => {
  let connectionStub: sinon.SinonStubbedInstance<Connection>;
  let wallet: Keypair;

  beforeEach(() => {
    connectionStub = sinon.createStubInstance(Connection);
    wallet = Keypair.generate();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("terminateSingleExit", () => {
    it("happy path — all 6 steps succeed", async () => {
      const exit = makeExit();
      const exitPda = PublicKey.unique();
      const deps = makeDeps();
      const config = makeConfig();

      const result = await terminateSingleExit(
        connectionStub as unknown as Connection,
        wallet,
        config,
        exitPda,
        exit,
        deps
      );

      expect(result.success).to.be.true;
      expect(result.exitPda).to.equal(exitPda.toBase58());
      expect(result.steps).to.have.length(6);
      expect(result.steps.every((s) => s.success)).to.be.true;

      // Verify each dep was called
      expect((deps.closePosition as sinon.SinonStub).calledOnce).to.be.true;
      expect((deps.claimFees as sinon.SinonStub).calledOnce).to.be.true;
      expect((deps.unwrapWsol as sinon.SinonStub).calledOnce).to.be.true;
      expect((deps.buildDepositRewardsTx as sinon.SinonStub).calledOnce).to.be
        .true;
      expect((deps.transferAssetToTreasury as sinon.SinonStub).calledOnce).to
        .be.true;
      expect((deps.buildTerminateExitTx as sinon.SinonStub).calledOnce).to.be
        .true;
      // submitWithJitoFallback called twice: once for deposit, once for terminate
      expect((deps.submitWithJitoFallback as sinon.SinonStub).calledTwice).to
        .be.true;
    });

    it("partial failure — closePosition fails, remaining steps continue", async () => {
      const exit = makeExit();
      const exitPda = PublicKey.unique();
      const deps = makeDeps({
        closePosition: sinon
          .stub()
          .rejects(new Error("Meteora SDK timeout")),
      });
      const config = makeConfig();

      const result = await terminateSingleExit(
        connectionStub as unknown as Connection,
        wallet,
        config,
        exitPda,
        exit,
        deps
      );

      expect(result.success).to.be.false;
      expect(result.steps).to.have.length(6);

      // closePosition failed
      const closeStep = result.steps.find(
        (s) => s.step === "closePosition"
      );
      expect(closeStep?.success).to.be.false;
      expect(closeStep?.error).to.equal("Meteora SDK timeout");

      // Remaining steps still ran
      const otherSteps = result.steps.filter(
        (s) => s.step !== "closePosition"
      );
      expect(otherSteps.every((s) => s.success)).to.be.true;
    });

    it("partial failure — claimFees fails, other steps still execute", async () => {
      const exit = makeExit();
      const exitPda = PublicKey.unique();
      const deps = makeDeps({
        claimFees: sinon.stub().rejects(new Error("RPC flake")),
      });
      const config = makeConfig();

      const result = await terminateSingleExit(
        connectionStub as unknown as Connection,
        wallet,
        config,
        exitPda,
        exit,
        deps
      );

      expect(result.success).to.be.false;
      expect(result.steps).to.have.length(6);

      const claimStep = result.steps.find((s) => s.step === "claimFees");
      expect(claimStep?.success).to.be.false;
      expect(claimStep?.error).to.equal("RPC flake");

      // Steps after claimFees still ran
      const unwrapStep = result.steps.find((s) => s.step === "unwrapWsol");
      expect(unwrapStep?.success).to.be.true;
      const terminateStep = result.steps.find(
        (s) => s.step === "terminateExit"
      );
      expect(terminateStep?.success).to.be.true;
    });

    it("result structure — includes all step names in order", async () => {
      const exit = makeExit();
      const exitPda = PublicKey.unique();
      const deps = makeDeps();
      const config = makeConfig();

      const result = await terminateSingleExit(
        connectionStub as unknown as Connection,
        wallet,
        config,
        exitPda,
        exit,
        deps
      );

      const stepNames = result.steps.map((s) => s.step);
      expect(stepNames).to.deep.equal([
        "closePosition",
        "claimFees",
        "unwrapWsol",
        "depositRewards",
        "transferAssetToTreasury",
        "terminateExit",
      ]);
    });
  });

  describe("emergencyHaltAll", () => {
    it("happy path — 2 active exits both terminate, halt tx lands", async () => {
      const exit1 = makeExit();
      const exit2 = makeExit();
      const pda1 = PublicKey.unique();
      const pda2 = PublicKey.unique();

      const deps = makeDeps({
        fetchActiveExits: sinon.stub().resolves([
          { publicKey: pda1, account: exit1 },
          { publicKey: pda2, account: exit2 },
        ]),
      });
      const config = makeConfig();

      const result = await emergencyHaltAll(
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      expect(result.totalExits).to.equal(2);
      expect(result.successfulExits).to.equal(2);
      expect(result.failedExits).to.equal(0);
      expect(result.haltTxSubmitted).to.be.true;
      expect(result.exitResults).to.have.length(2);

      // buildEmergencyHaltTx called with both PDAs
      const haltStub = deps.buildEmergencyHaltTx as sinon.SinonStub;
      expect(haltStub.calledOnce).to.be.true;
      const pdaArgs = haltStub.firstCall.args[0] as PublicKey[];
      expect(pdaArgs).to.have.length(2);
    });

    it("zero active exits — halt tx still submitted", async () => {
      const deps = makeDeps({
        fetchActiveExits: sinon.stub().resolves([]),
      });
      const config = makeConfig();

      const result = await emergencyHaltAll(
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      expect(result.totalExits).to.equal(0);
      expect(result.exitResults).to.have.length(0);
      expect(result.haltTxSubmitted).to.be.true;

      // buildEmergencyHaltTx called with empty array
      const haltStub = deps.buildEmergencyHaltTx as sinon.SinonStub;
      expect(haltStub.calledOnce).to.be.true;
      const pdaArgs = haltStub.firstCall.args[0] as PublicKey[];
      expect(pdaArgs).to.have.length(0);
    });

    it("partial failure — 1 of 2 exits fails, other completes, halt still submitted", async () => {
      const exit1 = makeExit();
      const exit2 = makeExit();
      const pda1 = PublicKey.unique();
      const pda2 = PublicKey.unique();

      // closePosition fails only for exit1's dlmmPool
      const closeStub = sinon.stub();
      closeStub
        .withArgs(
          sinon.match.any,
          sinon.match.any,
          exit1.dlmmPool,
          sinon.match.any
        )
        .rejects(new Error("Pool frozen"));
      closeStub.resolves([new Transaction()]);

      const deps = makeDeps({
        fetchActiveExits: sinon.stub().resolves([
          { publicKey: pda1, account: exit1 },
          { publicKey: pda2, account: exit2 },
        ]),
        closePosition: closeStub,
      });
      const config = makeConfig();

      const result = await emergencyHaltAll(
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      expect(result.totalExits).to.equal(2);
      // exit1 has partial failure (closePosition failed), exit2 succeeds fully
      expect(result.failedExits).to.equal(1);
      expect(result.successfulExits).to.equal(1);
      expect(result.haltTxSubmitted).to.be.true;

      // Both exits were attempted
      expect(result.exitResults).to.have.length(2);
    });

    it("halt tx failure — exits terminate but halt tx fails to land", async () => {
      const exit1 = makeExit();
      const pda1 = PublicKey.unique();

      const submitStub = sinon.stub();
      // First two calls succeed (deposit + terminate for exit1)
      submitStub.onCall(0).resolves([{ bundleId: "b1", landed: true }]);
      submitStub.onCall(1).resolves([{ bundleId: "b2", landed: true }]);
      // Third call (halt tx) fails
      submitStub
        .onCall(2)
        .resolves([{ bundleId: "b3", landed: false, error: "Jito down" }]);

      const deps = makeDeps({
        fetchActiveExits: sinon.stub().resolves([
          { publicKey: pda1, account: exit1 },
        ]),
        submitWithJitoFallback: submitStub,
      });
      const config = makeConfig();

      const result = await emergencyHaltAll(
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      expect(result.successfulExits).to.equal(1);
      expect(result.haltTxSubmitted).to.be.false;
      expect(result.haltError).to.include("Jito down");
    });
  });
});
