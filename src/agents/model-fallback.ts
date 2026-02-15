import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import { isModelQuotaExhausted } from "./antigravity-quota-cache.js";
import {
  ensureAuthProfileStore,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  markAuthProfileFailure,
  setAuthProfileModelCooldownUntil,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isTimeoutError,
} from "./failover-error.js";
import { AllModelsFailedError } from "./model-fallback-error.js";
import {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  modelKey,
  normalizeModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import { isLikelyContextOverflowError } from "./pi-embedded-helpers.js";

type ModelCandidate = {
  provider: string;
  model: string;
};

type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};

/**
 * Fallback abort check. Only treats explicit AbortError names as user aborts.
 * Message-based checks (e.g., "aborted") can mask timeouts and skip fallback.
 */
function isFallbackAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if (isFailoverError(err)) {
    return false;
  }
  const name = "name" in err ? String(err.name) : "";
  return name === "AbortError";
}

function shouldRethrowAbort(err: unknown): boolean {
  return isFallbackAbortError(err) && !isTimeoutError(err);
}

function createModelCandidateCollector(allowlist: Set<string> | null | undefined): {
  candidates: ModelCandidate[];
  addCandidate: (candidate: ModelCandidate, enforceAllowlist: boolean) => void;
} {
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate, enforceAllowlist: boolean) => {
    if (!candidate.provider || !candidate.model) {
      return;
    }
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) {
      return;
    }
    if (enforceAllowlist && allowlist && !allowlist.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  return { candidates, addCandidate };
}

type ModelFallbackErrorHandler = (attempt: {
  provider: string;
  model: string;
  error: unknown;
  attempt: number;
  total: number;
}) => void | Promise<void>;

type ModelFallbackRunResult<T> = {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
};

function resolveImageFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
  modelOverride?: string;
}): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const { candidates, addCandidate } = createModelCandidateCollector(allowlist);

  const addRaw = (raw: string, enforceAllowlist: boolean) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    addCandidate(resolved.ref, enforceAllowlist);
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride, false);
  } else {
    const imageModel = params.cfg?.agents?.defaults?.imageModel as
      | { primary?: string }
      | string
      | undefined;
    const primary = typeof imageModel === "string" ? imageModel.trim() : imageModel?.primary;
    if (primary?.trim()) {
      addRaw(primary, false);
    }
  }

  const imageFallbacks = (() => {
    const imageModel = params.cfg?.agents?.defaults?.imageModel as
      | { fallbacks?: string[] }
      | string
      | undefined;
    if (imageModel && typeof imageModel === "object") {
      return imageModel.fallbacks ?? [];
    }
    return [];
  })();

  for (const raw of imageFallbacks) {
    addRaw(raw, true);
  }

  return candidates;
}

function resolveFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
}): ModelCandidate[] {
  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const providerRaw = String(params.provider ?? "").trim() || defaultProvider;
  const modelRaw = String(params.model ?? "").trim() || defaultModel;
  const normalizedPrimary = normalizeModelRef(providerRaw, modelRaw);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider,
  });
  const { candidates, addCandidate } = createModelCandidateCollector(allowlist);

  addCandidate(normalizedPrimary, false);

  const modelFallbacks = (() => {
    if (params.fallbacksOverride !== undefined) {
      return params.fallbacksOverride;
    }
    const model = params.cfg?.agents?.defaults?.model as
      | { fallbacks?: string[] }
      | string
      | undefined;
    if (model && typeof model === "object") {
      return model.fallbacks ?? [];
    }
    return [];
  })();

  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    addCandidate(resolved.ref, true);
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addCandidate({ provider: primary.provider, model: primary.model }, false);
  }

  return candidates;
}

const lastProbeAttempt = new Map<string, number>();
const MIN_PROBE_INTERVAL_MS = 30_000; // 30 seconds between probes per key
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const PROBE_SCOPE_DELIMITER = "::";

