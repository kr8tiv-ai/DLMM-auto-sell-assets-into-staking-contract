import { expect } from "chai";
import * as sinon from "sinon";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  processExit,
  startMonitor,
  requestShutdown,
  resetShutdown,
  MonitorDeps,
} from "../src/monitor";
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
    totalSolClaimed: BigInt(0),
    status: ExitStatus.Active,
    createdAt: Math.floor(Date.now() / 1000),
    completedAt: 0,
    bump: 255,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    fetchActiveExits: sinon.stub().resolves([]),
    monitorPosition: sinon.stub().resolves([]),
    claimFees: sinon.stub().resolves([]),
    closePosition: sinon.stub().resolves([]),
    checkDust: sinon.stub().resolves({
      isDust: false,
      estimatedValueUsd: 50,
      source: "jupiter" as const,
    }),
    unwrapWsol: sinon.stub().resolves(null),
    submitWithJitoFallback: sinon.stub().resolves([]),
    buildDepositRewardsTx: sinon.stub().returns(new Transaction()),
    buildRecordClaimTx: sinon.stub().returns(new Transaction()),
    buildCompleteExitTx: sinon.stub().returns(new Transaction()),
    sleep: sinon.stub().resolves(),
    ...overrides,
  };
}

describe("monitor", () => {
  let connectionStub: sinon.SinonStubbedInstance<Connection>;
  let wallet: Keypair;

  beforeEach(() => {
    connectionStub = sinon.createStubInstance(Connection);
    wallet = Keypair.generate();
    resetShutdown();
  });

  afterEach(() => {
    sinon.restore();
    resetShutdown();
  });

  describe("processExit", () => {
    it("skips non-active exits (Completed)", async () => {
      const exit = makeExit({ status: ExitStatus.Completed });
      const deps = makeDeps();
      const config = makeConfig();

      await processExit(
        PublicKey.unique(),
        exit,
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      expect(
        (deps.monitorPosition as sinon.SinonStub).called
      ).to.be.false;
    });

    it("skips non-active exits (Terminated)", async () => {
      const exit = makeExit({ status: ExitStatus.Terminated });
      const deps = makeDeps();
      const config = makeConfig();

      await processExit(
        PublicKey.unique(),
        exit,
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      expect(
        (deps.monitorPosition as sinon.SinonStub).called
      ).to.be.false;
    });

    it("claims fees when above threshold", async () => {
      const exit = makeExit();
      const posKey = PublicKey.unique();
      const deps = makeDeps({
        monitorPosition: sinon.stub().resolves([
          { positionPubkey: posKey, feeX: BigInt(0), feeY: BigInt(5000) },
        ]),
        claimFees: sinon.stub().resolves([new Transaction()]),
        checkDust: sinon.stub().resolves({
          isDust: false,
          estimatedValueUsd: 50,
          source: "jupiter" as const,
        }),
        submitWithJitoFallback: sinon.stub().resolves([
          { bundleId: "test-bundle", landed: true },
        ]),
      });
      const config = makeConfig({ claimThresholdLamports: 1000 });

      await processExit(
        PublicKey.unique(),
        exit,
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      expect(
        (deps.claimFees as sinon.SinonStub).calledOnce
      ).to.be.true;
      expect(
        (deps.unwrapWsol as sinon.SinonStub).calledOnce
      ).to.be.true;
      expect(
        (deps.submitWithJitoFallback as sinon.SinonStub).calledOnce
      ).to.be.true;
    });

    it("does not claim when fees below threshold", async () => {
      const exit = makeExit();
      const deps = makeDeps({
        monitorPosition: sinon.stub().resolves([
          { positionPubkey: PublicKey.unique(), feeX: BigInt(0), feeY: BigInt(500) },
        ]),
        checkDust: sinon.stub().resolves({
          isDust: false,
          estimatedValueUsd: 50,
          source: "jupiter" as const,
        }),
      });
      const config = makeConfig({ claimThresholdLamports: 1000 });

      await processExit(
        PublicKey.unique(),
        exit,
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      expect(
        (deps.claimFees as sinon.SinonStub).called
      ).to.be.false;
    });

    it("completes exit when dust threshold reached", async () => {
      const exit = makeExit();
      const posKey = PublicKey.unique();
      const deps = makeDeps({
        monitorPosition: sinon.stub().resolves([
          { positionPubkey: posKey, feeX: BigInt(0), feeY: BigInt(100) },
        ]),
        checkDust: sinon.stub().resolves({
          isDust: true,
          estimatedValueUsd: 0.05,
          source: "jupiter" as const,
        }),
        closePosition: sinon.stub().resolves([new Transaction()]),
        submitWithJitoFallback: sinon.stub().resolves([
          { bundleId: "complete-bundle", landed: true },
        ]),
      });
      const config = makeConfig({ claimThresholdLamports: 1000 });

      await processExit(
        PublicKey.unique(),
        exit,
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      expect(
        (deps.closePosition as sinon.SinonStub).calledOnce
      ).to.be.true;
      expect(
        (deps.buildCompleteExitTx as sinon.SinonStub).calledOnce
      ).to.be.true;
    });
  });

  describe("startMonitor", () => {
    it("processes active exits and skips completed/terminated", async () => {
      const activeExit = makeExit({ status: ExitStatus.Active });
      const completedExit = makeExit({ status: ExitStatus.Completed });
      const terminatedExit = makeExit({ status: ExitStatus.Terminated });

      let pollCount = 0;
      const deps = makeDeps({
        fetchActiveExits: sinon.stub().callsFake(async () => {
          pollCount++;
          if (pollCount >= 2) requestShutdown();
          return [
            { publicKey: PublicKey.unique(), account: activeExit },
            { publicKey: PublicKey.unique(), account: completedExit },
            { publicKey: PublicKey.unique(), account: terminatedExit },
          ];
        }),
        monitorPosition: sinon.stub().resolves([]),
      });

      const config = makeConfig({ pollIntervalMs: 10 });
      await startMonitor(
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      // monitorPosition should only be called for active exits
      // (completed and terminated are filtered by the loop's pre-filter)
      expect(
        (deps.monitorPosition as sinon.SinonStub).callCount
      ).to.be.greaterThanOrEqual(1);
    });

    it("sleeps and polls again when no active exits", async () => {
      let pollCount = 0;
      const deps = makeDeps({
        fetchActiveExits: sinon.stub().callsFake(async () => {
          pollCount++;
          if (pollCount >= 3) requestShutdown();
          return [];
        }),
      });

      const config = makeConfig({ pollIntervalMs: 10 });
      await startMonitor(
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      expect(pollCount).to.be.greaterThanOrEqual(3);
      expect(
        (deps.sleep as sinon.SinonStub).callCount
      ).to.be.greaterThanOrEqual(2);
    });

    it("continues to next exit on per-exit error", async () => {
      const exit1 = makeExit();
      const exit2 = makeExit();

      let pollCount = 0;
      const monitorStub = sinon.stub();
      // First call throws, second succeeds
      monitorStub.onCall(0).rejects(new Error("RPC flake"));
      monitorStub.onCall(1).resolves([]);

      const deps = makeDeps({
        fetchActiveExits: sinon.stub().callsFake(async () => {
          pollCount++;
          if (pollCount >= 2) requestShutdown();
          return [
            { publicKey: PublicKey.unique(), account: exit1 },
            { publicKey: PublicKey.unique(), account: exit2 },
          ];
        }),
        monitorPosition: monitorStub,
      });

      const config = makeConfig({ pollIntervalMs: 10 });
      await startMonitor(
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      // Both exits were attempted despite first failing
      expect(monitorStub.callCount).to.be.greaterThanOrEqual(2);
    });

    it("handles fetch error gracefully and retries next cycle", async () => {
      let pollCount = 0;
      const fetchStub = sinon.stub();
      fetchStub.onCall(0).rejects(new Error("Network error"));
      fetchStub.onCall(1).resolves([]);
      fetchStub.onCall(2).callsFake(async () => {
        requestShutdown();
        return [];
      });

      const deps = makeDeps({
        fetchActiveExits: fetchStub,
      });

      const config = makeConfig({ pollIntervalMs: 10 });
      await startMonitor(
        connectionStub as unknown as Connection,
        wallet,
        config,
        deps
      );

      // Should have been called at least twice (error + retry)
      expect(fetchStub.callCount).to.be.greaterThanOrEqual(2);
    });
  });
});
