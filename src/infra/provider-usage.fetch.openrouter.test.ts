import { describe, expect, it, vi } from "vitest";
import { fetchOpenRouterUsage } from "./provider-usage.fetch.openrouter.js";

type CreditsResponse = {
  ok?: boolean;
  status?: number;
  data?: { total_credits: unknown; total_usage: unknown };
};

type KeyResponse = {
  ok?: boolean;
  status?: number;
  data: {
    usage: unknown;
    limit: unknown;
    limit_remaining: unknown;
    is_free_tier: boolean;
  };
};

const makeFetch = (opts: { credits?: CreditsResponse; key: KeyResponse }) =>
  vi.fn(async (url: RequestInfo | URL) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.endsWith("/credits")) {
      const ok = opts.credits?.ok ?? true;
      const status = opts.credits?.status ?? (ok ? 200 : 403);
      return {
        ok,
        status,
        json: async () => ({
          data: opts.credits?.data ?? { total_credits: null, total_usage: null },
        }),
      };
    }
    if (href.endsWith("/key")) {
      const ok = opts.key.ok ?? true;
      const status = opts.key.status ?? 200;
      return {
        ok,
        status,
        json: async () => ({ data: opts.key.data }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  }) as unknown as typeof fetch;

describe("fetchOpenRouterUsage", () => {
  it("uses credits endpoint balance when available", async () => {
    const fetchFn = makeFetch({
      credits: {
        data: { total_credits: "20", total_usage: "5" },
      },
      key: {
        data: {
          usage: "2.5",
          limit: "10",
          limit_remaining: "7.5",
          is_free_tier: false,
        },
      },
    });

    const result = await fetchOpenRouterUsage("token", 1000, fetchFn);

    const credits = result.windows.find((window) => window.label === "Credits");
    expect(credits?.remaining).toBe(15);
    expect(credits?.usedPercent).toBeCloseTo(25, 3);
  });

  it("falls back to key limit when credits are unavailable", async () => {
    const fetchFn = makeFetch({
      credits: { ok: false, status: 403 },
      key: {
        data: {
          usage: "5",
          limit: "20",
          limit_remaining: null,
          is_free_tier: true,
        },
      },
    });

    const result = await fetchOpenRouterUsage("token", 1000, fetchFn);

    const credits = result.windows.find((window) => window.label === "Credits");
    expect(credits?.remaining).toBe(15);
    expect(credits?.usedPercent).toBeCloseTo(25, 3);
  });
});
