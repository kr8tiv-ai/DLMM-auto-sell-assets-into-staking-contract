import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { DlmmExitAccount } from "./types";
import { CrankConfig } from "./config";
import { createLogger } from "./logger";
import { closePosition, claimFees } from "./dlmm-lifecycle";
import { unwrapWsol } from "./wsol";
import { submitWithJitoFallback } from "./jito-bundle";

const log = createLogger("emergency");

// ---- Result types ----

export interface TerminateStepResult {
  step: string;
  success: boolean;
  error?: string;
}

export interface TerminateExitResult {
  exitPda: string;
  success: boolean;
  steps: TerminateStepResult[];
}

export interface EmergencyHaltResult {
  exitResults: TerminateExitResult[];
  haltTxSubmitted: boolean;
  haltError?: string;
  totalExits: number;
  successfulExits: number;
  failedExits: number;
}

// ---- Dependency injection interface ----

/** Dependencies injected for testability. */
export interface EmergencyDeps {
  fetchActiveExits: () => Promise<
    Array<{ publicKey: PublicKey; account: DlmmExitAccount }>
  >;
  closePosition: typeof closePosition;
  claimFees: typeof claimFees;
  unwrapWsol: typeof unwrapWsol;
  submitWithJitoFallback: typeof submitWithJitoFallback;
  buildTerminateExitTx: (exitPda: PublicKey) => Transaction;
  buildEmergencyHaltTx: (exitPdas: PublicKey[]) => Transaction;
  buildDepositRewardsTx: (
    amountLamports: bigint,
    pool: PublicKey
  ) => Transaction;
  transferAssetToTreasury: (
    connection: Connection,
    wallet: Keypair,
    assetMint: PublicKey,
    treasuryAddress: string
  ) => Promise<string | null>;
}

// ---- Core functions ----

/**
 * Terminate a single DLMM exit: close positions, claim remaining fees,
 * unwrap WSOL, deposit SOL rewards, transfer unsold asset to treasury,
 * and submit the terminate_exit instruction.
 *
 * Each step is isolated — failures log and continue so partial cleanup
 * still happens.
 */
export async function terminateSingleExit(
  connection: Connection,
  wallet: Keypair,
  config: CrankConfig,
  exitPda: PublicKey,
  exit: DlmmExitAccount,
  deps: EmergencyDeps
): Promise<TerminateExitResult> {
  const exitKey = exitPda.toBase58().slice(0, 8);
  const steps: TerminateStepResult[] = [];

  log.info("Terminating exit", { exitPda: exitKey });

  // 1. Close position — remove liquidity from Meteora
  try {
    const closeTxs = await deps.closePosition(
      connection,
      wallet,
      exit.dlmmPool,
      [exit.position]
    );
    log.info("closePosition done", { exitPda: exitKey, txCount: closeTxs.length });
    steps.push({ step: "closePosition", success: true });
  } catch (err: any) {
    log.error("closePosition failed", { exitPda: exitKey, error: err?.message });
    steps.push({
      step: "closePosition",
      success: false,
      error: err?.message,
    });
  }

  // 2. Claim remaining fees
  try {
    const claimTxs = await deps.claimFees(
      connection,
      wallet,
      exit.dlmmPool,
      [exit.position]
    );
    log.info("claimFees done", { exitPda: exitKey, txCount: claimTxs.length });
    steps.push({ step: "claimFees", success: true });
  } catch (err: any) {
    log.error("claimFees failed", { exitPda: exitKey, error: err?.message });
    steps.push({
      step: "claimFees",
      success: false,
      error: err?.message,
    });
  }

  // 3. Unwrap WSOL → native SOL
  try {
    await deps.unwrapWsol(connection, wallet);
    log.info("unwrapWsol done", { exitPda: exitKey });
    steps.push({ step: "unwrapWsol", success: true });
  } catch (err: any) {
    log.error("unwrapWsol failed", { exitPda: exitKey, error: err?.message });
    steps.push({
      step: "unwrapWsol",
      success: false,
      error: err?.message,
    });
  }

  // 4. Deposit recovered SOL to reward pool
  try {
    const depositTx = deps.buildDepositRewardsTx(
      exit.totalSolClaimed,
      exit.pool
    );
    const results = await deps.submitWithJitoFallback(
      connection,
      config.jitoBlockEngineUrl,
      [depositTx],
      wallet,
      config.jitoTipLamports
    );
    const allLanded = results.every((r) => r.landed);
    if (!allLanded) {
      const errors = results
        .filter((r) => !r.landed)
        .map((r) => r.error)
        .join("; ");
      throw new Error(`deposit_rewards tx failed: ${errors}`);
    }
    log.info("deposit_rewards submitted", { exitPda: exitKey });
    steps.push({ step: "depositRewards", success: true });
  } catch (err: any) {
    log.error("depositRewards failed", { exitPda: exitKey, error: err?.message });
    steps.push({
      step: "depositRewards",
      success: false,
      error: err?.message,
    });
  }

  // 5. Transfer unsold asset tokens to treasury
  try {
    await deps.transferAssetToTreasury(connection, wallet, exit.assetMint, config.treasuryAddress);
    log.info("Asset transferred to treasury", { exitPda: exitKey });
    steps.push({ step: "transferAssetToTreasury", success: true });
  } catch (err: any) {
    log.error("transferAssetToTreasury failed", { exitPda: exitKey, error: err?.message });
    steps.push({
      step: "transferAssetToTreasury",
      success: false,
      error: err?.message,
    });
  }

  // 6. Submit terminate_exit on-chain instruction
  try {
    const terminateTx = deps.buildTerminateExitTx(exitPda);
    const results = await deps.submitWithJitoFallback(
      connection,
      config.jitoBlockEngineUrl,
      [terminateTx],
      wallet,
      config.jitoTipLamports
    );
    const allLanded = results.every((r) => r.landed);
    if (!allLanded) {
      const errors = results
        .filter((r) => !r.landed)
        .map((r) => r.error)
        .join("; ");
      throw new Error(`terminate_exit tx failed: ${errors}`);
    }
    log.info("terminate_exit submitted", { exitPda: exitKey });
    steps.push({ step: "terminateExit", success: true });
  } catch (err: any) {
    log.error("terminateExit failed", { exitPda: exitKey, error: err?.message });
    steps.push({
      step: "terminateExit",
      success: false,
      error: err?.message,
    });
  }

  const success = steps.every((s) => s.success);
  log.info("Exit termination result", {
    exitPda: exitKey,
    success,
    stepsOk: steps.filter((s) => s.success).length,
    stepsTotal: steps.length,
  });

  return {
    exitPda: exitPda.toBase58(),
    success,
    steps,
  };
}

