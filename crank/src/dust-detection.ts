import { DustCheckResult } from "./types";

const JUPITER_PRICE_URL = "https://api.jup.ag/price/v2";
const PYTH_HERMES_URL = "https://hermes.pyth.network/v2/updates/price/latest";

// SOL price feed on Pyth (mainnet)
const SOL_USD_PYTH_FEED =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** Timeout-aware fetch wrapper */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try Jupiter V3 price API for the given mint.
 * Returns price in USD per smallest unit, or null on failure.
 */
async function getJupiterPrice(
  assetMint: string
): Promise<number | null> {
  try {
    const url = `${JUPITER_PRICE_URL}?ids=${assetMint}`;
    const res = await fetchWithTimeout(url, 10_000);
    if (!res.ok) {
      console.warn(
        `[dust-detection] Jupiter returned HTTP ${res.status}`
      );
      return null;
    }
    const body = await res.json();
    const data = body?.data?.[assetMint];
    if (!data || typeof data.price !== "string") {
      console.warn(
        "[dust-detection] Jupiter response missing price field",
        JSON.stringify(body).slice(0, 200)
      );
      return null;
    }
    return parseFloat(data.price);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn("[dust-detection] Jupiter request timed out (10s)");
    } else {
      console.warn("[dust-detection] Jupiter error:", err?.message);
    }
    return null;
  }
}

/**
 * Try Pyth Hermes for a price feed.
 * Returns { price, confidence } or null on failure.
 */
async function getPythPrice(
  priceFeedId: string
): Promise<{ price: number; confidenceRatio: number } | null> {
  try {
    const url = `${PYTH_HERMES_URL}?ids[]=${priceFeedId}`;
    const res = await fetchWithTimeout(url, 10_000);
    if (!res.ok) {
      console.warn(`[dust-detection] Pyth returned HTTP ${res.status}`);
      return null;
    }
    const body = await res.json();
    const parsed = body?.parsed;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.warn(
        "[dust-detection] Pyth response missing parsed array"
      );
      return null;
    }
    const priceData = parsed[0]?.price;
    if (!priceData || !priceData.price || !priceData.conf) {
      console.warn(
        "[dust-detection] Pyth price data malformed"
      );
      return null;
    }
    const expo = priceData.expo ?? 0;
    const price = parseFloat(priceData.price) * Math.pow(10, expo);
    const conf = parseFloat(priceData.conf) * Math.pow(10, expo);
    const confidenceRatio = price > 0 ? conf / price : 1;
    return { price, confidenceRatio };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn("[dust-detection] Pyth request timed out (10s)");
    } else {
      console.warn("[dust-detection] Pyth error:", err?.message);
    }
    return null;
  }
}

/**
 * Check whether a remaining token amount qualifies as dust (< $1 USD).
 *
 * Strategy:
 * 1. Try Jupiter V3 for price.
 * 2. If Jupiter fails, fall through to Pyth Hermes.
 * 3. If both fail, return isDust=null (unknown).
 *
 * @param assetMint - SPL token mint address
 * @param remainingAmount - remaining amount in smallest units
 * @param decimals - token decimals for converting to human-readable units
 * @param priceFeedId - optional Pyth price feed ID override
 */
export async function checkDust(
  assetMint: string,
  remainingAmount: bigint,
  decimals: number = 9,
  priceFeedId: string = SOL_USD_PYTH_FEED
): Promise<DustCheckResult> {
  const humanAmount =
    Number(remainingAmount) / Math.pow(10, decimals);

  // 1. Try Jupiter
  const jupiterPrice = await getJupiterPrice(assetMint);
  if (jupiterPrice !== null) {
    const value = humanAmount * jupiterPrice;
    return {
      isDust: value < 1.0,
      estimatedValueUsd: value,
      source: "jupiter",
    };
  }

  // 2. Fall through to Pyth
  const pythResult = await getPythPrice(priceFeedId);
  if (pythResult !== null) {
    if (pythResult.confidenceRatio > 0.5) {
      console.warn(
        `[dust-detection] Pyth confidence ratio ${pythResult.confidenceRatio.toFixed(
          3
        )} > 0.5, skipping auto-close`
      );
      return {
        isDust: null,
        estimatedValueUsd: null,
        source: "pyth",
        warning: `Pyth confidence ratio too high (${pythResult.confidenceRatio.toFixed(
          3
        )}), skipping auto-close decision`,
      };
    }
    const value = humanAmount * pythResult.price;
    return {
      isDust: value < 1.0,
      estimatedValueUsd: value,
      source: "pyth",
    };
  }

  // 3. Both unavailable
  console.warn(
    "[dust-detection] Both Jupiter and Pyth unavailable, cannot determine dust status"
  );
  return {
    isDust: null,
    estimatedValueUsd: null,
    source: "none",
    warning:
      "Both Jupiter and Pyth price sources unavailable, skipping auto-close",
  };
}
