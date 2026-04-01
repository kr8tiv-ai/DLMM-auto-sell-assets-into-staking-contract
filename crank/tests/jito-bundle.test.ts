import { expect } from "chai";
import * as sinon from "sinon";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  buildBundles,
  submitBundle,
  checkBundleStatus,
  pickTipAccount,
  submitWithJitoFallback,
} from "../src/jito-bundle";

describe("jito-bundle", () => {
  let payer: Keypair;
  const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAyFzRkP5x6bLbz8EKxRAQ5E7d";

  beforeEach(() => {
    payer = Keypair.generate();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("pickTipAccount", () => {
    it("returns a PublicKey from the known tip accounts", () => {
      const tip = pickTipAccount();
      expect(tip).to.be.instanceOf(PublicKey);
      // Should be a valid base58 string
      expect(tip.toBase58().length).to.be.greaterThan(30);
    });
  });

  describe("buildBundles", () => {
    function makeTx(): Transaction {
      const tx = new Transaction();
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: PublicKey.unique(),
          lamports: 1000,
        })
      );
      return tx;
    }

    it("builds a single bundle with 1 op tx + 1 tip tx", () => {
      const ops = [makeTx()];
      const bundles = buildBundles(ops, payer, 10000, BLOCKHASH);

      expect(bundles).to.have.length(1);
      expect(bundles[0]).to.have.length(2); // 1 op + 1 tip
      // Each should be valid base64
      for (const b64 of bundles[0]) {
        expect(() => Buffer.from(b64, "base64")).to.not.throw();
      }
    });

    it("builds a single bundle with 4 op txs + 1 tip tx", () => {
      const ops = [makeTx(), makeTx(), makeTx(), makeTx()];
      const bundles = buildBundles(ops, payer, 10000, BLOCKHASH);

      expect(bundles).to.have.length(1);
      expect(bundles[0]).to.have.length(5); // 4 ops + 1 tip
    });

    it("splits into 2 bundles when >4 op txs (6 ops)", () => {
      const ops = Array.from({ length: 6 }, () => makeTx());
      const bundles = buildBundles(ops, payer, 10000, BLOCKHASH);

      expect(bundles).to.have.length(2);
      expect(bundles[0]).to.have.length(5); // 4 ops + 1 tip
      expect(bundles[1]).to.have.length(3); // 2 ops + 1 tip
    });

    it("returns empty array when no operational txs", () => {
      const bundles = buildBundles([], payer, 10000, BLOCKHASH);
      expect(bundles).to.have.length(0);
    });
  });

  describe("submitBundle", () => {
    let fetchStub: sinon.SinonStub;

    beforeEach(() => {
      fetchStub = sinon.stub(globalThis, "fetch");
    });

    it("returns bundle ID on success", async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          result: "bundle-id-123",
        }),
      } as Response);

      const result = await submitBundle(
        "https://jito.test",
        ["base64tx1", "base64tx2"]
      );
      expect(result).to.equal("bundle-id-123");
    });

    it("throws on HTTP error", async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response);

      try {
        await submitBundle("https://jito.test", ["tx"]);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("HTTP 500");
      }
    });

    it("throws on RPC error response", async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          error: { code: -32000, message: "bundle failed" },
        }),
      } as Response);

      try {
        await submitBundle("https://jito.test", ["tx"]);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("Jito RPC error");
      }
    });

    it("throws on invalid bundle ID", async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          result: "",
        }),
      } as Response);

      try {
        await submitBundle("https://jito.test", ["tx"]);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("Invalid bundle ID");
      }
    });
  });

  describe("checkBundleStatus", () => {
    let fetchStub: sinon.SinonStub;

    beforeEach(() => {
      fetchStub = sinon.stub(globalThis, "fetch");
    });

    it("returns landed=true when confirmed", async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          result: {
            value: [{ confirmation_status: "confirmed" }],
          },
        }),
      } as Response);

      const result = await checkBundleStatus(
        "https://jito.test",
        "bundle-123"
      );
      expect(result.landed).to.be.true;
      expect(result.bundleId).to.equal("bundle-123");
    });

    it("returns landed=true when finalized", async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          result: {
            value: [{ confirmation_status: "finalized" }],
          },
        }),
      } as Response);

      const result = await checkBundleStatus(
        "https://jito.test",
        "bundle-123"
      );
      expect(result.landed).to.be.true;
    });

    it("returns landed=false on HTTP error", async () => {
      fetchStub.resolves({
        ok: false,
        status: 503,
      } as Response);

      const result = await checkBundleStatus(
        "https://jito.test",
        "bundle-123"
      );
      expect(result.landed).to.be.false;
      expect(result.error).to.include("HTTP 503");
    });

    it("returns landed=false on timeout", async () => {
      fetchStub.rejects({ name: "AbortError", message: "aborted" });

      const result = await checkBundleStatus(
        "https://jito.test",
        "bundle-123"
      );
      expect(result.landed).to.be.false;
      expect(result.error).to.include("Timeout");
    });
  });

  describe("submitWithJitoFallback", () => {
    let fetchStub: sinon.SinonStub;
    let connectionStub: sinon.SinonStubbedInstance<Connection>;

    beforeEach(() => {
      fetchStub = sinon.stub(globalThis, "fetch");
      connectionStub = sinon.createStubInstance(Connection);
      connectionStub.getLatestBlockhash.resolves({
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 1000,
      });
    });

    it("returns empty array when no txs provided", async () => {
      const results = await submitWithJitoFallback(
        connectionStub as unknown as Connection,
        "https://jito.test",
        [],
        payer,
        10000
      );
      expect(results).to.have.length(0);
    });

    it("falls back to regular tx submission on Jito failure", async () => {
      // Jito fails
      fetchStub.rejects(new Error("Connection refused"));
      // Fallback sendRawTransaction succeeds
      connectionStub.sendRawTransaction.resolves("fallback-sig-1");

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: PublicKey.unique(),
          lamports: 1000,
        })
      );

      const results = await submitWithJitoFallback(
        connectionStub as unknown as Connection,
        "https://jito.test",
        [tx],
        payer,
        10000
      );

      // Should have fallback results (1 op tx sent individually, tip tx skipped)
      expect(results.length).to.be.greaterThan(0);
      expect(results[0].bundleId).to.include("fallback");
    });
  });
});
