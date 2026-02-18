import { Type } from "@sinclair/typebox";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  applyPrimaryModel,
  normalizeModelKeys,
  resolveConfiguredModelKeys,
} from "../../commands/model-picker.js";
import type { OpenClawConfig } from "../../config/config.js";
import { writeConfig } from "../../config/io.js";
import { reloadConfig } from "../../config/reload.js";
import { loadModelCatalog } from "../model-catalog.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const MODEL_ACTIONS = [
  "add",
  "remove",
  "setPrimary",
  "setFallbacks",
  "list",
  "listAvailable",
  "search",
] as const;

const ModelManagementToolSchema = Type.Object({
  action: stringEnum(MODEL_ACTIONS),
  // add, remove
  model: Type.Optional(Type.String()),
  // setFallbacks
  models: Type.Optional(Type.String()),
  // listAvailable, search
  provider: Type.Optional(Type.String()),
  // search
  query: Type.Optional(Type.String()),
  // listAvailable, search
  limit: Type.Optional(Type.Number()),
});

export function createModelManagementTool(): AnyAgentTool {
  return {
    label: "Model Management",
    name: "model-management",
    description:
      "Manage configured models in OpenClaw. Actions: add, remove, setPrimary, setFallbacks, list (current config), listAvailable (browse catalog), search (search models). Use listAvailable to browse OpenRouter models.",
    parameters: ModelManagementToolSchema,
    execute: async (_toolCallId, args, context) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      let cfg: OpenClawConfig = context.config;
      let message = "";

      switch (action) {
        case "add": {
          const model = readStringParam(params, "model", { required: true });
          const existingKeys = resolveConfiguredModelKeys(cfg);
          const normalized = normalizeModelKeys([...existingKeys, model]);
          cfg = applyModelAllowlist(cfg, normalized);
          message = `Added model: ${model}`;
          break;
        }

        case "remove": {
          const model = readStringParam(params, "model", { required: true });
          const existingKeys = resolveConfiguredModelKeys(cfg);
          const normalized = normalizeModelKeys(existingKeys.filter((m) => m !== model));
          cfg = applyModelAllowlist(cfg, normalized);
          message = `Removed model: ${model}`;
          break;
        }

        case "setPrimary": {
          const model = readStringParam(params, "model", { required: true });
          cfg = applyPrimaryModel(cfg, model);
          message = `Primary model set to: ${model} (hot swap)`;
          break;
        }

        case "setFallbacks": {
          const modelsStr = readStringParam(params, "models", { required: true });
          const fallbackModels = modelsStr
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean);
          cfg = applyModelFallbacksFromSelection(cfg, fallbackModels);
          message = `Fallbacks set to: ${fallbackModels.join(", ")}`;
          break;
        }

        case "list": {
          const modelKeys = resolveConfiguredModelKeys(cfg);
          const current = cfg.agents?.defaults?.model;
          const primary = typeof current === "object" ? current?.primary : current;
          const fallbacks = typeof current === "object" ? current?.fallbacks : [];

          return jsonResult({
            primary: primary || null,
            fallbacks: fallbacks || [],
            allModels: modelKeys,
          });
        }

        case "listAvailable": {
          const provider = readStringParam(params, "provider");
          const limit = readNumberParam(params, "limit") ?? 50;

          const catalog = await loadModelCatalog({ config: cfg, useCache: false });
          let filtered = catalog;

          if (provider) {
            filtered = catalog.filter((m) => m.provider === provider);
          }

          const limited = filtered.slice(0, limit);

          // Group by provider
          const byProvider: Record<
            string,
            Array<{ id: string; name: string; contextWindow?: number; reasoning?: boolean }>
          > = {};
          for (const model of limited) {
            if (!byProvider[model.provider]) {
              byProvider[model.provider] = [];
            }
            byProvider[model.provider].push({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              reasoning: model.reasoning,
            });
          }

          return jsonResult({
            total: filtered.length,
            shown: limited.length,
            byProvider,
          });
        }

        case "search": {
          const query = readStringParam(params, "query", { required: true });
          const provider = readStringParam(params, "provider");
          const limit = readNumberParam(params, "limit") ?? 20;

          const catalog = await loadModelCatalog({ config: cfg, useCache: false });
          let filtered = catalog;

          if (provider) {
            filtered = filtered.filter((m) => m.provider === provider);
          }

          const queryLower = query.toLowerCase();
          const matched = filtered
            .filter(
              (m) =>
                m.id.toLowerCase().includes(queryLower) ||
                m.name.toLowerCase().includes(queryLower),
            )
            .slice(0, limit);

          return jsonResult({
            query,
            total: matched.length,
            models: matched.map((m) => ({
              provider: m.provider,
              id: m.id,
              name: m.name,
              contextWindow: m.contextWindow,
              reasoning: m.reasoning,
            })),
          });
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      // Write the updated config
      await writeConfig(cfg, context.workspaceDir);

      // Reload config in memory
      await reloadConfig();

      return jsonResult({ success: true, message });
    },
  };
}