function resolveProbeThrottleKey(provider: string, agentDir?: string): string {
  const scope = String(agentDir ?? "").trim();
  return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}

function shouldProbePrimaryDuringCooldown(params: {
  isPrimary: boolean;
  hasFallbackCandidates: boolean;
  now: number;
  throttleKey: string;
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  profileIds: string[];
}): boolean {
  if (!params.isPrimary || !params.hasFallbackCandidates) {
    return false;
  }

  const lastProbe = lastProbeAttempt.get(params.throttleKey) ?? 0;
  if (params.now - lastProbe < MIN_PROBE_INTERVAL_MS) {
    return false;
  }

  const soonest = getSoonestCooldownExpiry(params.authStore, params.profileIds);
  if (soonest === null || !Number.isFinite(soonest)) {
    return true;
  }

  // Probe when cooldown already expired or within the configured margin.
  return params.now >= soonest - PROBE_MARGIN_MS;
}

/** @internal – exposed for unit tests only */
export const _probeThrottleInternals = {
  lastProbeAttempt,
  MIN_PROBE_INTERVAL_MS,
  PROBE_MARGIN_MS,
  resolveProbeThrottleKey,
} as const;

export async function runWithModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  /** Optional override for Antigravity quota checks (tests). */
  quotaCheck?: typeof isModelQuotaExhausted;
  /** Optional auth store override (tests). */
  authStoreOverride?: AuthProfileStore | null;
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
  });
  const quotaCheck = params.quotaCheck ?? isModelQuotaExhausted;
  const authStore =
    params.authStoreOverride ??
    (params.cfg ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }) : null);
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  const hasFallbackCandidates = candidates.length > 1;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (authStore) {
      const profileIds = resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: candidate.provider,
      });
      const isAnyProfileAvailable = profileIds.some(
        (id) => !isProfileInCooldown(authStore, id, candidate.model),
      );

      if (profileIds.length > 0 && !isAnyProfileAvailable) {
        // All profiles for this provider are in cooldown.
        // For the primary model (i === 0), probe it if the soonest cooldown
        // expiry is close or already past. This avoids staying on a fallback
        // model long after the real rate-limit window clears.
        const now = Date.now();
        const probeThrottleKey = resolveProbeThrottleKey(candidate.provider, params.agentDir);
        const shouldProbe = shouldProbePrimaryDuringCooldown({
          isPrimary: i === 0,
          hasFallbackCandidates,
          now,
          throttleKey: probeThrottleKey,
          authStore,
          profileIds,
        });
        if (!shouldProbe) {
          // Skip without attempting
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            error: `Provider ${candidate.provider} is in cooldown (all profiles unavailable)`,
            reason: "rate_limit",
          });
          continue;
        }
      }

      // Proactive quota check for Antigravity - they don't return 429, just hang
      if (candidate.provider === "google-antigravity") {
        let allProfilesExhausted = true;
        let quotaCheckAttempted = false;
        const profileIdsNeedingBackoff: string[] = [];
        for (const profileId of profileIds) {
          if (isProfileInCooldown(authStore, profileId, candidate.model)) {
            continue;
          }
          const profile = authStore.profiles[profileId];
          const accessToken =
            profile && "access" in profile && typeof profile.access === "string"
              ? profile.access
              : profile && profile.type === "token"
                ? profile.token
                : undefined;
          if (!profile || !accessToken) {
            continue;
          }
          quotaCheckAttempted = true;
          try {
            const quotaResult = await quotaCheck(profileId, accessToken, candidate.model);
            if (!quotaResult.exhausted) {
              allProfilesExhausted = false;
              break;
            }
            if (quotaResult.resetAt && Number.isFinite(quotaResult.resetAt)) {
              if (quotaResult.resetAt > Date.now()) {
                await setAuthProfileModelCooldownUntil({
                  store: authStore,
                  profileId,
                  modelId: candidate.model,
                  untilMs: quotaResult.resetAt,
                  agentDir: params.agentDir,
                });
              } else {
                profileIdsNeedingBackoff.push(profileId);
              }
            } else {
              profileIdsNeedingBackoff.push(profileId);
            }
          } catch {
            // Quota check failed - don't block, let request proceed
            allProfilesExhausted = false;
            break;
          }
        }
        if (allProfilesExhausted && quotaCheckAttempted) {
          // Mark profiles as rate-limited when we don't have a precise reset time.
          if (profileIdsNeedingBackoff.length > 0) {
            await Promise.all(
              profileIdsNeedingBackoff.map((profileId) =>
                markAuthProfileFailure({
                  store: authStore,
                  profileId,
                  reason: "rate_limit",
                  cfg: params.cfg,
                  agentDir: params.agentDir,
                  modelId: candidate.model,
                }),
              ),
            );
          }
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            error: `Model ${candidate.model} quota exhausted (all profiles at 99%+)`,
            reason: "rate_limit",
          });
          continue;
        }
      }
    }
    try {
      const result = await params.run(candidate.provider, candidate.model);
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      if (shouldRethrowAbort(err)) {
        throw err;
      }
      // Context overflow errors should be handled by the inner runner's
      // compaction/retry logic, not by model fallback.  If one escapes as a
      // throw, rethrow it immediately rather than trying a different model
      // that may have a smaller context window and fail worse.
      const errMessage = err instanceof Error ? err.message : String(err);
      if (isLikelyContextOverflowError(errMessage)) {
        throw err;
      }
      const normalized =
        coerceToFailoverError(err, {
          provider: candidate.provider,
          model: candidate.model,
        }) ?? err;
      if (!isFailoverError(normalized)) {
        throw err;
      }

      lastError = normalized;
      const described = describeFailoverError(normalized);
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described.message,
        reason: described.reason,
        status: described.status,
        code: described.code,
      });
      const next = candidates[i + 1];
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: normalized,
        attempt: i + 1,
        total: candidates.length,
        next: next ? { provider: next.provider, model: next.model } : undefined,
      });
    }
  }

  if (attempts.length <= 1 && lastError) {
    throw lastError;
  }
  const summary =
    attempts.length > 0
      ? attempts
          .map(
            (attempt) =>
              `${attempt.provider}/${attempt.model}: ${attempt.error}${
                attempt.reason ? ` (${attempt.reason})` : ""
              }`,
          )
          .join(" | ")
      : "unknown";

  // Check if all failures are due to rate limiting
  const allRateLimited = attempts.length > 0 && attempts.every((a) => a.reason === "rate_limit");

  let retryAfterMs: number | undefined;
  if (allRateLimited && authStore) {
    // Collect only the profileIds that were actually tried (from candidates)
    const profileIds = new Set<string>();
    for (const candidate of candidates) {
      const profiles = resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: candidate.provider,
      });
      profiles.forEach((id) => profileIds.add(id));
    }
    const earliestExpiry = findEarliestCooldownExpiry(authStore, profileIds);
    if (earliestExpiry) {
      retryAfterMs = Math.max(0, earliestExpiry - Date.now());
    }
  }

  throw new AllModelsFailedError(
    `All models failed (${attempts.length || candidates.length}): ${summary}`,
    { attempts, allInCooldown: allRateLimited, retryAfterMs, cause: lastError },
  );
}

export async function runWithImageModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveImageFallbackCandidates({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const result = await params.run(candidate.provider, candidate.model);
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      if (shouldRethrowAbort(err)) {
        throw err;
      }
      lastError = err;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: err instanceof Error ? err.message : String(err),
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: err,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  if (attempts.length <= 1 && lastError) {
    throw lastError;
  }
  const summary =
    attempts.length > 0
      ? attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`)
          .join(" | ")
      : "unknown";
  throw new Error(`All image models failed (${attempts.length || candidates.length}): ${summary}`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}
