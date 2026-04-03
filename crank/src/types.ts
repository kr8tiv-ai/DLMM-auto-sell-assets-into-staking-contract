import { PublicKey } from "@solana/web3.js";

// ---- On-chain DlmmExit account fields (mirrors dlmm_exit.rs) ----

export enum ExitStatus {
  Active = 0,
  Completed = 1,
  Terminated = 2,
}

export interface DlmmExitAccount {
  /** Parent staking pool */
  pool: PublicKey;
  /** Pool owner who initiated the exit */
  owner: PublicKey;
  /** Mint address of the asset being exited */
  assetMint: PublicKey;
  /** DLMM pool where liquidity is being removed */
  dlmmPool: PublicKey;
  /** DLMM position being unwound */
  position: PublicKey;
  /** Cumulative SOL claimed from filled bins (lamports) */
  totalSolClaimed: bigint;
  /** Exit status */
  status: ExitStatus;
  /** Unix timestamp when exit was initiated */
  createdAt: number;
  /** Unix timestamp when exit was completed or terminated (0 while active) */
  completedAt: number;
  /** Governance proposal that triggered this exit (0 = manual owner-initiated) */
  proposalId: bigint;
  /** PDA bump */
  bump: number;
}

// ---- Dust detection ----

export interface DustCheckResult {
  /** Whether remaining amount is dust (below $1) */
  isDust: boolean | null; // null = unable to determine
  /** Estimated USD value of remaining amount, null if unavailable */
  estimatedValueUsd: number | null;
  /** Price source that was used */
  source: "jupiter" | "pyth" | "none";
  /** Warning message if price confidence is low or unavailable */
  warning?: string;
}

// ---- Claim result ----

export interface ClaimResult {
  /** Transactions returned by the SDK for fee claiming */
  transactions: unknown[];
  /** Total fees claimed (lamports) */
  feesClaimedLamports: bigint;
}

// ---- Bundle result ----

export interface BundleResult {
  /** Jito bundle ID */
  bundleId: string;
  /** Whether the bundle landed successfully */
  landed: boolean;
  /** Error message if bundle failed */
  error?: string;
}

// ---- DLMM lifecycle ----

export interface PositionFeeData {
  /** Position public key */
  positionPubkey: PublicKey;
  /** Accumulated X fees (token amount) */
  feeX: bigint;
  /** Accumulated Y fees (SOL lamports) */
  feeY: bigint;
}
