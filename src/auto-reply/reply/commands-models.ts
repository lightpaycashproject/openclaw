import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderUsageSnapshot } from "../../infra/provider-usage.types.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler } from "./commands-types.js";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import { resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  type ProviderInfo,
} from "../../telegram/model-buttons.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

export type ModelsProviderData = {
  byProvider: Map<string, Set<string>>;
  providers: string[];
  resolvedDefault: { provider: string; model: string };
};

function findUsageForModel(
  modelId: string,
  snapshot?: ProviderUsageSnapshot,
): { usedPercent: number } | undefined {
  if (!snapshot?.windows.length) {
    return undefined;
  }
  const lowerModelId = modelId.toLowerCase();
  const normalizedModelId = lowerModelId.replace(/-/g, "");
  const normalizeLabel = (label: string) => {
    const trimmed = label.toLowerCase();
    const variants = new Set<string>();
    variants.add(trimmed);
    variants.add(trimmed.replace(/^models\//, ""));
    const lastSegment = trimmed.split("/").at(-1);
    if (lastSegment) {
      variants.add(lastSegment);
    }
    variants.add(trimmed.replace(/-/g, ""));
    return [...variants];
  };
  return snapshot.windows.find((window) => {
    const variants = normalizeLabel(window.label);
    return variants.some(
      (label) =>
        lowerModelId.includes(label) ||
        label.includes(lowerModelId) ||
        normalizedModelId.includes(label.replace(/-/g, "")),
    );
  });
}

function formatRemainingPercent(usedPercent: number): string {
  if (!Number.isFinite(usedPercent)) {
    return "0%";
  }
  const remaining = Math.max(0, Math.min(100, 100 - usedPercent));
  return `${remaining.toFixed(0)}%`;
}

export async function buildModelsUsageLabels(params: {
  provider: string;
  models: string[];
  agentDir?: string;
}): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const usageProviderId = resolveUsageProviderId(params.provider);
  if (!usageProviderId) {
    return labels;
  }

  let snapshot: ProviderUsageSnapshot | undefined;
  try {
    const usageSummary = await loadProviderUsageSummary({
      providers: [usageProviderId],
      agentDir: params.agentDir ?? resolveOpenClawAgentDir(),
    });
    snapshot = usageSummary.providers.find((entry) => entry.provider === usageProviderId);
  } catch {
    return labels;
  }

  if (!snapshot) {
    return labels;
  }

  if (params.provider === "google-antigravity") {
    for (const model of params.models) {
      const usage = findUsageForModel(model, snapshot);
      if (usage) {
        labels.set(model, ` · ${formatRemainingPercent(usage.usedPercent)}`);
      }
    }
    return labels;
  }

  if (params.provider === "openrouter") {
    const credits = snapshot.windows.find((window) => window.label === "Credits");
    const isFreeTier = snapshot.windows.some((window) => window.label === "FreeTier");
    const creditsRemaining =
      typeof credits?.remaining === "number" ? Math.max(0, credits.remaining) : undefined;
    const creditsLabel =
      typeof creditsRemaining === "number" ? ` · Credits $${creditsRemaining.toFixed(2)}` : "";

    for (const model of params.models) {
      const lower = model.toLowerCase();
      const isFree = lower.includes(":free") || lower.endsWith("free");
      if (isFree) {
        const quota = isFreeTier ? "50/d" : "1k/d";
        labels.set(model, ` · Free (${quota})`);
      } else if (creditsLabel) {
        labels.set(model, creditsLabel);
      }
    }
  }

  return labels;
}

/**
 * Build provider/model data from config and catalog.
 * Exported for reuse by callback handlers.
 */
export async function buildModelsProviderData(cfg: OpenClawConfig): Promise<ModelsProviderData> {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });

  const catalog = await loadModelCatalog({ config: cfg });
  const allowed = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
  });

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: resolvedDefault.provider,
  });

  const byProvider = new Map<string, Set<string>>();
  const add = (p: string, m: string) => {
    const key = normalizeProviderId(p);
    const set = byProvider.get(key) ?? new Set<string>();
    set.add(m);
    byProvider.set(key, set);
  };

  const addRawModelRef = (raw?: string) => {
    const trimmed = raw?.trim();
    if (!trimmed) {
      return;
    }
    const resolved = resolveModelRefFromString({
      raw: trimmed,
      defaultProvider: resolvedDefault.provider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    add(resolved.ref.provider, resolved.ref.model);
  };

  const addModelConfigEntries = () => {
    const modelConfig = cfg.agents?.defaults?.model;
    if (typeof modelConfig === "string") {
      addRawModelRef(modelConfig);
    } else if (modelConfig && typeof modelConfig === "object") {
      addRawModelRef(modelConfig.primary);
      for (const fallback of modelConfig.fallbacks ?? []) {
        addRawModelRef(fallback);
      }
    }

    const imageConfig = cfg.agents?.defaults?.imageModel;
    if (typeof imageConfig === "string") {
      addRawModelRef(imageConfig);
    } else if (imageConfig && typeof imageConfig === "object") {
      addRawModelRef(imageConfig.primary);
      for (const fallback of imageConfig.fallbacks ?? []) {
        addRawModelRef(fallback);
      }
    }
  };

  for (const entry of allowed.allowedCatalog) {
    add(entry.provider, entry.id);
  }

  // Include config-only allowlist keys that aren't in the curated catalog.
  for (const raw of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    addRawModelRef(raw);
  }

  // Ensure configured defaults/fallbacks/image models show up even when the
  // curated catalog doesn't know about them (custom providers, dev builds, etc.).
  add(resolvedDefault.provider, resolvedDefault.model);
  addModelConfigEntries();

  const providers = [...byProvider.keys()].toSorted();

  return { byProvider, providers, resolvedDefault };
}

function formatProviderLine(params: { provider: string; count: number }): string {
  return `- ${params.provider} (${params.count})`;
}

function parseModelsArgs(raw: string): {
  provider?: string;
  page: number;
  pageSize: number;
  all: boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { page: 1, pageSize: PAGE_SIZE_DEFAULT, all: false };
  }

  const tokens = trimmed.split(/\s+/g).filter(Boolean);
  const provider = tokens[0]?.trim();

  let page = 1;
  let all = false;
  for (const token of tokens.slice(1)) {
    const lower = token.toLowerCase();
    if (lower === "all" || lower === "--all") {
      all = true;
      continue;
    }
    if (lower.startsWith("page=")) {
      const value = Number.parseInt(lower.slice("page=".length), 10);
      if (Number.isFinite(value) && value > 0) {
        page = value;
      }
      continue;
    }
    if (/^[0-9]+$/.test(lower)) {
      const value = Number.parseInt(lower, 10);
      if (Number.isFinite(value) && value > 0) {
        page = value;
      }
    }
  }

  let pageSize = PAGE_SIZE_DEFAULT;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith("limit=") || lower.startsWith("size=")) {
      const rawValue = lower.slice(lower.indexOf("=") + 1);
      const value = Number.parseInt(rawValue, 10);
      if (Number.isFinite(value) && value > 0) {
        pageSize = Math.min(PAGE_SIZE_MAX, value);
      }
    }
  }

  return {
    provider: provider ? normalizeProviderId(provider) : undefined,
    page,
    pageSize,
    all,
  };
}

