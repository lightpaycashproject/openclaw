import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Model, Api, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { log } from "./logger.js";

const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
};
// NOTE: We only force `store=true` for *direct* OpenAI Responses.
// Codex responses (chatgpt.com/backend-api/codex/responses) require `store=false`.
const OPENAI_RESPONSES_APIS = new Set(["openai-responses"]);
const OPENAI_RESPONSES_PROVIDERS = new Set(["openai"]);

/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
export function resolveExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  return modelConfig?.params ? { ...modelConfig.params } : undefined;
}

type CacheRetention = "none" | "short" | "long";
type CacheRetentionStreamOptions = Partial<SimpleStreamOptions> & {
  cacheRetention?: CacheRetention;
};

/**
 * Resolve cacheRetention from extraParams, supporting both new `cacheRetention`
 * and legacy `cacheControlTtl` values for backwards compatibility.
 *
 * Mapping: "5m" → "short", "1h" → "long"
 *
 * Only applies to Anthropic provider (OpenRouter caching is handled by
 * `createOpenRouterCacheControlWrapper` which injects hardcoded cache_control).
 */
function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): CacheRetention | undefined {
  if (provider !== "anthropic") {
    return undefined;
  }

  // Prefer new cacheRetention if present
  const newVal = extraParams?.cacheRetention;
  if (newVal === "none" || newVal === "short" || newVal === "long") {
    return newVal;
  }

  // Fall back to legacy cacheControlTtl with mapping
  const legacy = extraParams?.cacheControlTtl;
  if (legacy === "5m") {
    return "short";
  }
  if (legacy === "1h") {
    return "long";
  }
  return undefined;
}

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): StreamFn | undefined {
  if (!extraParams || Object.keys(extraParams).length === 0) {
    return undefined;
  }

  const streamParams: CacheRetentionStreamOptions = {};
  if (typeof extraParams.temperature === "number") {
    streamParams.temperature = extraParams.temperature;
  }
  if (typeof extraParams.maxTokens === "number") {
    streamParams.maxTokens = extraParams.maxTokens;
  }
  const cacheRetention = resolveCacheRetention(extraParams, provider);
  if (cacheRetention) {
    streamParams.cacheRetention = cacheRetention;
  }

  if (Object.keys(streamParams).length === 0) {
    return undefined;
  }

  log.debug(`creating streamFn wrapper with params: ${JSON.stringify(streamParams)}`);

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (model, context, options) =>
    underlying(model, context, {
      ...streamParams,
      ...options,
    });

  return wrappedStreamFn;
}

function isDirectOpenAIBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return true;
  }

  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com" || host === "chatgpt.com";
  } catch {
    const normalized = baseUrl.toLowerCase();
    return normalized.includes("api.openai.com") || normalized.includes("chatgpt.com");
  }
}

function shouldForceResponsesStore(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  if (typeof model.api !== "string" || typeof model.provider !== "string") {
    return false;
  }
  if (!OPENAI_RESPONSES_APIS.has(model.api)) {
    return false;
  }
  if (!OPENAI_RESPONSES_PROVIDERS.has(model.provider)) {
    return false;
  }
  return isDirectOpenAIBaseUrl(model.baseUrl);
}

function createOpenAIResponsesStoreWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldForceResponsesStore(model)) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          (payload as { store?: unknown }).store = true;
        }
        originalOnPayload?.(payload);
      },
    });
  };
}

/**
 * Create a streamFn wrapper that adds OpenRouter app attribution headers.
 * These headers allow OpenClaw to appear on OpenRouter's leaderboard.
 */
function createOpenRouterHeadersWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: {
        ...OPENROUTER_APP_HEADERS,
        ...options?.headers,
      },
    });
}

function assistantMessageHasToolCall(msg: AgentMessage): boolean {
  if (!msg || typeof msg !== "object" || msg.role !== "assistant") {
    return false;
  }
  if (!Array.isArray(msg.content)) {
    return false;
  }
  for (const block of msg.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type === "toolCall" || type === "toolUse" || type === "functionCall") {
      return true;
    }
  }
  return false;
}

/**
 * OpenRouter (and some upstream providers it routes to) may require `reasoning_content` to exist
 * on assistant tool-call messages when thinking is enabled.
 *
 * We set an empty string for compatibility, without mutating the original session transcript.
 */
function createOpenRouterReasoningContentWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model?.provider !== "openrouter" || model?.api !== "openai-completions") {
      return underlying(model, context, options);
    }

    const messages = (context as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return underlying(model, context, options);
    }

    let didChange = false;
    const nextMessages = messages.map((msg) => {
      const candidate = msg as AgentMessage;
      if (!assistantMessageHasToolCall(candidate)) {
        return msg;
      }
      const record = msg as Record<string, unknown>;
      if (typeof record.reasoning_content === "string") {
        return msg;
      }
      didChange = true;
      return { ...record, reasoning_content: "" };
    });

    if (!didChange) {
      return underlying(model, context, options);
    }

    return underlying(
      model,
      {
        ...(context as unknown as Record<string, unknown>),
        messages: nextMessages,
      } as typeof context,
      options,
    );
  };
}

