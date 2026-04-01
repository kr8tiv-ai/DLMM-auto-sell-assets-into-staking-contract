import { expect } from "chai";
import * as sinon from "sinon";
import { PublicKey, Transaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  createOneSidedPosition,
  monitorPosition,
  claimFees,
  closePosition,
  _setDlmmSdk,
} from "../src/dlmm-lifecycle";

const FAKE_POOL = PublicKey.default; // 11111...1111 (system program)
const FAKE_POSITION = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function makeFakeKeypair() {
  const { Keypair } = require("@solana/web3.js");
  return Keypair.generate();
}

function makeMockDlmmPool() {
  return {
    getActiveBin: sinon.stub().resolves({ binId: 100 }),
    initializePositionAndAddLiquidityByStrategy: sinon
      .stub()
      .resolves(new Transaction()),
    getPositionsByUserAndLbPair: sinon.stub().resolves({
      userPositions: [
        {
          publicKey: FAKE_POSITION,
          positionData: {
            feeX: new BN(5000),
            feeY: new BN(10000),
          },
        },
      ],
    }),
    claimAllRewards: sinon.stub().resolves([new Transaction()]),
    removeLiquidity: sinon.stub().resolves(new Transaction()),
  };
}

describe("dlmm-lifecycle", () => {
  let mockPool: ReturnType<typeof makeMockDlmmPool>;
  let mockSdk: { create: sinon.SinonStub };

  beforeEach(() => {
    mockPool = makeMockDlmmPool();
    mockSdk = {
      create: sinon.stub().resolves(mockPool),
    };
    _setDlmmSdk(mockSdk);
  });

  afterEach(() => {
    sinon.restore();
    _setDlmmSdk(null as any);
  });

  describe("createOneSidedPosition", () => {
    it("creates a position with totalYAmount=0 (one-sided X)", async () => {
      const wallet = makeFakeKeypair();
      const result = await createOneSidedPosition(
        null as any, // connection not used with mock
        wallet,
        FAKE_POOL,
        new BN(1_000_000),
        10
      );

      expect(result).to.be.instanceOf(Transaction);
      expect(mockSdk.create.calledOnce).to.be.true;
      expect(mockPool.getActiveBin.calledOnce).to.be.true;

      const callArgs =
        mockPool.initializePositionAndAddLiquidityByStrategy.firstCall
          .args[0];
      expect(callArgs.totalYAmount.toNumber()).to.equal(0);
      expect(callArgs.totalXAmount.toNumber()).to.equal(1_000_000);
      expect(callArgs.strategy.minBinId).to.equal(100);
      expect(callArgs.strategy.maxBinId).to.equal(110);
    });
  });

  describe("monitorPosition", () => {
    it("returns fee data for user positions", async () => {
      const wallet = makeFakeKeypair();
      const results = await monitorPosition(
        null as any,
        wallet,
        FAKE_POOL
      );

      expect(results).to.have.length(1);
      expect(results[0].positionPubkey).to.deep.equal(FAKE_POSITION);
      expect(results[0].feeX).to.equal(BigInt(5000));
      expect(results[0].feeY).to.equal(BigInt(10000));
    });

    it("returns empty array when no positions found", async () => {
      mockPool.getPositionsByUserAndLbPair.resolves({
        userPositions: [],
      });

      const wallet = makeFakeKeypair();
      const results = await monitorPosition(
        null as any,
        wallet,
        FAKE_POOL
      );
      expect(results).to.deep.equal([]);
    });

    it("logs error with position pubkey when position data missing", async () => {
      mockPool.getPositionsByUserAndLbPair.resolves({
        userPositions: [
          {
            publicKey: FAKE_POSITION,
            positionData: null,
          },
        ],
      });

      const wallet = makeFakeKeypair();
      const results = await monitorPosition(
        null as any,
        wallet,
        FAKE_POOL
      );
      // Should handle gracefully - feeX/feeY default to 0
      expect(results).to.have.length(1);
      expect(results[0].feeX).to.equal(BigInt(0));
      expect(results[0].feeY).to.equal(BigInt(0));
    });
  });

  describe("claimFees", () => {
    it("returns transactions from claimAllRewards", async () => {
      const wallet = makeFakeKeypair();
      const txs = await claimFees(
        null as any,
        wallet,
        FAKE_POOL,
        [FAKE_POSITION]
      );

      expect(txs).to.have.length(1);
      expect(txs[0]).to.be.instanceOf(Transaction);
      expect(
        mockPool.claimAllRewards.calledOnceWith({
          owner: wallet.publicKey,
          positions: [FAKE_POSITION],
        })
      ).to.be.true;
    });

    it("logs error and continues when claim fails for a position", async () => {
      mockPool.claimAllRewards.rejects(new Error("Claim failed"));

      const wallet = makeFakeKeypair();
      const txs = await claimFees(
        null as any,
        wallet,
        FAKE_POOL,
        [FAKE_POSITION]
      );

      expect(txs).to.have.length(0);
    });
  });

  describe("closePosition", () => {
    it("returns transactions from removeLiquidity with 100% bps", async () => {
      const wallet = makeFakeKeypair();
      const txs = await closePosition(
        null as any,
        wallet,
        FAKE_POOL,
        [FAKE_POSITION]
      );

      expect(txs).to.have.length(1);

      const callArgs = mockPool.removeLiquidity.firstCall.args[0];
      expect(callArgs.position).to.deep.equal(FAKE_POSITION);
      expect(callArgs.bps.toNumber()).to.equal(10000);
    });

    it("logs error and continues when removal fails", async () => {
      mockPool.removeLiquidity.rejects(
        new Error("Position not found")
      );

      const wallet = makeFakeKeypair();
      const txs = await closePosition(
        null as any,
        wallet,
        FAKE_POOL,
        [FAKE_POSITION]
      );

      expect(txs).to.have.length(0);
    });
  });
});
