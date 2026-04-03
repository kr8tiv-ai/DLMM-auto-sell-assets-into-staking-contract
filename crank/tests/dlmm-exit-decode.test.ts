import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import {
  deserializeDlmmExit,
  DLMM_EXIT_TOTAL_ACCOUNT_SIZE,
  DLMM_EXIT_DISCRIMINATOR_SIZE,
} from "../src/index";
import { ExitStatus } from "../src/types";

interface ExitBufferOverrides {
  status?: number;
  proposalId?: bigint;
  totalSolClaimed?: bigint;
  createdAt?: bigint;
  completedAt?: bigint;
}

function buildDlmmExitBuffer(overrides: ExitBufferOverrides = {}): Buffer {
  const data = Buffer.alloc(DLMM_EXIT_TOTAL_ACCOUNT_SIZE);
  let offset = DLMM_EXIT_DISCRIMINATOR_SIZE;

  const pool = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const assetMint = Keypair.generate().publicKey;
  const dlmmPool = Keypair.generate().publicKey;
  const position = Keypair.generate().publicKey;

  for (const key of [pool, owner, assetMint, dlmmPool, position]) {
    key.toBuffer().copy(data, offset);
    offset += 32;
  }

  data.writeBigUInt64LE(overrides.totalSolClaimed ?? 1234n, offset);
  offset += 8;

  data.writeUInt8(overrides.status ?? ExitStatus.Active, offset);
  offset += 1;

  data.writeBigInt64LE(overrides.createdAt ?? 1_700_000_000n, offset);
  offset += 8;

  data.writeBigInt64LE(overrides.completedAt ?? 0n, offset);
  offset += 8;

  data.writeBigUInt64LE(overrides.proposalId ?? 0n, offset);
  offset += 8;

  data.writeUInt8(255, offset);

  return data;
}

describe("dlmm exit decode", () => {
  it("decodes manual exits with proposal id provenance = 0", () => {
    const decoded = deserializeDlmmExit(buildDlmmExitBuffer({ proposalId: 0n }));

    expect(decoded.status).to.equal(ExitStatus.Active);
    expect(decoded.proposalId).to.equal(0n);
  });

  it("decodes governance-triggered exits and keeps proposal id provenance", () => {
    const decoded = deserializeDlmmExit(
      buildDlmmExitBuffer({
        status: ExitStatus.Completed,
        proposalId: 42n,
        completedAt: 1_700_000_999n,
      })
    );

    expect(decoded.status).to.equal(ExitStatus.Completed);
    expect(decoded.proposalId).to.equal(42n);
    expect(decoded.completedAt).to.equal(1_700_000_999);
  });

  it("throws on malformed short buffers", () => {
    const malformed = Buffer.alloc(DLMM_EXIT_TOTAL_ACCOUNT_SIZE - 1);

    expect(() => deserializeDlmmExit(malformed)).to.throw(
      /Invalid DlmmExit account length/
    );
  });

  it("throws on impossible status byte", () => {
    const malformed = buildDlmmExitBuffer({ status: 9 });

    expect(() => deserializeDlmmExit(malformed)).to.throw(
      /Invalid DlmmExit status byte/
    );
  });

  it("supports max u64 proposal id provenance boundary", () => {
    const maxU64 = (1n << 64n) - 1n;
    const decoded = deserializeDlmmExit(
      buildDlmmExitBuffer({ proposalId: maxU64 })
    );

    expect(decoded.proposalId).to.equal(maxU64);
  });
});
