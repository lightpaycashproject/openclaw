/**
 * Placeholder message controller for chat platforms.
 *
 * Sends a temporary "thinking" message when processing starts,
 * then deletes or edits it when the actual response is ready.
 */

export type ToolDisplayConfig = {
  emoji?: string;
  label?: string;
};

export type PlaceholderConfig = {
  /** Enable placeholder messages. Default: false. */
  enabled?: boolean;
  /** Custom messages to show while thinking. Randomly selected. */
  messages?: string[];
  /** Delete placeholder when response is ready. Default: true. */
  deleteOnResponse?: boolean;
  /** Tool display overrides. Key is tool name. */
  toolDisplay?: Record<string, ToolDisplayConfig>;
};

export type PlaceholderSender = {
  send: (text: string) => Promise<{ messageId: string; chatId: string }>;
  edit: (messageId: string, text: string) => Promise<void>;
  delete: (messageId: string) => Promise<void>;
};

export type PlaceholderController = {
  /** Send initial placeholder message. */
  start: () => Promise<void>;
  /** Update placeholder with tool usage info. */
  onTool: (toolName: string, args?: Record<string, unknown>) => Promise<void>;
  /** Clean up placeholder (delete or leave as-is). */
  cleanup: () => Promise<void>;
  /** Check if placeholder is active. */
  isActive: () => boolean;
};

const DEFAULT_MESSAGES = ["🤔 Thinking...", "💭 Processing...", "🧠 Working on it..."];

export function createPlaceholderController(params: {
  config: PlaceholderConfig;
  sender: PlaceholderSender;
  log?: (message: string) => void;
}): PlaceholderController {
  const { config, sender, log } = params;

  let placeholderMessageId: string | undefined;
  let active = false;
  let currentToolText = "";

  const messages = config.messages?.length ? config.messages : DEFAULT_MESSAGES;

  const getRandomMessage = () => {
    const idx = Math.floor(Math.random() * messages.length);
    return messages[idx] ?? messages[0] ?? DEFAULT_MESSAGES[0];
  };

  const getToolDisplay = (toolName: string) => {
    const override = config.toolDisplay?.[toolName];
    return {
      emoji: override?.emoji ?? "🔧",
      label: override?.label ?? toolName,
    };
  };

  const start = async () => {
    if (!config.enabled) {
      return;
    }
    if (active) {
      return;
    }

    try {
      const text = getRandomMessage();
      const result = await sender.send(text);
      placeholderMessageId = result.messageId;
      active = true;
      log?.(`Placeholder sent: ${result.messageId}`);
    } catch (err: unknown) {
      log?.(`Failed to send placeholder: ${String(err)}`);
    }
  };

  const onTool = async (toolName: string, args?: Record<string, unknown>) => {
    if (!config.enabled) {
      return;
    }
    if (!active || !placeholderMessageId) {
      return;
    }

    try {
      const display = getToolDisplay(toolName);
      let details = "";

      if (args) {
        if (toolName === "search_web" && typeof args.query === "string") {
          details = `: "${args.query.slice(0, 30)}${args.query.length > 30 ? "..." : ""}"`;
        } else if (
          (toolName === "read_url_content" || toolName === "open_browser_url") &&
          typeof args.Url === "string"
        ) {
          details = `: ${args.Url.slice(0, 40)}${args.Url.length > 40 ? "..." : ""}`;
        } else if (toolName === "grep_search" && typeof args.Query === "string") {
          details = `: "${args.Query.slice(0, 30)}${args.Query.length > 30 ? "..." : ""}"`;
        } else if (
          (toolName === "view_file" || toolName === "read_file") &&
          typeof args.AbsolutePath === "string"
        ) {
          const fname = args.AbsolutePath.split("/").pop() ?? args.AbsolutePath;
          details = `: ${fname}`;
        }
      }

      currentToolText = `${display.emoji} ${display.label}${details}...`;

      await sender.edit(placeholderMessageId, currentToolText);
      log?.(`Placeholder updated: ${toolName} -> ${currentToolText}`);
    } catch (err: unknown) {
      log?.(`Failed to update placeholder: ${String(err)}`);
    }
  };

  const cleanup = async () => {
    if (!active || !placeholderMessageId) {
      return;
    }

    const shouldDelete = config.deleteOnResponse !== false;

    if (shouldDelete) {
      try {
        await sender.delete(placeholderMessageId);
        log?.(`Placeholder deleted: ${placeholderMessageId}`);
      } catch (err: unknown) {
        log?.(`Failed to delete placeholder: ${String(err)}`);
      }
    }

    placeholderMessageId = undefined;
    active = false;
    currentToolText = "";
  };

  const isActive = () => active;

  return {
    start,
    onTool,
    cleanup,
    isActive,
  };
}
