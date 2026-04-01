import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import * as splToken from "@solana/spl-token";

/** Dependency container for testing */
export interface WsolDeps {
  getAssociatedTokenAddress: typeof splToken.getAssociatedTokenAddress;
  getAccount: typeof splToken.getAccount;
  createCloseAccountInstruction: typeof splToken.createCloseAccountInstruction;
  NATIVE_MINT: PublicKey;
}

const defaultDeps: WsolDeps = {
  getAssociatedTokenAddress: splToken.getAssociatedTokenAddress,
  getAccount: splToken.getAccount,
  createCloseAccountInstruction: splToken.createCloseAccountInstruction,
  NATIVE_MINT: splToken.NATIVE_MINT,
};

/**
 * Unwrap WSOL by closing the associated WSOL token account.
 * Returns the transaction signature, or null if no WSOL to unwrap.
 *
 * @param connection - Solana RPC connection
 * @param wallet - Keypair that owns the WSOL ATA
 * @param deps - injectable dependencies (for testing)
 */
export async function unwrapWsol(
  connection: Connection,
  wallet: Keypair,
  deps: WsolDeps = defaultDeps
): Promise<string | null> {
  const wsolAta = await deps.getAssociatedTokenAddress(
    deps.NATIVE_MINT,
    wallet.publicKey
  );

  // Check if ATA exists and has balance
  try {
    const account = await deps.getAccount(connection, wsolAta);
    if (account.amount === BigInt(0)) {
      console.log("[wsol] WSOL ATA has zero balance, no-op");
      return null;
    }
  } catch (err: any) {
    if (
      err instanceof splToken.TokenAccountNotFoundError ||
      err?.name === "TokenAccountNotFoundError"
    ) {
      console.log("[wsol] No WSOL ATA found, no-op");
      return null;
    }
    throw err;
  }

  // Close the WSOL ATA to unwrap to native SOL
  const closeIx = deps.createCloseAccountInstruction(
    wsolAta,
    wallet.publicKey, // destination for lamports
    wallet.publicKey // authority
  );

  const tx = new Transaction().add(closeIx);
  const sig = await connection.sendTransaction(tx, [wallet]);
  console.log(`[wsol] Unwrapped WSOL, tx: ${sig}`);
  return sig;
}