/**
 * OpenRouter supports prompt caching for Anthropic models (and others).
 * To use it, we must add `cache_control: { type: "ephemeral" }` to the message
 * blocks we want to use as cache breakpoints.
 *
 * We automatically add this to the system prompt to avoid re-processing the
 * large system instruction on every turn.
 */
function createOpenRouterCacheControlWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    // Only apply cache_control for Anthropic models on OpenRouter
    // Other models (Moonshot, Qwen, etc.) don't support cache_control and would fail
    const isAnthropicOnOpenRouter =
      model?.provider === "openrouter" &&
      (model?.id?.startsWith("anthropic/") || model?.id?.includes("/claude"));
    if (!isAnthropicOnOpenRouter) {
      return underlying(model, context, options);
    }

    const ctx = context as { messages?: unknown[]; systemPrompt?: string };
    let messages = ctx.messages;
    if (!Array.isArray(messages)) {
      messages = [];
    }

    let nextMessages = [...messages];

    // Helper to inject cache_control into a specific message index
    const markCacheControl = (msgs: unknown[], index: number) => {
      if (index < 0 || index >= msgs.length) {
        return;
      }
      const target = msgs[index];
      // Don't overwrite existing control
      if ((target as Record<string, unknown>).cache_control) {
        return;
      }
      msgs[index] = {
        ...(target as Record<string, unknown>),
        cache_control: { type: "ephemeral" },
      };
    };

    // 1. Handle explicit systemPrompt field (convert to message(s))
    if (ctx.systemPrompt) {
      const fullPrompt = ctx.systemPrompt;
      const splitIndex = fullPrompt.indexOf("# Project Context");

      let newSystemMessages: unknown[];

      if (splitIndex !== -1) {
        // Split into [Static Instructions] and [Project Context]
        const staticPart = fullPrompt.slice(0, splitIndex).trim();
        const contextPart = fullPrompt.slice(splitIndex).trim();

        newSystemMessages = [
          { role: "system", content: staticPart },
          { role: "system", content: contextPart },
        ];

        // Mark BOTH parts.
        // Part 1 (Static) will effectively be a permanent cache hit prefix.
        // Part 2 (Context) will be cached if it doesn't change.
        markCacheControl(newSystemMessages, 0);
        markCacheControl(newSystemMessages, 1);
      } else {
        newSystemMessages = [{ role: "system", content: fullPrompt }];
        markCacheControl(newSystemMessages, 0);
      }

      return underlying(
        model,
        {
          ...ctx,
          messages: [...newSystemMessages, ...nextMessages],
          systemPrompt: undefined,
        } as typeof context,
        options,
      );
    }

    if (nextMessages.length === 0) {
      return underlying(model, context, options);
    }

    // 2. Handle existing system messages in messages array
    // We iterate backwards to find system messages.
    // If we find a large system message containing Project Context, we split it in place.
    let didChange = false;

    // We only want to split the *main* system prompt, which is usually the first one or
    // the one containing the context marker.
    // However, to be safe and simple, we scan for the marker.

    const contextMarker = "# Project Context";
    const sysMsgIndex = nextMessages.findIndex((m) => {
      const msg = m as { role?: string; content?: unknown };
      return (
        msg.role === "system" &&
        typeof msg.content === "string" &&
        msg.content.includes(contextMarker)
      );
    });

    if (sysMsgIndex !== -1) {
      const msg = nextMessages[sysMsgIndex] as { role: string; content: string };
      const content = msg.content;
      const splitIdx = content.indexOf(contextMarker);

      if (splitIdx !== -1) {
        const staticPart = content.slice(0, splitIdx).trim();
        const contextPart = content.slice(splitIdx).trim();

        // specific check to avoid splitting if static part is empty (unlikely)
        if (staticPart && contextPart) {
          const msgStatic = { ...msg, content: staticPart };
          const msgContext = { ...msg, content: contextPart };

          // Replace single message with two messages
          nextMessages.splice(sysMsgIndex, 1, msgStatic, msgContext);

          // Apply cache control to both new messages
          markCacheControl(nextMessages, sysMsgIndex);
          markCacheControl(nextMessages, sysMsgIndex + 1);
          didChange = true;
        }
      }
    }

    // Fallback: If no split occurred (or no marker found), ensure the LAST system message is marked.
    // This catches cases where there is no Project Context or it's already split.
    if (!didChange) {
      // Find last system message
      let lastSysIndex = -1;
      for (let i = nextMessages.length - 1; i >= 0; i--) {
        const m = nextMessages[i] as { role?: string };
        if (m.role === "system") {
          lastSysIndex = i;
          break;
        }
      }

      if (lastSysIndex !== -1) {
        if (!(nextMessages[lastSysIndex] as Record<string, unknown>).cache_control) {
          markCacheControl(nextMessages, lastSysIndex);
          didChange = true;
        }
      }
    }

    /*
     * Note: Context-caching (history) is also possible by marking the
     * second-to-last user message, but we start with system prompt only
     * to ensure stability and compatibility.
     */

    if (!didChange) {
      return underlying(model, context, options);
    }

    return underlying(
      model,
      {
        ...(context as unknown as Record<string, unknown>),
        messages: nextMessages,
      } as typeof context,
      options,
    );
  };
}

