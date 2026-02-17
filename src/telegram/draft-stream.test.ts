import { describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";

describe("createTelegramDraftStream", () => {
  it("passes message_thread_id when provided", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1001 }),
      editMessageText: vi.fn().mockResolvedValue(true),
    };
    const warn = vi.fn();
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      thread: { id: 99, scope: "forum" },
      warn,
    });

    // First message
    stream.update("Hello");
    // Wait for internal async flush
    await new Promise((r) => setTimeout(r, 50));
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(
      123,
      "Hello",
      expect.objectContaining({
        message_thread_id: 99,
      }),
    );
  });

  it("omits message_thread_id for general topic id", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1002 }),
      editMessageText: vi.fn().mockResolvedValue(true),
    };
    const warn = vi.fn();
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      thread: { id: 1, scope: "forum" },
      warn,
    });

    stream.update("Hello");
    await new Promise((r) => setTimeout(r, 50));
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", {});
  });

  it("keeps message_thread_id for dm threads", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1003 }),
      editMessageText: vi.fn().mockResolvedValue(true),
    };
    const warn = vi.fn();
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      thread: { id: 1, scope: "dm" },
      warn,
    });

    stream.update("Hello");
    await new Promise((r) => setTimeout(r, 50));
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(
      123,
      "Hello",
      expect.objectContaining({
        message_thread_id: 1,
      }),
    );
  });
});
