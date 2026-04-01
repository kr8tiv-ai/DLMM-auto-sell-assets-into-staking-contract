import { Keypair } from "@solana/web3.js";
import * as fs from "fs";

export interface CrankConfig {
  solanaRpcUrl: string;
  crankKeypairPath: string;
  programId: string;
  pollIntervalMs: number;
  claimThresholdLamports: number;
  jitoBlockEngineUrl: string;
  jitoTipLamports: number;
  /** Path to the Anchor IDL JSON */
  idlPath: string;
  /** Staking pool PDA base58 address */
  stakingPool: string;
  /** Path to heartbeat file written each cycle */
  heartbeatPath: string;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export function loadConfig(): CrankConfig {
  return {
    solanaRpcUrl: requireEnv("SOLANA_RPC_URL"),
    crankKeypairPath: requireEnv("CRANK_KEYPAIR_PATH"),
    programId: requireEnv("PROGRAM_ID"),
    pollIntervalMs: parseInt(optionalEnv("POLL_INTERVAL_MS", "5000"), 10),
    claimThresholdLamports: parseInt(
      optionalEnv("CLAIM_THRESHOLD_LAMPORTS", "1000000"),
      10
    ),
    jitoBlockEngineUrl: optionalEnv(
      "JITO_BLOCK_ENGINE_URL",
      "https://mainnet.block-engine.jito.wtf"
    ),
    jitoTipLamports: parseInt(
      optionalEnv("JITO_TIP_LAMPORTS", "10000"),
      10
    ),
    idlPath: optionalEnv("IDL_PATH", "../target/idl/brain_staking.json"),
    stakingPool: requireEnv("STAKING_POOL"),
    heartbeatPath: optionalEnv("HEARTBEAT_PATH", "./heartbeat.txt"),
  };
}

export function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf-8");
  const secretKey = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secretKey);
}
