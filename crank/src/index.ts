import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl, BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import { loadConfig, loadKeypair } from "./config";
import { createLogger } from "./logger";
import { withRetry } from "./retry";
import {
  startMonitor,
  requestShutdown,
  MonitorDeps,
} from "./monitor";
import { monitorPosition, claimFees, closePosition } from "./dlmm-lifecycle";
import { checkDust } from "./dust-detection";
import { unwrapWsol } from "./wsol";
import { submitWithJitoFallback } from "./jito-bundle";
import { ExitStatus, DlmmExitAccount } from "./types";

const log = createLogger("crank");

// PDA seeds — must match constants.rs
const STAKING_POOL_SEED = Buffer.from("staking_pool");
const REWARD_VAULT_SEED = Buffer.from("reward_vault");
const DLMM_EXIT_SEED = Buffer.from("dlmm_exit");

/**
 * Derive the staking pool PDA.
 */
function findStakingPool(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([STAKING_POOL_SEED], programId);
}

/**
 * Derive the reward vault PDA.
 */
function findRewardVault(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([REWARD_VAULT_SEED], programId);
}

/**
 * Load and validate the Anchor IDL from disk.
 */
function loadIdl(idlPath: string): Idl {
  log.info("Loading IDL", { path: idlPath });
  const raw = fs.readFileSync(idlPath, "utf-8");
  return JSON.parse(raw) as Idl;
}

/**
 * Create an Anchor Program instance for the brain-staking program.
 */
function createProgram(
  idl: Idl,
  programId: PublicKey,
  connection: Connection,
  wallet: Keypair
): Program {
  const provider = new AnchorProvider(
    connection,
    new Wallet(wallet),
    { commitment: "confirmed" }
  );
  // Anchor v0.30 constructor: Program(idl, provider?). The IDL must contain
  // the program address field. We inject it here if missing so the crank
  // can work with any IDL file.
  const idlWithAddr = { ...idl, address: programId.toBase58() } as Idl;
  return new Program(idlWithAddr, provider);
}

/**
 * CLI entry point for the DLMM exit crank.
 *
 * Loads configuration from environment, initializes Solana connection
 * and wallet, and starts the monitoring loop.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const wallet = loadKeypair(config.crankKeypairPath);
  const connection = new Connection(config.solanaRpcUrl, "confirmed");

  log.info("Brain Staking DLMM Exit Crank starting", {
    rpcUrl: config.solanaRpcUrl,
    programId: config.programId,
    crankWallet: wallet.publicKey.toBase58(),
    pollIntervalMs: config.pollIntervalMs,
    claimThreshold: config.claimThresholdLamports,
    jitoEngine: config.jitoBlockEngineUrl,
    jitoTip: config.jitoTipLamports,
  });

  // Load IDL and create Anchor program
  const programId = new PublicKey(config.programId);
  const idl = loadIdl(config.idlPath);
  const program = createProgram(idl, programId, connection, wallet);

  // Derive PDAs
  const [stakingPoolPda] = findStakingPool(programId);
  const [rewardVaultPda] = findRewardVault(programId);
  const stakingPoolKey = new PublicKey(config.stakingPool);

  // Register graceful shutdown handlers
  const shutdown = () => {
    log.info("Shutdown signal received, finishing current cycle");
    requestShutdown();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Build dependency container with real Anchor instruction builders
  const deps: MonitorDeps = {
    fetchActiveExits: () =>
      withRetry(
        async () => {
          log.info("Fetching active DlmmExit accounts");
          const accounts = await connection.getProgramAccounts(programId, {
            filters: [
              { dataSize: 185 }, // DlmmExit account size (8 discriminator + fields)
            ],
          });

          return accounts.map(({ pubkey, account }) => ({
            publicKey: pubkey,
            account: deserializeDlmmExit(account.data),
          }));
        },
        { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10000 }
      ),

    monitorPosition,
    claimFees,
    closePosition,
    checkDust,
    unwrapWsol,
    submitWithJitoFallback,

    buildDepositRewardsTx: (
      amountLamports: bigint,
      pool: PublicKey
    ): Transaction => {
      log.info("Building deposit_rewards tx", {
        amount: amountLamports.toString(),
      });
      return program.methods
        .depositRewards(new BN(amountLamports.toString()))
        .accountsStrict({
          authority: wallet.publicKey,
          stakingPool: stakingPoolKey,
          rewardVault: rewardVaultPda,
          treasury: PublicKey.default, // filled by Anchor from IDL
          systemProgram: PublicKey.default,
        })
        .transaction() as unknown as Transaction;
    },

    buildRecordClaimTx: (
      exitPda: PublicKey,
      amountLamports: bigint
    ): Transaction => {
      log.info("Building record_claim tx", {
        amount: amountLamports.toString(),
        exitPda: exitPda.toBase58().slice(0, 8),
      });
      return program.methods
        .recordClaim(new BN(amountLamports.toString()))
        .accountsStrict({
          authority: wallet.publicKey,
          stakingPool: stakingPoolKey,
          dlmmExit: exitPda,
        })
        .transaction() as unknown as Transaction;
    },

    buildCompleteExitTx: (exitPda: PublicKey): Transaction => {
      log.info("Building complete_exit tx", {
        exitPda: exitPda.toBase58().slice(0, 8),
      });
      return program.methods
        .completeExit()
        .accountsStrict({
          authority: wallet.publicKey,
          stakingPool: stakingPoolKey,
          dlmmExit: exitPda,
        })
        .transaction() as unknown as Transaction;
    },

    sleep: (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  };

  await startMonitor(connection, wallet, config, deps);
}

/**
 * Deserialize a DlmmExit account from raw buffer.
 * Layout: 8 byte discriminator, then fields.
 */
function deserializeDlmmExit(data: Buffer): DlmmExitAccount {
  let offset = 8; // skip Anchor discriminator

  const pool = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const owner = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const assetMint = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const dlmmPool = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const position = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const totalSolClaimed = data.readBigUInt64LE(offset);
  offset += 8;

  const status = data.readUInt8(offset) as 0 | 1 | 2;
  offset += 1;

  const createdAt = Number(data.readBigInt64LE(offset));
  offset += 8;

  const completedAt = Number(data.readBigInt64LE(offset));
  offset += 8;

  const bump = data.readUInt8(offset);

  return {
    pool,
    owner,
    assetMint,
    dlmmPool,
    position,
    totalSolClaimed,
    status: status as ExitStatus,
    createdAt,
    completedAt,
    bump,
  };
}

main().catch((err) => {
  log.error("Fatal error", { error: err?.message, stack: err?.stack });
  process.exit(1);
});
