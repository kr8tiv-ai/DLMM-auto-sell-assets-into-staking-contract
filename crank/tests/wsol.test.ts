import { expect } from "chai";
import * as sinon from "sinon";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { TokenAccountNotFoundError } from "@solana/spl-token";
import { unwrapWsol, WsolDeps } from "../src/wsol";

describe("wsol", () => {
  let connectionStub: sinon.SinonStubbedInstance<Connection>;
  let wallet: Keypair;
  const FAKE_ATA = PublicKey.default;
  const FAKE_NATIVE_MINT = PublicKey.default;

  function makeDeps(overrides: Partial<WsolDeps> = {}): WsolDeps {
    return {
      getAssociatedTokenAddress: sinon.stub().resolves(FAKE_ATA),
      getAccount: sinon.stub().resolves({ amount: BigInt(1_000_000) }),
      createCloseAccountInstruction: sinon.stub().returns({
        programId: PublicKey.default,
        keys: [],
        data: Buffer.alloc(0),
      }),
      NATIVE_MINT: FAKE_NATIVE_MINT,
      ...overrides,
    };
  }

  beforeEach(() => {
    wallet = Keypair.generate();
    connectionStub = sinon.createStubInstance(Connection);
  });

  afterEach(() => {
    sinon.restore();
  });

  it("returns null (no-op) when WSOL ATA does not exist", async () => {
    const deps = makeDeps({
      getAccount: sinon.stub().rejects(new TokenAccountNotFoundError()),
    });

    const result = await unwrapWsol(
      connectionStub as unknown as Connection,
      wallet,
      deps
    );
    expect(result).to.equal(null);
  });

  it("returns null (no-op) when WSOL ATA has zero balance", async () => {
    const deps = makeDeps({
      getAccount: sinon.stub().resolves({ amount: BigInt(0) }),
    });

    const result = await unwrapWsol(
      connectionStub as unknown as Connection,
      wallet,
      deps
    );
    expect(result).to.equal(null);
  });

  it("closes WSOL ATA and returns signature when balance > 0", async () => {
    const deps = makeDeps();
    connectionStub.sendTransaction.resolves("fakeTxSig123");

    const result = await unwrapWsol(
      connectionStub as unknown as Connection,
      wallet,
      deps
    );
    expect(result).to.equal("fakeTxSig123");
    expect((deps.createCloseAccountInstruction as sinon.SinonStub).calledOnce).to.be.true;
  });
});
