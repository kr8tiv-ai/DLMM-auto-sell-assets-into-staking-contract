import { expect } from "chai";
import * as sinon from "sinon";
import { checkDust } from "../src/dust-detection";
import { DustCheckResult } from "../src/types";

const FAKE_MINT = "FakeMint1111111111111111111111111111111111111";
const FAKE_PYTH_FEED = "0xabc123";

describe("dust-detection", () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, "fetch");
  });

  afterEach(() => {
    sinon.restore();
  });

  it("returns isDust=true when Jupiter price shows < $1 value", async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          data: {
            [FAKE_MINT]: { price: "0.0001" },
          },
        }),
        { status: 200 }
      )
    );

    const result = await checkDust(FAKE_MINT, BigInt(1000), 9, FAKE_PYTH_FEED);
    expect(result.isDust).to.equal(true);
    expect(result.source).to.equal("jupiter");
    expect(result.estimatedValueUsd).to.be.a("number");
    expect(result.estimatedValueUsd!).to.be.lessThan(1.0);
  });

  it("returns isDust=false when Jupiter price shows >= $1 value", async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          data: {
            [FAKE_MINT]: { price: "150.0" },
          },
        }),
        { status: 200 }
      )
    );

    // 1e9 smallest units = 1 token * $150 = $150
    const result = await checkDust(
      FAKE_MINT,
      BigInt(1_000_000_000),
      9,
      FAKE_PYTH_FEED
    );
    expect(result.isDust).to.equal(false);
    expect(result.source).to.equal("jupiter");
    expect(result.estimatedValueUsd!).to.be.greaterThanOrEqual(1.0);
  });

  it("falls through to Pyth when Jupiter returns no price", async () => {
    // First call (Jupiter) returns empty data
    fetchStub.onFirstCall().resolves(
      new Response(
        JSON.stringify({ data: {} }),
        { status: 200 }
      )
    );

    // Second call (Pyth) returns valid price
    fetchStub.onSecondCall().resolves(
      new Response(
        JSON.stringify({
          parsed: [
            {
              price: {
                price: "15000000000",
                conf: "100000000",
                expo: -8,
              },
            },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await checkDust(
      FAKE_MINT,
      BigInt(1_000_000_000),
      9,
      FAKE_PYTH_FEED
    );
    expect(result.source).to.equal("pyth");
    expect(result.isDust).to.equal(false);
    expect(result.estimatedValueUsd).to.be.a("number");
  });

  it("skips auto-close when Pyth confidence ratio > 0.5", async () => {
    // Jupiter fails
    fetchStub.onFirstCall().resolves(
      new Response(
        JSON.stringify({ data: {} }),
        { status: 200 }
      )
    );

    // Pyth: conf is 60% of price → ratio > 0.5
    fetchStub.onSecondCall().resolves(
      new Response(
        JSON.stringify({
          parsed: [
            {
              price: {
                price: "10000000000",
                conf: "6000000000",
                expo: -8,
              },
            },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await checkDust(
      FAKE_MINT,
      BigInt(1_000_000_000),
      9,
      FAKE_PYTH_FEED
    );
    expect(result.isDust).to.equal(null);
    expect(result.source).to.equal("pyth");
    expect(result.warning).to.include("confidence ratio");
  });

  it("returns isDust=null and source=none when both Jupiter and Pyth unavailable", async () => {
    // Both calls throw network errors
    fetchStub.rejects(new Error("Network error"));

    const result = await checkDust(
      FAKE_MINT,
      BigInt(1_000_000_000),
      9,
      FAKE_PYTH_FEED
    );
    expect(result.isDust).to.equal(null);
    expect(result.source).to.equal("none");
    expect(result.warning).to.include("unavailable");
  });

  it("handles Jupiter timeout gracefully, falls through to Pyth", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    fetchStub.onFirstCall().rejects(abortError);

    fetchStub.onSecondCall().resolves(
      new Response(
        JSON.stringify({
          parsed: [
            {
              price: {
                price: "500000",
                conf: "10000",
                expo: -4,
              },
            },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await checkDust(
      FAKE_MINT,
      BigInt(1_000_000_000),
      9,
      FAKE_PYTH_FEED
    );
    expect(result.source).to.equal("pyth");
    expect(result.isDust).to.be.a("boolean");
  });
});
