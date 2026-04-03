import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, transfer, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createLogger } from "./logger";

const log = createLogger("treasury-transfer");

/**
 * Transfer remaining asset tokens from the crank's ATA to the treasury.
 * 
 * @param connection - Solana connection
 * @param wallet - Crank wallet keypair
 * @param assetMint - The SPL token mint to transfer
 * @param treasuryAddress - Recipient treasury address (base58)
 * @returns Transaction signature or null if no balance
 */
export async function transferAssetToTreasury(
  connection: Connection,
  wallet: Keypair,
  assetMint: PublicKey,
  treasuryAddress: string
): Promise<string | null> {
  try {
    const treasury = new PublicKey(treasuryAddress);
    
    // Get or create the crank's ATA for this asset
    const crankAta = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      assetMint,
      wallet.publicKey
    );

    // Check if there's a balance
    if (crankAta.amount === 0n) {
      log.info("No asset balance to transfer", { 
        mint: assetMint.toBase58() 
      });
      return null;
    }

    // Transfer all tokens to treasury
    const txSig = await transfer(
      connection,
      wallet,
      crankAta.address,
      treasury,
      wallet.publicKey,
      crankAta.amount
    );

    log.info("Asset transferred to treasury", {
      mint: assetMint.toBase58(),
      amount: crankAta.amount.toString(),
      treasury: treasuryAddress,
      tx: txSig
    });

    return txSig;
  } catch (err: any) {
    // If the token account doesn't exist or has no balance, that's OK
    if (err.message?.includes("cannot find")) {
      log.info("No token account found, skipping transfer", {
        mint: assetMint.toBase58()
      });
      return null;
    }
    throw err;
  }
}
