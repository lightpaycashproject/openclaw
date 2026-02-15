/**
 * In-memory cache of sent message IDs per chat.
 * Used to identify bot's own messages for reaction filtering ("own" mode).
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type CacheEntry = {
  messageIds: Set<number>;
  timestamps: Map<number, number>;
  contentHashes: Map<number, string>;
};

const sentMessages = new Map<string, CacheEntry>();

function getChatKey(chatId: number | string): string {
  return String(chatId);
}

function cleanupExpired(entry: CacheEntry): void {
  const now = Date.now();
  for (const [msgId, timestamp] of entry.timestamps) {
    if (now - timestamp > TTL_MS) {
      entry.messageIds.delete(msgId);
      entry.timestamps.delete(msgId);
      entry.contentHashes.delete(msgId);
    }
  }
}

/**
 * Record a message ID as sent by the bot, optionally with its content hash.
 */
export function recordSentMessage(
  chatId: number | string,
  messageId: number,
  content?: string,
): void {
  const key = getChatKey(chatId);
  let entry = sentMessages.get(key);
  if (!entry) {
    entry = { messageIds: new Set(), timestamps: new Map(), contentHashes: new Map() };
    sentMessages.set(key, entry);
  }
  entry.messageIds.add(messageId);
  entry.timestamps.set(messageId, Date.now());
  if (typeof content === "string") {
    entry.contentHashes.set(messageId, content);
  }
  // Periodic cleanup
  if (entry.messageIds.size > 100) {
    cleanupExpired(entry);
  }
}

/**
 * Check if the provided content is identical to what was last recorded for this message.
 */
export function isMessageContentUnchanged(
  chatId: number | string,
  messageId: number,
  content: string,
): boolean {
  const key = getChatKey(chatId);
  const entry = sentMessages.get(key);
  if (!entry) {
    return false;
  }
  const lastContent = entry.contentHashes.get(messageId);
  return lastContent === content;
}

/**
 * Check if a message was sent by the bot.
 */
export function wasSentByBot(chatId: number | string, messageId: number): boolean {
  const key = getChatKey(chatId);
  const entry = sentMessages.get(key);
  if (!entry) {
    return false;
  }
  // Clean up expired entries on read
  cleanupExpired(entry);
  return entry.messageIds.has(messageId);
}

/**
 * Clear all cached entries (for testing).
 */
export function clearSentMessageCache(): void {
  sentMessages.clear();
}
