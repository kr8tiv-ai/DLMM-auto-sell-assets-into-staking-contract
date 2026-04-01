import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import { DlmmExitAccount, ExitStatus } from "./types";
import { CrankConfig } from "./config";
import { createLogger } from "./logger";
import { monitorPosition, claimFees, closePosition } from "./dlmm-lifecycle";
import { checkDust } from "./dust-detection";
import { unwrapWsol } from "./wsol";
import { submitWithJitoFallback } from "./jito-bundle";

const log = createLogger("monitor");

/** Dependencies injected for testability. */
export interface MonitorDeps {
  fetchActiveExits: () => Promise<
    Array<{ publicKey: PublicKey; account: DlmmExitAccount }>
  >;
  monitorPosition: typeof monitorPosition;
  claimFees: typeof claimFees;
  closePosition: typeof closePosition;
  checkDust: typeof checkDust;
  unwrapWsol: typeof unwrapWsol;
  submitWithJitoFallback: typeof submitWithJitoFallback;
  buildDepositRewardsTx: (
    amountLamports: bigint,
    pool: PublicKey
  ) => Transaction;
  buildRecordClaimTx: (
    exitPda: PublicKey,
    amountLamports: bigint
  ) => Transaction;
  buildCompleteExitTx: (exitPda: PublicKey) => Transaction;
  sleep: (ms: number) => Promise<void>;
}

/** Flag to signal shutdown from SIGINT/SIGTERM. */
let shutdownRequested = false;

export function requestShutdown(): void {
  shutdownRequested = true;
}

export function resetShutdown(): void {
  shutdownRequested = false;
}

export function isShutdownRequested(): boolean {
  return shutdownRequested;
}

/**
 * Write heartbeat timestamp to file. Non-fatal — logs warning on failure.
 */
function writeHeartbeat(path: string): void {
  try {
    fs.writeFileSync(path, new Date().toISOString(), "utf-8");
  } catch (err: any) {
    log.warn("Failed to write heartbeat", { error: err?.message, path });
  }
}

/**
 * Process a single active DlmmExit — check fees, claim if above threshold,
 * check dust, complete if dust reached.
 */
export async function processExit(
  exitPda: PublicKey,
  exit: DlmmExitAccount,
  connection: Connection,
  wallet: Keypair,
  config: CrankConfig,
  deps: MonitorDeps
): Promise<void> {
  const exitKey = exitPda.toBase58().slice(0, 8);

  // Skip non-active exits
  if (exit.status !== ExitStatus.Active) {
    log.info("Skipping exit", { exitPda: exitKey, status: exit.status });
    return;
  }

  // 1. Check position fees
  const feeData = await deps.monitorPosition(
    connection,
    wallet,
    exit.dlmmPool
  );

  if (feeData.length === 0) {
    log.info("No positions found, skipping", { exitPda: exitKey });
    return;
  }

  // Sum SOL fees across all positions
  const totalFeeY = feeData.reduce(
    (sum, fd) => sum + fd.feeY,
    BigInt(0)
  );

  // 2. If fees above claim threshold, claim and deposit
  if (totalFeeY >= BigInt(config.claimThresholdLamports)) {
    log.info("Fees above threshold, claiming", {
      exitPda: exitKey,
      amount: totalFeeY.toString(),
      threshold: config.claimThresholdLamports,
    });

    const positionKeys = feeData.map((fd) => fd.positionPubkey);
    const claimTxs = await deps.claimFees(
      connection,
      wallet,
      exit.dlmmPool,
      positionKeys
    );

    // Unwrap WSOL to native SOL
    await deps.unwrapWsol(connection, wallet);

    // Build on-chain recording txs
    const depositTx = deps.buildDepositRewardsTx(totalFeeY, exit.pool);
    const recordTx = deps.buildRecordClaimTx(exitPda, totalFeeY);

    const allTxs = [...claimTxs, depositTx, recordTx];

    const results = await deps.submitWithJitoFallback(
      connection,
      config.jitoBlockEngineUrl,
      allTxs,
      wallet,
      config.jitoTipLamports
    );

    for (const r of results) {
      if (!r.landed) {
        log.error("Bundle/tx failed", { exitPda: exitKey, error: r.error });
      }
    }
  }

  // 3. Check dust threshold — should we complete the exit?
  const dustResult = await deps.checkDust(
    exit.assetMint.toBase58(),
    BigInt(0), // Remaining amount is checked on-chain position; we pass 0 and let the SDK read it
    9 // SOL decimals
  );

  if (dustResult.isDust === true) {
    log.info("Dust reached, completing exit", {
      exitPda: exitKey,
      estimatedValueUsd: dustResult.estimatedValueUsd,
    });

    // Close all positions
    const positionKeys = feeData.map((fd) => fd.positionPubkey);
    const closeTxs = await deps.closePosition(
      connection,
      wallet,
      exit.dlmmPool,
      positionKeys
    );

    // Unwrap any remaining WSOL
    await deps.unwrapWsol(connection, wallet);

    // Build complete_exit instruction
    const completeTx = deps.buildCompleteExitTx(exitPda);
    const allTxs = [...closeTxs, completeTx];

    const results = await deps.submitWithJitoFallback(
      connection,
      config.jitoBlockEngineUrl,
      allTxs,
      wallet,
      config.jitoTipLamports
    );

    for (const r of results) {
      if (!r.landed) {
        log.error("Complete bundle failed", { exitPda: exitKey, error: r.error });
      } else {
        log.info("Exit completed successfully", { exitPda: exitKey });
      }
    }
  }
}

/**
 * Main monitoring loop. Polls for active DlmmExit accounts and
 * orchestrates the claim/deposit/complete lifecycle.
 */
export async function startMonitor(
  connection: Connection,
  wallet: Keypair,
  config: CrankConfig,
  deps: MonitorDeps
): Promise<void> {
  log.info("Starting monitoring loop", { pollIntervalMs: config.pollIntervalMs });

  resetShutdown();

  while (!isShutdownRequested()) {
    try {
      const exits = await deps.fetchActiveExits();
      const activeExits = exits.filter(
        (e) => e.account.status === ExitStatus.Active
      );

      if (activeExits.length === 0) {
        log.info("No active exits, sleeping");
      } else {
        log.info("Found active exits", { count: activeExits.length });
      }

      for (const { publicKey, account } of activeExits) {
        if (isShutdownRequested()) break;

        try {
          await processExit(
            publicKey,
            account,
            connection,
            wallet,
            config,
            deps
          );
        } catch (err: any) {
          log.error("Error processing exit", {
            exitPda: publicKey.toBase58().slice(0, 8),
            error: err?.message,
          });
          // Continue to next exit — never crash the loop
        }
      }
    } catch (err: any) {
      log.error("Error fetching exits", { error: err?.message });
      // Continue polling — transient RPC errors shouldn't kill the crank
    }

    // Write heartbeat after successful cycle
    writeHeartbeat(config.heartbeatPath);

    if (!isShutdownRequested()) {
      await deps.sleep(config.pollIntervalMs);
    }
  }

  log.info("Shutdown complete");
}
