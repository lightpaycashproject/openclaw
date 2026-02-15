import type { ProviderUsageSnapshot } from "./provider-usage.types.js";
import { PROVIDER_LABELS } from "./provider-usage.shared.js";

/**
 * Fetch OpenRouter usage info.
 * OpenRouter doesn't have a direct "remaining quota" API that maps to models easily,
 * but it has a credits API.
 */
export async function fetchOpenRouterUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const keyUrl = "https://openrouter.ai/api/v1/key";
  const creditsUrl = "https://openrouter.ai/api/v1/credits";
  const coerceNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  };
  try {
    let creditsRemaining: number | undefined;
    let creditsUsedPercent: number | undefined;

    try {
      const creditsRes = await fetchFn(creditsUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (creditsRes.ok) {
        const creditsJson = (await creditsRes.json()) as {
          data: { total_credits: unknown; total_usage: unknown };
        };
        const totalCredits = coerceNumber(creditsJson.data.total_credits);
        const totalUsage = coerceNumber(creditsJson.data.total_usage);
        if (typeof totalCredits === "number" && typeof totalUsage === "number") {
          creditsRemaining = Math.max(0, totalCredits - totalUsage);
          if (totalCredits > 0) {
            creditsUsedPercent = (totalUsage / totalCredits) * 100;
          }
        }
      }
    } catch {
      // Ignore credits fetch errors; fall back to key-based data.
    }

    const res = await fetchFn(keyUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      if (res.status === 401) {
        return {
          provider: "openrouter",
          displayName: PROVIDER_LABELS.openrouter,
          windows: [],
          error: "Invalid API key",
        };
      }
      return {
        provider: "openrouter",
        displayName: PROVIDER_LABELS.openrouter,
        windows: [],
        error: `HTTP ${res.status}`,
      };
    }

    const json = (await res.json()) as {
      data: {
        usage: unknown;
        limit: unknown;
        limit_remaining: unknown;
        is_free_tier: boolean;
      };
    };

    const usage = coerceNumber(json.data.usage);
    const limit = coerceNumber(json.data.limit);
    const remaining = coerceNumber(json.data.limit_remaining);
    const remainingCredits =
      typeof creditsRemaining === "number"
        ? creditsRemaining
        : typeof remaining === "number"
          ? Math.max(0, remaining)
          : typeof limit === "number" && typeof usage === "number"
            ? Math.max(0, limit - usage)
            : undefined;

    let usedPercent = 0;
    if (typeof creditsUsedPercent === "number") {
      usedPercent = creditsUsedPercent;
    } else if (limit === null || limit === undefined || limit === 0) {
      usedPercent = 0;
    } else if (typeof remaining === "number") {
      usedPercent = ((limit - remaining) / limit) * 100;
    } else if (typeof usage === "number") {
      usedPercent = (usage / limit) * 100;
    }

    /*
      Use the key-based limits for tier labels, but prefer account credits
      when we can read them from /credits.
    */
    return {
      provider: "openrouter",
      displayName: PROVIDER_LABELS.openrouter,
      windows: [
        {
          label: "Credits",
          usedPercent,
          remaining: remainingCredits,
        },
        {
          label: json.data.is_free_tier ? "FreeTier" : "PaidTier",
          usedPercent: 0, // Label purpose
        },
      ],
    };
  } catch (err) {
    return {
      provider: "openrouter",
      displayName: PROVIDER_LABELS.openrouter,
      windows: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
