import { expect } from "chai";
import * as sinon from "sinon";
import { withRetry } from "../src/retry";

describe("retry", () => {
  let clock: sinon.SinonFakeTimers;

  afterEach(() => {
    sinon.restore();
  });

  it("returns immediately on first success", async () => {
    const fn = sinon.stub().resolves(42);
    const sleeps: number[] = [];

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 5000,
      sleepFn: async (ms) => { sleeps.push(ms); },
    });

    expect(result).to.equal(42);
    expect(fn.callCount).to.equal(1);
    expect(sleeps).to.have.length(0);
  });

  it("retries and succeeds on third attempt", async () => {
    const fn = sinon.stub();
    fn.onCall(0).rejects(new Error("fail 1"));
    fn.onCall(1).rejects(new Error("fail 2"));
    fn.onCall(2).resolves("ok");

    const sleeps: number[] = [];
    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 5000,
      sleepFn: async (ms) => { sleeps.push(ms); },
    });

    expect(result).to.equal("ok");
    expect(fn.callCount).to.equal(3);
    expect(sleeps).to.have.length(2);
  });

  it("throws last error when all retries exhausted", async () => {
    const fn = sinon.stub();
    fn.onCall(0).rejects(new Error("err-0"));
    fn.onCall(1).rejects(new Error("err-1"));
    fn.onCall(2).rejects(new Error("err-2"));
    fn.onCall(3).rejects(new Error("err-3"));

    const sleeps: number[] = [];

    try {
      await withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
        sleepFn: async (ms) => { sleeps.push(ms); },
      });
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.message).to.equal("err-3");
    }

    // 1 initial + 3 retries = 4 total attempts
    expect(fn.callCount).to.equal(4);
    expect(sleeps).to.have.length(3);
  });

  it("respects maxDelayMs cap", async () => {
    const fn = sinon.stub();
    fn.onCall(0).rejects(new Error("fail"));
    fn.onCall(1).rejects(new Error("fail"));
    fn.onCall(2).rejects(new Error("fail"));
    fn.onCall(3).resolves("done");

    const sleeps: number[] = [];
    await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 2000,
      sleepFn: async (ms) => { sleeps.push(ms); },
    });

    // All delays should be <= maxDelay * 2 (capped + jitter <= 2 * maxDelay)
    for (const s of sleeps) {
      expect(s).to.be.at.most(2000 * 2);
    }
  });

  it("applies exponential backoff with jitter", async () => {
    const fn = sinon.stub();
    fn.onCall(0).rejects(new Error("fail"));
    fn.onCall(1).rejects(new Error("fail"));
    fn.onCall(2).resolves("ok");

    const sleeps: number[] = [];

    // Use a fixed Math.random for predictability
    const randomStub = sinon.stub(Math, "random").returns(0.5);

    await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 10000,
      sleepFn: async (ms) => { sleeps.push(ms); },
    });

    randomStub.restore();

    // Attempt 0 fail: delay = min(100 * 2^0, 10000) + 0.5 * min(100 * 2^0, 10000) = 100 + 50 = 150
    expect(sleeps[0]).to.equal(150);
    // Attempt 1 fail: delay = min(100 * 2^1, 10000) + 0.5 * min(100 * 2^1, 10000) = 200 + 100 = 300
    expect(sleeps[1]).to.equal(300);
  });
});