/**
 * Create a streamFn wrapper that injects tool_stream=true for Z.AI providers.
 *
 * Z.AI's API supports the `tool_stream` parameter to enable real-time streaming
 * of tool call arguments and reasoning content. When enabled, the API returns
 * progressive tool_call deltas, allowing users to see tool execution in real-time.
 *
 * @see https://docs.z.ai/api-reference#streaming
 */
function createZaiToolStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!enabled) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          // Inject tool_stream: true for Z.AI API
          (payload as Record<string, unknown>).tool_stream = true;
        }
        originalOnPayload?.(payload);
      },
    });
  };
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also adds OpenRouter app attribution headers when using the OpenRouter provider.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: OpenClawConfig | undefined,
  provider: string,
  modelId: string,
  extraParamsOverride?: Record<string, unknown>,
): void {
  const extraParams = resolveExtraParams({
    cfg,
    provider,
    modelId,
  });
  const override =
    extraParamsOverride && Object.keys(extraParamsOverride).length > 0
      ? Object.fromEntries(
          Object.entries(extraParamsOverride).filter(([, value]) => value !== undefined),
        )
      : undefined;
  const merged = Object.assign({}, extraParams, override);
  const wrappedStreamFn = createStreamFnWithExtraParams(agent.streamFn, merged, provider);

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }

  if (provider === "openrouter") {
    agent.streamFn = createOpenRouterReasoningContentWrapper(agent.streamFn);
    log.debug(`applying OpenRouter app attribution headers for ${provider}/${modelId}`);
    agent.streamFn = createOpenRouterHeadersWrapper(agent.streamFn);
    agent.streamFn = createOpenRouterCacheControlWrapper(agent.streamFn);
  }

  // Enable Z.AI tool_stream for real-time tool call streaming.
  // Enabled by default for Z.AI provider, can be disabled via params.tool_stream: false
  if (provider === "zai" || provider === "z-ai") {
    const toolStreamEnabled = merged?.tool_stream !== false;
    if (toolStreamEnabled) {
      log.debug(`enabling Z.AI tool_stream for ${provider}/${modelId}`);
      agent.streamFn = createZaiToolStreamWrapper(agent.streamFn, true);
    }
  }

  // Work around upstream pi-ai hardcoding `store: false` for Responses API.
  // Force `store=true` for direct OpenAI/OpenAI Codex providers so multi-turn
  // server-side conversation state is preserved.
  agent.streamFn = createOpenAIResponsesStoreWrapper(agent.streamFn);
  // Apply role transformation for incompatible providers
  if (needsRoleTransformation(provider, modelId)) {
    log.debug(`applying developer->system role transformation for ${provider}/${modelId}`);
    const originalStreamFn = agent.streamFn ?? streamSimple;
    agent.streamFn = (model, context, options) => {
      const transformedContext = {
        ...context,
        messages: transformDeveloperRole(
          context.messages as Array<{ role: string; content: unknown }>,
        ),
      };
      return originalStreamFn(model, transformedContext as typeof context, options);
    };
  }
}

/**
 * Wrap a streamFn to inject `thinking: { type: "disabled" }` into the Anthropic
 * API payload for reasoning-capable models when thinking is not enabled.
 *
 * Without this, some Anthropic-compatible providers (e.g. Synthetic/Kimi K2.5)
 * default to emitting thinking as plain text in regular content blocks when the
 * thinking parameter is absent, which leaks into user-visible output.
 */
export function createThinkingDisabledWrapper(baseStreamFn: StreamFn, model: Model<Api>): StreamFn {
  if (!model.reasoning || model.api !== "anthropic-messages") {
    return baseStreamFn;
  }

  log.debug("wrapping streamFn with thinking: disabled for anthropic-messages reasoning model");

  return (mdl, context, options) => {
    const nextOnPayload = (payload: unknown) => {
      const p = payload as Record<string, unknown>;
      if (!("thinking" in p)) {
        p.thinking = { type: "disabled" };
      }
      options?.onPayload?.(payload);
    };
    return baseStreamFn(mdl, context, {
      ...options,
      onPayload: nextOnPayload,
    });
  };
}

/**
 * Check if a provider requires developer -> system role transformation.
 * Only returns true for known incompatible providers (DeepSeek).
 * Default is false (no transformation) to avoid breaking other providers.
 *
 * @internal Exported for testing
 */
export function needsRoleTransformation(provider: string, modelId: string): boolean {
  // Only DeepSeek models are known to not support "developer" role
  if (modelId.toLowerCase().includes("deepseek")) {
    return true;
  }
  // Default: no transformation for unknown providers
  // This avoids breaking providers that may handle "developer" differently
  return false;
}

/**
 * Transform developer role messages to system role for incompatible providers.
 *
 * @internal Exported for testing
 */
export function transformDeveloperRole(
  messages: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
  return messages.map((msg) => (msg.role === "developer" ? { ...msg, role: "system" } : msg));
}