export async function resolveModelsCommandReply(params: {
  cfg: OpenClawConfig;
  commandBodyNormalized: string;
  surface?: string;
  currentModel?: string;
}): Promise<ReplyPayload | null> {
  const body = params.commandBodyNormalized.trim();
  if (!body.startsWith("/models")) {
    return null;
  }

  const argText = body.replace(/^\/models\b/i, "").trim();
  const { provider, page, pageSize, all } = parseModelsArgs(argText);

  const { byProvider, providers } = await buildModelsProviderData(params.cfg);
  const isTelegram = params.surface === "telegram";

  // Provider list (no provider specified)
  if (!provider) {
    // For Telegram: show buttons if there are providers
    if (isTelegram && providers.length > 0) {
      const providerInfos: ProviderInfo[] = providers.map((p) => ({
        id: p,
        count: byProvider.get(p)?.size ?? 0,
      }));
      const buttons = buildProviderKeyboard(providerInfos);
      const text = "Select a provider:";
      return {
        text,
        channelData: { telegram: { buttons } },
      };
    }

    // Text fallback for non-Telegram surfaces
    const lines: string[] = [
      "Providers:",
      ...providers.map((p) =>
        formatProviderLine({ provider: p, count: byProvider.get(p)?.size ?? 0 }),
      ),
      "",
      "Use: /models <provider>",
      "Switch: /model <provider/model>",
    ];
    return { text: lines.join("\n") };
  }

  if (!byProvider.has(provider)) {
    const lines: string[] = [
      `Unknown provider: ${provider}`,
      "",
      "Available providers:",
      ...providers.map((p) => `- ${p}`),
      "",
      "Use: /models <provider>",
    ];
    return { text: lines.join("\n") };
  }

  const models = [...(byProvider.get(provider) ?? new Set<string>())].toSorted();
  const total = models.length;

  if (total === 0) {
    const lines: string[] = [
      `Models (${provider}) — none`,
      "",
      "Browse: /models",
      "Switch: /model <provider/model>",
    ];
    return { text: lines.join("\n") };
  }

  // For Telegram: use button-based model list with inline keyboard pagination
  if (isTelegram) {
    const telegramPageSize = getModelsPageSize();
    const totalPages = calculateTotalPages(total, telegramPageSize);
    const safePage = Math.max(1, Math.min(page, totalPages));
    const usageLabels = await buildModelsUsageLabels({ provider, models });

    const buttons = buildModelsKeyboard({
      provider,
      models,
      currentModel: params.currentModel,
      modelLabels: usageLabels,
      currentPage: safePage,
      totalPages,
      pageSize: telegramPageSize,
    });

    const text = `Models (${provider}) — ${total} available`;
    return {
      text,
      channelData: { telegram: { buttons } },
    };
  }

  // Text fallback for non-Telegram surfaces
  const effectivePageSize = all ? total : pageSize;
  const pageCount = effectivePageSize > 0 ? Math.ceil(total / effectivePageSize) : 1;
  const safePage = all ? 1 : Math.max(1, Math.min(page, pageCount));

  if (!all && page !== safePage) {
    const lines: string[] = [
      `Page out of range: ${page} (valid: 1-${pageCount})`,
      "",
      `Try: /models ${provider} ${safePage}`,
      `All: /models ${provider} all`,
    ];
    return { text: lines.join("\n") };
  }

  const startIndex = (safePage - 1) * effectivePageSize;
  const endIndexExclusive = Math.min(total, startIndex + effectivePageSize);
  const pageModels = models.slice(startIndex, endIndexExclusive);

  const header = `Models (${provider}) — showing ${startIndex + 1}-${endIndexExclusive} of ${total} (page ${safePage}/${pageCount})`;

  const lines: string[] = [header];
  for (const id of pageModels) {
    lines.push(`- ${provider}/${id}`);
  }

  lines.push("", "Switch: /model <provider/model>");
  if (!all && safePage < pageCount) {
    lines.push(`More: /models ${provider} ${safePage + 1}`);
  }
  if (!all) {
    lines.push(`All: /models ${provider} all`);
  }

  const payload: ReplyPayload = { text: lines.join("\n") };
  return payload;
}

export const handleModelsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const reply = await resolveModelsCommandReply({
    cfg: params.cfg,
    commandBodyNormalized: params.command.commandBodyNormalized,
    surface: params.ctx.Surface,
    currentModel: params.model ? `${params.provider}/${params.model}` : undefined,
  });
  if (!reply) {
    return null;
  }
  return { reply, shouldContinue: false };
};
