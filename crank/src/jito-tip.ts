import { createLogger } from "./logger";
import { jitoBundleSubmitted, jitoBundleSuccess } from "./metrics";

const log = createLogger("jito-tip");

interface JitoTipResponse {
  jsonrpc: string;
  id: string;
  result: {
    max_tip: number;
    min_tip: number;
  };
}

/**
 * Fetch recommended tip from Jito's API.
 * Falls back to provided default if fetch fails.
 */
export async function fetchRecommendedTip(
  jitoEngineUrl: string,
  defaultTipLamports: number,
  minTipLamports: number
): Promise<number> {
  try {
    const response = await fetch(`${jitoEngineUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "getTipAccounts",
        params: [],
      }),
    });

    if (!response.ok) {
      log.warn("Jito API returned non-OK status", { status: response.status });
      return defaultTipLamports;
    }

    const data = (await response.json()) as JitoTipResponse;
    const recommendedTip = data.result?.min_tip;

    if (!recommendedTip || recommendedTip < minTipLamports) {
      log.info("Using minimum tip", {
        recommended: recommendedTip,
        min: minTipLamports,
      });
      return minTipLamports;
    }

    log.info("Dynamic tip fetched", { tip: recommendedTip });
    return recommendedTip;
  } catch (err: any) {
    log.warn("Failed to fetch dynamic tip, using default", {
      error: err?.message,
      default: defaultTipLamports,
    });
    return defaultTipLamports;
  }
}

/**
 * Get the tip to use for Jito bundles.
 * If dynamic tip is enabled, fetches from Jito API.
 * Otherwise returns the configured static tip.
 */
export async function getJitoTip(
  jitoEngineUrl: string,
  staticTipLamports: number,
  dynamicTipEnabled: boolean,
  minTipLamports: number
): Promise<number> {
  if (dynamicTipEnabled) {
    return fetchRecommendedTip(jitoEngineUrl, staticTipLamports, minTipLamports);
  }
  return staticTipLamports;
}
