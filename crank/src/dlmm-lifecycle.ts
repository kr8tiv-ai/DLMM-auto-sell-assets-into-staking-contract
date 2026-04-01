import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { PositionFeeData } from "./types";

/**
 * DLMM SDK reference. In production this is the Meteora default export;
 * in tests it is swapped via _setDlmmSdk().
 */
let dlmmSdk: any = null;

/**
 * Lazily load the Meteora DLMM SDK.
 * This allows unit tests to mock it before first use.
 */
async function getDlmmSdk(): Promise<any> {
  if (!dlmmSdk) {
    const mod = await import("@meteora-ag/dlmm");
    dlmmSdk = mod.default ?? mod;
  }
  return dlmmSdk;
}

/** Override the DLMM SDK reference (for testing). */
export function _setDlmmSdk(sdk: any): void {
  dlmmSdk = sdk;
}

/**
 * Create a one-sided DLMM position (X-only, SOL side = 0).
 *
 * @param connection - Solana RPC connection
 * @param wallet - Keypair of the position owner
 * @param dlmmPoolAddress - Public key of the DLMM pool
 * @param assetAmount - Amount of asset token (in smallest units) to deposit
 * @param binRange - Number of bins to spread across
 * @returns Transaction to be signed and sent
 */
export async function createOneSidedPosition(
  connection: Connection,
  wallet: Keypair,
  dlmmPoolAddress: PublicKey,
  assetAmount: BN,
  binRange: number
): Promise<Transaction> {
  const sdk = await getDlmmSdk();

  const dlmmPool = await sdk.create(connection, dlmmPoolAddress);
  const activeBin = await dlmmPool.getActiveBin();
  const activeBinId = activeBin.binId;

  // One-sided X position: deposit only the asset token, no SOL (totalYAmount = 0)
  const createPositionTx =
    await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: wallet.publicKey,
      totalXAmount: assetAmount,
      totalYAmount: new BN(0),
      strategy: {
        maxBinId: activeBinId + binRange,
        minBinId: activeBinId,
        strategyType: 0, // Spot strategy
      },
      user: wallet.publicKey,
    });

  console.log(
    `[dlmm-lifecycle] Created one-sided position at bin ${activeBinId}, range ${binRange}`
  );

  return createPositionTx;
}

/**
 * Monitor a DLMM position and return accumulated fee data.
 *
 * @param connection - Solana RPC connection
 * @param wallet - Position owner
 * @param dlmmPoolAddress - DLMM pool address
 * @returns Array of position fee data
 */
export async function monitorPosition(
  connection: Connection,
  wallet: Keypair,
  dlmmPoolAddress: PublicKey
): Promise<PositionFeeData[]> {
  const sdk = await getDlmmSdk();
  const dlmmPool = await sdk.create(connection, dlmmPoolAddress);

  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
    wallet.publicKey
  );

  if (!userPositions || userPositions.length === 0) {
    console.warn(
      `[dlmm-lifecycle] No positions found for ${wallet.publicKey.toBase58()} on pool ${dlmmPoolAddress.toBase58()}`
    );
    return [];
  }

  const results: PositionFeeData[] = userPositions.map((pos: any) => ({
    positionPubkey: pos.publicKey,
    feeX: BigInt(pos.positionData?.feeX?.toString() ?? "0"),
    feeY: BigInt(pos.positionData?.feeY?.toString() ?? "0"),
  }));

  console.log(
    `[dlmm-lifecycle] Monitored ${results.length} position(s), fees: ${JSON.stringify(
      results.map((r) => ({
        pos: r.positionPubkey.toBase58(),
        feeX: r.feeX.toString(),
        feeY: r.feeY.toString(),
      }))
    )}`
  );

  return results;
}

/**
 * Claim accumulated fees from DLMM positions.
 *
 * @param connection - Solana RPC connection
 * @param wallet - Position owner
 * @param dlmmPoolAddress - DLMM pool address
 * @param positions - Position public keys to claim from
 * @returns Array of unsigned transactions for fee claiming
 */
export async function claimFees(
  connection: Connection,
  wallet: Keypair,
  dlmmPoolAddress: PublicKey,
  positions: PublicKey[]
): Promise<Transaction[]> {
  const sdk = await getDlmmSdk();
  const dlmmPool = await sdk.create(connection, dlmmPoolAddress);

  const transactions: Transaction[] = [];

  for (const positionPubkey of positions) {
    try {
      const claimTxs = await dlmmPool.claimAllRewards({
        owner: wallet.publicKey,
        positions: [positionPubkey],
      });
      // claimAllRewards can return a single tx or array
      const txArray = Array.isArray(claimTxs) ? claimTxs : [claimTxs];
      transactions.push(...txArray);
      console.log(
        `[dlmm-lifecycle] Claimed fees from position ${positionPubkey.toBase58()}`
      );
    } catch (err: any) {
      console.error(
        `[dlmm-lifecycle] Failed to claim fees from ${positionPubkey.toBase58()}: ${err?.message}`
      );
    }
  }

  return transactions;
}

/**
 * Remove liquidity and close DLMM positions.
 *
 * @param connection - Solana RPC connection
 * @param wallet - Position owner
 * @param dlmmPoolAddress - DLMM pool address
 * @param positions - Position public keys to close
 * @returns Array of unsigned transactions for position removal
 */
export async function closePosition(
  connection: Connection,
  wallet: Keypair,
  dlmmPoolAddress: PublicKey,
  positions: PublicKey[]
): Promise<Transaction[]> {
  const sdk = await getDlmmSdk();
  const dlmmPool = await sdk.create(connection, dlmmPoolAddress);

  const transactions: Transaction[] = [];

  for (const positionPubkey of positions) {
    try {
      const removeTxs = await dlmmPool.removeLiquidity({
        position: positionPubkey,
        user: wallet.publicKey,
        binIds: [], // empty = remove all bins
        bps: new BN(10000), // 100% removal
      });
      const txArray = Array.isArray(removeTxs)
        ? removeTxs
        : [removeTxs];
      transactions.push(...txArray);
      console.log(
        `[dlmm-lifecycle] Closed position ${positionPubkey.toBase58()}`
      );
    } catch (err: any) {
      console.error(
        `[dlmm-lifecycle] Failed to close position ${positionPubkey.toBase58()}: ${err?.message}`
      );
    }
  }

  return transactions;
}
