import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BundleResult } from "./types";

/**
 * Known Jito tip accounts (mainnet).
 * One is chosen at random per bundle to distribute tips.
 */
const JITO_TIP_ACCOUNTS: PublicKey[] = [
  new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
  new PublicKey("HFqU5x63VTqvQss8hp11i4bPUHQFnT6soXGfRZrXYCLB"),
  new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"),
  new PublicKey("ADaUMid9yfUytqMBgopwjb2DTLSLCGwkRKKFVoQk9X68"),
  new PublicKey("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"),
  new PublicKey("ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt"),
  new PublicKey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL6d8u"),
  new PublicKey("3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"),
];

/** Maximum number of operational transactions per Jito bundle (leaving room for tip tx). */
const MAX_OPS_PER_BUNDLE = 4;

/**
 * Pick a random Jito tip account from the known list.
 */
export function pickTipAccount(): PublicKey {
  const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return JITO_TIP_ACCOUNTS[idx];
}

/**
 * Create a tip instruction for Jito validators.
 */
export function createTipInstruction(
  payer: PublicKey,
  tipLamports: number,
  tipAccount?: PublicKey
): TransactionInstruction {
  const destination = tipAccount ?? pickTipAccount();
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: destination,
    lamports: tipLamports,
  });
}

/**
 * Build one or more bundles from operational transactions + tip.
 *
 * Each bundle contains up to MAX_OPS_PER_BUNDLE operational transactions
 * plus one tip transaction appended at the end. If more than MAX_OPS_PER_BUNDLE
 * operational txs are provided, they are split across multiple bundles
 * (each with its own tip tx).
 *
 * @param operationalTxs - The claim/deposit/record/complete transactions
 * @param payer - Keypair that pays for tips
 * @param tipLamports - Tip amount per bundle
 * @param recentBlockhash - Recent blockhash for versioned txs
 * @returns Array of bundles, where each bundle is an array of serialized tx base64 strings
 */
export function buildBundles(
  operationalTxs: Transaction[],
  payer: Keypair,
  tipLamports: number,
  recentBlockhash: string
): string[][] {
  const bundles: string[][] = [];

  // Split ops into chunks of MAX_OPS_PER_BUNDLE
  for (let i = 0; i < operationalTxs.length; i += MAX_OPS_PER_BUNDLE) {
    const chunk = operationalTxs.slice(i, i + MAX_OPS_PER_BUNDLE);

    const serializedTxs: string[] = [];

    // Serialize each operational tx
    for (const tx of chunk) {
      tx.recentBlockhash = recentBlockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer);
      serializedTxs.push(
        Buffer.from(tx.serialize()).toString("base64")
      );
    }

    // Create and append tip tx
    const tipIx = createTipInstruction(payer.publicKey, tipLamports);
    const tipTx = new Transaction().add(tipIx);
    tipTx.recentBlockhash = recentBlockhash;
    tipTx.feePayer = payer.publicKey;
    tipTx.sign(payer);
    serializedTxs.push(
      Buffer.from(tipTx.serialize()).toString("base64")
    );

    bundles.push(serializedTxs);
  }

  // Edge case: no operational txs — return empty
  if (bundles.length === 0) {
    return [];
  }

  return bundles;
}

/**
 * Submit a bundle to the Jito block engine via JSON-RPC.
 *
 * @param jitoUrl - Jito block engine URL
 * @param bundle - Array of base64-encoded serialized transactions
 * @returns Bundle ID on success
 */
export async function submitBundle(
  jitoUrl: string,
  bundle: string[]
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${jitoUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [bundle],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Jito block engine returned HTTP ${response.status}`
      );
    }

    const body = await response.json();

    if (body.error) {
      throw new Error(
        `Jito RPC error: ${JSON.stringify(body.error)}`
      );
    }

    const bundleId = body.result;
    if (typeof bundleId !== "string" || bundleId.length === 0) {
      throw new Error(
        `Invalid bundle ID from Jito: ${JSON.stringify(bundleId)}`
      );
    }

    console.log(`[jito-bundle] Submitted bundle: ${bundleId}`);
    return bundleId;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check the status of a previously submitted bundle.
 *
 * @param jitoUrl - Jito block engine URL
 * @param bundleId - Bundle ID from submitBundle
 * @returns BundleResult with status
 */
export async function checkBundleStatus(
  jitoUrl: string,
  bundleId: string
): Promise<BundleResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${jitoUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        bundleId,
        landed: false,
        error: `Jito returned HTTP ${response.status}`,
      };
    }

    const body = await response.json();

    if (body.error) {
      return {
        bundleId,
        landed: false,
        error: `Jito RPC error: ${JSON.stringify(body.error)}`,
      };
    }

    const statuses = body.result?.value;
    if (!Array.isArray(statuses) || statuses.length === 0) {
      return {
        bundleId,
        landed: false,
        error: "No status returned for bundle",
      };
    }

    const status = statuses[0];
    const landed =
      status.confirmation_status === "confirmed" ||
      status.confirmation_status === "finalized";

    return {
      bundleId,
      landed,
      error: landed
        ? undefined
        : `Bundle status: ${status.confirmation_status ?? "unknown"}`,
    };
  } catch (err: any) {
    return {
      bundleId,
      landed: false,
      error: err?.name === "AbortError" ? "Timeout (15s)" : err?.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Submit operational transactions as Jito bundles, with fallback
 * to regular transaction submission if Jito fails.
 *
 * @param connection - Solana RPC connection
 * @param jitoUrl - Jito block engine URL
 * @param operationalTxs - Transactions to bundle
 * @param payer - Keypair that signs and pays tips
 * @param tipLamports - Tip amount per bundle
 * @returns Array of BundleResults
 */
export async function submitWithJitoFallback(
  connection: Connection,
  jitoUrl: string,
  operationalTxs: Transaction[],
  payer: Keypair,
  tipLamports: number
): Promise<BundleResult[]> {
  if (operationalTxs.length === 0) {
    return [];
  }

  const { blockhash } = await connection.getLatestBlockhash();
  const bundles = buildBundles(operationalTxs, payer, tipLamports, blockhash);
  const results: BundleResult[] = [];

  for (const bundle of bundles) {
    try {
      const bundleId = await submitBundle(jitoUrl, bundle);
      results.push({ bundleId, landed: true });
    } catch (err: any) {
      console.warn(
        `[jito-bundle] Jito submission failed: ${err?.message}. Falling back to regular tx.`
      );
      // Fallback: send operational txs individually (skip the tip tx which is last)
      for (let i = 0; i < bundle.length - 1; i++) {
        try {
          const txBuf = Buffer.from(bundle[i], "base64");
          const sig = await connection.sendRawTransaction(txBuf);
          console.log(`[jito-bundle] Fallback tx sent: ${sig}`);
          results.push({
            bundleId: `fallback-${sig}`,
            landed: true,
          });
        } catch (sendErr: any) {
          console.error(
            `[jito-bundle] Fallback tx failed: ${sendErr?.message}`
          );
          results.push({
            bundleId: "fallback-failed",
            landed: false,
            error: sendErr?.message,
          });
        }
      }
    }
  }

  return results;
}
