import { resolveFetch } from "../infra/fetch.js";
/**
 * Cache for Antigravity model quota information.
 * Prevents calling the quota API for every request by caching results with TTL.
 *
 * Antigravity doesn't return HTTP 429 when rate limited - instead the connection
 * hangs indefinitely. This module enables proactive quota checking before requests.
 */
import { fetchAntigravityUsage } from "../infra/provider-usage.fetch.antigravity.js";

type QuotaInfo = {
  usedPercent: number;
  resetAt?: number;
};

type CacheEntry = {
  timestamp: number;
  quotas: Map<string, QuotaInfo>;
};

const quotaCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000; // 30 seconds
const QUOTA_FETCH_TIMEOUT_MS = 5_000; // 5 seconds

/**
 * Get cached or fresh quota info for a specific model.
 */
export async function getAntigravityModelQuota(
  profileId: string,
  accessToken: string,
  modelId: string,
): Promise<QuotaInfo | null> {
  const cached = quotaCache.get(profileId);
  const now = Date.now();

  // Return cached if fresh
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.quotas.get(modelId) ?? null;
  }

  // Fetch fresh quota
  try {
    const fetchFn = resolveFetch();
    if (!fetchFn) {
      return null;
    }

    const usage = await fetchAntigravityUsage(accessToken, QUOTA_FETCH_TIMEOUT_MS, fetchFn);

    if (!usage || usage.error) {
      // Don't cache errors - try again next time
      return null;
    }

    const quotas = new Map<string, QuotaInfo>();
    for (const window of usage.windows || []) {
      quotas.set(window.label, {
        usedPercent: window.usedPercent,
        resetAt: window.resetAt,
      });
    }

    quotaCache.set(profileId, { timestamp: now, quotas });
    return quotas.get(modelId) ?? null;
  } catch {
    // Quota fetch failed - return null to fall back to normal behavior
    return null;
  }
}

/**
 * Check if a model's quota is exhausted (>=99% used).
 */
export async function isModelQuotaExhausted(
  profileId: string,
  accessToken: string,
  modelId: string,
): Promise<{ exhausted: boolean; resetAt?: number }> {
  const quota = await getAntigravityModelQuota(profileId, accessToken, modelId);

  if (!quota) {
    // Couldn't get quota - assume not exhausted
    return { exhausted: false };
  }

  if (quota.usedPercent >= 99) {
    return {
      exhausted: true,
      resetAt: quota.resetAt,
    };
  }

  return { exhausted: false };
}

/**
 * Clear the quota cache (useful for testing or manual reset).
 */
export function clearQuotaCache(): void {
  quotaCache.clear();
}

/**
 * Get all cached quota info for a profile (for debugging).
 */
export function getCachedQuotas(profileId: string): CacheEntry | null {
  return quotaCache.get(profileId) ?? null;
}