/**
 * Emergency halt: terminate ALL active exits, then submit the on-chain
 * emergency_halt instruction that pauses the pool and marks all exits
 * as Terminated.
 *
 * Per-exit failures are isolated — the halt continues with remaining exits.
 */
export async function emergencyHaltAll(
  connection: Connection,
  wallet: Keypair,
  config: CrankConfig,
  deps: EmergencyDeps
): Promise<EmergencyHaltResult> {
  log.info("Starting emergency halt — fetching active exits");

  const exits = await deps.fetchActiveExits();

  if (exits.length === 0) {
    log.info("No active exits found — submitting halt tx only");
    // Still submit the halt tx to pause the pool
    let haltTxSubmitted = false;
    let haltError: string | undefined;
    try {
      const haltTx = deps.buildEmergencyHaltTx([]);
      const results = await deps.submitWithJitoFallback(
        connection,
        config.jitoBlockEngineUrl,
        [haltTx],
        wallet,
        config.jitoTipLamports
      );
      haltTxSubmitted = results.every((r) => r.landed);
      if (!haltTxSubmitted) {
        haltError = results
          .filter((r) => !r.landed)
          .map((r) => r.error)
          .join("; ");
      }
    } catch (err: any) {
      haltError = err?.message;
    }

    return {
      exitResults: [],
      haltTxSubmitted,
      haltError,
      totalExits: 0,
      successfulExits: 0,
      failedExits: 0,
    };
  }

  log.info("Found active exits — terminating each", { count: exits.length });

  // Terminate each exit individually
  const exitResults: TerminateExitResult[] = [];
  for (const { publicKey, account } of exits) {
    try {
      const result = await terminateSingleExit(
        connection,
        wallet,
        config,
        publicKey,
        account,
        deps
      );
      exitResults.push(result);
    } catch (err: any) {
      log.error("Unexpected error terminating exit", {
        exitPda: publicKey.toBase58().slice(0, 8),
        error: err?.message,
      });
      exitResults.push({
        exitPda: publicKey.toBase58(),
        success: false,
        steps: [],
      });
    }
  }

  // Submit on-chain emergency_halt with all exit PDAs
  const exitPdas = exits.map((e) => e.publicKey);
  let haltTxSubmitted = false;
  let haltError: string | undefined;

  try {
    const haltTx = deps.buildEmergencyHaltTx(exitPdas);
    const results = await deps.submitWithJitoFallback(
      connection,
      config.jitoBlockEngineUrl,
      [haltTx],
      wallet,
      config.jitoTipLamports
    );
    haltTxSubmitted = results.every((r) => r.landed);
    if (!haltTxSubmitted) {
      haltError = results
        .filter((r) => !r.landed)
        .map((r) => r.error)
        .join("; ");
    }
    log.info("emergency_halt tx result", { landed: haltTxSubmitted });
  } catch (err: any) {
    log.error("emergency_halt tx submission error", { error: err?.message });
    haltError = err?.message;
  }

  const successfulExits = exitResults.filter((r) => r.success).length;
  const failedExits = exitResults.filter((r) => !r.success).length;

  log.info("Halt complete", {
    successfulExits,
    totalExits: exits.length,
    haltTxSubmitted,
  });

  return {
    exitResults,
    haltTxSubmitted,
    haltError,
    totalExits: exits.length,
    successfulExits,
    failedExits,
  };
}
