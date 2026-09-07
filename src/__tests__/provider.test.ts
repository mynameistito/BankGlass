import { Effect, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { BankConnection } from "@/domain/connection";
import { ConnectionIdSchema } from "@/domain/identifiers";
import {
  AkahuProviderId,
  decodeAkahuAccounts,
  makeAkahuProvider,
} from "@/providers/akahu/provider";

const now = "2026-08-26T00:00:00.000Z";
const connection: BankConnection = {
  authorization: { _tag: "Connected" },
  createdAt: now,
  enabled: true,
  id: Schema.decodeUnknownSync(ConnectionIdSchema)("connection_akahu_test"),
  label: "Akahu test",
  lastSyncAt: null,
  metadata: {},
  providerId: AkahuProviderId,
  updatedAt: now,
};

const makeProvider = (
  fetchImplementation: typeof fetch,
  requestTimeoutMs?: number
) => {
  const baseConfig = {
    appToken: Redacted.make("app"),
    baseUrl: "https://api.example.test",
    userToken: Redacted.make("user"),
  };
  return requestTimeoutMs === undefined
    ? makeAkahuProvider(baseConfig, fetchImplementation)
    : makeAkahuProvider(
        { ...baseConfig, requestTimeoutMs },
        fetchImplementation
      );
};

const explicitRefresh = (provider: ReturnType<typeof makeAkahuProvider>) => {
  if (provider.refresh._tag !== "Explicit") {
    throw new TypeError("Akahu must expose explicit refresh semantics");
  }
  return provider.refresh;
};

describe("Akahu provider boundary", () => {
  it("decodes a valid account without assigning a BankGlass-local ID", async () => {
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
      institution: "BNZ",
      providerAccountId: "acc_example",
      status: "active",
    });
    expect(result[0]).not.toHaveProperty("id");
  });

  it("rejects malformed provider data as a typed error", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decodeAkahuAccounts({ items: [{ _id: 1 }], success: true }, now)
      )
    );
    expect(error._tag).toBe("InvalidProviderResponseError");
  });

  it("models refresh rate limits without retrying them", async () => {
    let calls = 0;
    const provider = makeProvider(() => {
      calls += 1;
      return Promise.resolve(
        new Response(null, { headers: { "Retry-After": "30" }, status: 429 })
      );
    });

    const error = await Effect.runPromise(
      Effect.flip(explicitRefresh(provider).request(connection))
    );

    expect(error).toMatchObject({
      _tag: "ProviderRateLimitError",
      retryAfterSeconds: 30,
    });
    expect(calls).toBe(1);
  });

  it("retries transient read failures but not successful follow-up reads", async () => {
    let accountCalls = 0;
    const provider = makeProvider((input) => {
      const url = String(input);
      if (url.endsWith("/accounts")) {
        accountCalls += 1;
        return Promise.resolve(
          accountCalls < 3
            ? new Response(null, { status: 503 })
            : Response.json({ items: [], success: true })
        );
      }
      return Promise.resolve(Response.json({ items: [], success: true }));
    });

    await Effect.runPromise(
      provider.readSnapshot({ connection, start: null })
    );

    expect(accountCalls).toBe(3);
  });

  it("does not retry explicit refresh requests", async () => {
    let calls = 0;
    const provider = makeProvider(() => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: 503 }));
    });

    const error = await Effect.runPromise(
      Effect.flip(explicitRefresh(provider).request(connection))
    );

    expect(error._tag).toBe("ProviderUnavailableError");
    expect(calls).toBe(1);
  });

  it("aborts an explicit refresh when its response body times out", async () => {
    let aborted = false;
    const provider = makeProvider(
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
        ),
      5
    );

    const error = await Effect.runPromise(
      Effect.flip(explicitRefresh(provider).request(connection))
    );

    expect(error).toMatchObject({
      _tag: "ProviderUnavailableError",
      cause: "timeout",
    });
    expect(aborted).toBeTruthy();
  });

  it("rejects repeated transaction cursors", async () => {
    let transactionCalls = 0;
    const provider = makeProvider((input) => {
      const url = String(input);
      if (url.endsWith("/accounts")) {
        return Promise.resolve(Response.json({ items: [], success: true }));
      }
      if (url.includes("/transactions/pending")) {
        return Promise.resolve(Response.json({ items: [], success: true }));
      }
      transactionCalls += 1;
      return Promise.resolve(
        Response.json({
          cursor: { next: "repeated" },
          items: [],
          success: true,
        })
      );
    });

    const error = await Effect.runPromise(
      Effect.flip(provider.readSnapshot({ connection, start: null }))
    );

    expect(error._tag).toBe("InvalidProviderResponseError");
    expect(transactionCalls).toBe(2);
  });
});
