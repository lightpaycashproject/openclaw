import type { FallbackAttempt } from "./model-fallback.js";

export class AllModelsFailedError extends Error {
  attempts: FallbackAttempt[];
  allInCooldown: boolean;
  retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      attempts: FallbackAttempt[];
      allInCooldown: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "AllModelsFailedError";
    this.attempts = options.attempts;
    this.allInCooldown = options.allInCooldown;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isAllModelsFailedError(err: unknown): err is AllModelsFailedError {
  return err instanceof AllModelsFailedError;
}
