import { InlineKeyboard } from "grammy";
import type { ProviderUsageSnapshot } from "../../infra/provider-usage.types.js";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import { buildAllowedModelSet, modelKey } from "../../agents/model-selection.js";
import { buildModelPickerItems } from "../../auto-reply/reply/directive-handling.model-picker.js";
import { OpenClawConfig } from "../../config/config.js";
import { formatUsageWindowSummary } from "../../infra/provider-usage.format.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import { resolveUsageProviderId } from "../../infra/provider-usage.shared.js";

const PAGE_SIZE = 10;

async function loadAndFilterCatalog(cfg: OpenClawConfig) {
  const catalog = await loadModelCatalog({ config: cfg, onlyAvailable: true });

  const { allowedKeys, allowAny } = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
  });

  const allItems = buildModelPickerItems(catalog).filter((item) => {
    if (allowAny) {
      return true;
    }
    return allowedKeys.has(modelKey(item.provider, item.model));
  });

  return allItems;
}

export async function buildModelPickerMessage(params: {
  cfg: OpenClawConfig;
  page: number;
  provider: string;
  currentModel?: string; // e.g. "anthropic/claude-3-5-sonnet-20240620"
  agentId?: string;
  agentDir?: string;
}) {
  const allFilteredItems = await loadAndFilterCatalog(params.cfg);
  const allItems = allFilteredItems.filter((item) => item.provider === params.provider);

  const totalPages = Math.ceil(allItems.length / PAGE_SIZE);
  const page = Math.max(1, Math.min(params.page, totalPages));
  const start = (page - 1) * PAGE_SIZE;
  const items = allItems.slice(start, start + PAGE_SIZE);

  const lines = ["<b>Select a Model</b>", ""];

  // Fetch usage for this provider
  const usageProviderId = resolveUsageProviderId(params.provider);
  let usageSnapshot: ProviderUsageSnapshot | undefined;
  if (usageProviderId) {
    try {
      const usageSummary = await loadProviderUsageSummary({
        providers: [usageProviderId],
        agentDir: params.agentDir ?? resolveOpenClawAgentDir(),
      });
      usageSnapshot = usageSummary.providers.find((p) => p.provider === usageProviderId);
      if (
        usageSnapshot &&
        usageSnapshot.windows.length > 0 &&
        params.provider !== "google-antigravity"
      ) {
        const usageLine = formatUsageWindowSummary(usageSnapshot);
        if (usageLine) {
          lines.push(`📊 <b>Usage:</b> ${usageLine}`);
          lines.push("");
        }
      }
    } catch {
      // ignore usage fetch errors in UI
    }
  }

  if (params.currentModel) {
    lines.push(`📍 <b>Current:</b> <code>${params.currentModel}</code>`);
    lines.push("");
  }

  const keyboard = new InlineKeyboard();

  function findUsageForModel(modelId: string, snapshot?: ProviderUsageSnapshot) {
    if (!snapshot?.windows.length) {
      return undefined;
    }
    const m = modelId.toLowerCase();
    const normalizedModelId = m.replace(/-/g, "");
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
    // Try exact or fuzzy match
    return snapshot.windows.find((w: { label: string; usedPercent: number }) => {
      const variants = normalizeLabel(w.label);
      return variants.some(
        (label) =>
          m.includes(label) ||
          label.includes(m) ||
          normalizedModelId.includes(label.replace(/-/g, "")),
      );
    });
  }

  const isOpenRouter = params.provider === "openrouter";

  for (const item of items) {
    const key = `${item.provider}/${item.model}`;
    const isSelected = params.currentModel === key;

    let usageLabel = "";
    const usage = findUsageForModel(item.model, usageSnapshot);
    const isFree =
      item.model.toLowerCase().includes(":free") || item.model.toLowerCase().endsWith("free");

    if (usage) {
      usageLabel = ` · ${Math.max(0, 100 - usage.usedPercent).toFixed(0)}%`;
    } else if (isOpenRouter) {
      if (isFree) {
        const isFreeTier = usageSnapshot?.windows.some((w) => w.label === "FreeTier");
        const quota = isFreeTier ? "50/d" : "1k/d";
        usageLabel = ` · Free (${quota})`;
      }
    }

    const label = `${item.model}${usageLabel}`;
    const btnLabel = isSelected ? `✅ ${label}` : label;

    // Callback data: mp:<provider>/<model>
    let callbackData = `mp:${key}`;
    if (callbackData.length > 64) {
      callbackData = callbackData.slice(0, 64);
    }
    keyboard.text(btnLabel, callbackData).row();
  }

  // Pagination
  if (page > 1) {
    keyboard.text("⬅️ Prev", `pg:${params.provider}:${page - 1}`);
  }
  keyboard.text(`${page}/${totalPages}`, "noop");
  if (page < totalPages) {
    keyboard.text("Next ➡️", `pg:${params.provider}:${page + 1}`);
  }
  keyboard.row().text("🔙 Back to Providers", "pl");

  return {
    text: lines.join("\n"),
    reply_markup: keyboard,
  };
}
export async function buildProviderPickerMessage(params: {
  cfg: OpenClawConfig;
  currentProvider?: string;
}) {
  const allItems = await loadAndFilterCatalog(params.cfg);

  const providerMap = new Map<string, number>();
  for (const item of allItems) {
    providerMap.set(item.provider, (providerMap.get(item.provider) || 0) + 1);
  }

  const providers = Array.from(providerMap.keys()).toSorted((a, b) => a.localeCompare(b));

  const lines = ["📂 <b>Select a Provider</b>", "", "Choose a provider to see available models:"];
  const keyboard = new InlineKeyboard();

  for (const provider of providers) {
    const count = providerMap.get(provider);
    const label = `${provider === params.currentProvider ? "✅ " : "📦 "}${provider} (${count})`;
    keyboard.text(label, `pp:${provider}`).row();
  }

  return {
    text: lines.join("\n"),
    reply_markup: keyboard,
  };
}
