import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeAkahuAccounts, makeAkahuBankProvider } from "@/akahu-provider";

const now = "2026-08-26T00:00:00.000Z";
describe("Akahu provider boundary", () => {
  it("decodes and normalizes a valid account response", async () => {
    const result = await Effect.runPromise(
      decodeAkahuAccounts(
        {
          items: [
            {
              _id: "acc_example",
              balance: { available: 80.25, currency: "NZD", current: 100.5 },
              connection: { name: "BNZ" },
              formatted_account: "02-0000-0000000-00",
              meta: { holder: "Test Person" },
              name: "Everyday",
              refreshed: { balance: now, transactions: now },
              status: "ACTIVE",
              type: "CHECKING",
            },
          ],
          success: true,
        },
        now
      )
    );
    expect(result[0]).toMatchObject({
      currentBalance: 100.5,
      id: "account_acc_example",
      institution: "BNZ",
      status: "active",
    });
  });

  it("rejects malformed provider data as a typed error", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decodeAkahuAccounts({ items: [{ _id: 1 }], success: true }, now)
      )
    );
    expect(error._tag).toBe("InvalidProviderResponseError");
  });

  it("models upstream rate limits without retrying them", async () => {
    let calls = 0;
    const provider = makeAkahuBankProvider(
      {
        appToken: "app",
        baseUrl: "https://api.example.test",
        userToken: "user",
      },
      () => {
        calls += 1;
        return Promise.resolve(
          new Response(null, { headers: { "Retry-After": "30" }, status: 429 })
        );
      }
    );
    const error = await Effect.runPromise(Effect.flip(provider.requestRefresh));
    expect(error).toMatchObject({
      _tag: "ProviderRateLimitError",
      retryAfterSeconds: 30,
    });
    expect(calls).toBe(1);
  });

  it("retries transient provider failures", async () => {
    let calls = 0;
    const provider = makeAkahuBankProvider(
      {
        appToken: "app",
        baseUrl: "https://api.example.test",
        userToken: "user",
      },
      () => {
        calls += 1;
        return Promise.resolve(
          calls < 3
            ? new Response(null, { status: 503 })
            : Response.json({ items: [], success: true })
        );
      }
    );
    await Effect.runPromise(provider.getAccounts);
    expect(calls).toBe(3);
  });

  it("does not retry refresh requests", async () => {
    let calls = 0;
    const provider = makeAkahuBankProvider(
      {
        appToken: "app",
        baseUrl: "https://api.example.test",
        userToken: "user",
      },
      () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: 503 }));
      }
    );

    const error = await Effect.runPromise(Effect.flip(provider.requestRefresh));

    expect(error._tag).toBe("ProviderUnavailableError");
    expect(calls).toBe(1);
  });

  it("aborts a refresh when its response body times out", async () => {
    let aborted = false;
    const provider = makeAkahuBankProvider(
      {
        appToken: "app",
        baseUrl: "https://api.example.test",
        requestTimeoutMs: 5,
        userToken: "user",
      },
      (_input, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start: (controller) => {
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    controller.error(new DOMException("Aborted", "AbortError"));
                  },
                  { once: true }
                );
              },
            })
          )
        )
    );

    const error = await Effect.runPromise(Effect.flip(provider.requestRefresh));

    expect(error).toMatchObject({
      _tag: "ProviderUnavailableError",
      cause: "timeout",
    });
    expect(aborted).toBeTruthy();
  });

  it("rejects repeated transaction cursors", async () => {
    let calls = 0;
    const provider = makeAkahuBankProvider(
      {
        appToken: "app",
        baseUrl: "https://api.example.test",
        userToken: "user",
      },
      () => {
        calls += 1;
        return Promise.resolve(
          Response.json({
            cursor: { next: "repeated" },
            items: [],
            success: true,
          })
        );
      }
    );

    const error = await Effect.runPromise(
      Effect.flip(provider.getTransactions({ start: null }))
    );

    expect(error._tag).toBe("InvalidProviderResponseError");
    expect(calls).toBe(2);
  });
});
