import { Effect, Redacted, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { BankConnection } from "@/domain/connection";
import { ConnectionIdSchema } from "@/domain/identifiers";
import { AkahuProviderId, makeAkahuProvider } from "@/providers/akahu/provider";

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

const scopedConnection = (
  id: string,
  akahuConnectionId: string
): BankConnection => ({
  ...connection,
  id: Schema.decodeUnknownSync(ConnectionIdSchema)(id),
  metadata: { akahuConnectionId },
});

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
    const provider = makeProvider((input) => {
      const url = String(input);
      if (url.endsWith("/accounts")) {
        return Promise.resolve(
          Response.json({
            items: [
              {
                _id: "acc_example",
                balance: {
                  available: 80.25,
                  currency: "NZD",
                  current: 100.5,
                },
                connection: { _id: "conn_bnz", name: "BNZ" },
                formatted_account: "02-0000-0000000-00",
                meta: { holder: "Test Person" },
                name: "Everyday",
                refreshed: { balance: now, transactions: now },
                status: "ACTIVE",
                type: "CHECKING",
              },
            ],
            success: true,
          })
        );
      }
      return Promise.resolve(Response.json({ items: [], success: true }));
    });

    const result = await Effect.runPromise(
      provider.readSnapshot({ connection, start: null })
    );
    const [account] = result.accounts;

    expect(account).toMatchObject({
      currentBalance: 100.5,
      institution: "BNZ",
      providerAccountId: "acc_example",
      status: "active",
    });
    expect(account).not.toHaveProperty("id");
  });

  it("rejects malformed provider data as a typed error", async () => {
    const provider = makeProvider((input) => {
      const url = String(input);
      return Promise.resolve(
        url.endsWith("/accounts")
          ? Response.json({ items: [{ _id: 1 }], success: true })
          : Response.json({ items: [], success: true })
      );
    });

    const error = await Effect.runPromise(
      Effect.flip(provider.readSnapshot({ connection, start: null }))
    );

    expect(error._tag).toBe("InvalidProviderResponseError");
  });

  it("rejects empty provider identifiers as a typed response error", async () => {
    const provider = makeProvider((input) => {
      const url = String(input);
      return Promise.resolve(
        url.endsWith("/accounts")
          ? Response.json({
              items: [
                {
                  _id: "",
                  connection: { _id: "conn_bnz", name: "BNZ" },
                  name: "Everyday",
                  status: "ACTIVE",
                  type: "CHECKING",
                },
              ],
              success: true,
            })
          : Response.json({ items: [], success: true })
      );
    });

    const error = await Effect.runPromise(
      Effect.flip(provider.readSnapshot({ connection, start: null }))
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

  it("parses HTTP-date Retry-After values and rejects malformed values", async () => {
    const nowMillis = Date.parse(now);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMillis);
    try {
      const rateLimit = async (retryAfter: string) => {
        const provider = makeProvider(() =>
          Promise.resolve(
            new Response(null, {
              headers: { "Retry-After": retryAfter },
              status: 429,
            })
          )
        );
        return Effect.runPromise(
          Effect.flip(explicitRefresh(provider).request(connection))
        );
      };
      const future = await rateLimit(
        new Date(nowMillis + 30_000).toUTCString()
      );
      const past = await rateLimit(new Date(nowMillis - 30_000).toUTCString());
      const invalid = await rateLimit("not-a-date");

      expect({ future, invalid, past }).toMatchObject({
        future: { retryAfterSeconds: 30 },
        invalid: { retryAfterSeconds: null },
        past: { retryAfterSeconds: 0 },
      });
    } finally {
      nowSpy.mockRestore();
    }
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

    await Effect.runPromise(provider.readSnapshot({ connection, start: null }));

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

  it("scopes reads and refreshes to the configured Akahu connection", async () => {
    const requestedUrls: string[] = [];
    const connectionA = scopedConnection("connection_a", "conn_a");
    const provider = makeProvider((input, init) => {
      const url = String(input);
      requestedUrls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/accounts")) {
        return Promise.resolve(
          Response.json({
            items: [
              {
                _id: "acc_a",
                connection: { _id: "conn_a", name: "Bank A" },
                name: "A",
                status: "ACTIVE",
                type: "CHECKING",
              },
              {
                _id: "acc_b",
                connection: { _id: "conn_b", name: "Bank B" },
                name: "B",
                status: "ACTIVE",
                type: "CHECKING",
              },
            ],
            success: true,
          })
        );
      }
      if (url.includes("/transactions/pending")) {
        return Promise.resolve(
          Response.json({
            items: [
              {
                _account: "acc_a",
                amount: -1,
                date: now,
                description: "A pending",
                type: "CARD",
                updated_at: now,
              },
              {
                _account: "acc_b",
                amount: -2,
                date: now,
                description: "B pending",
                type: "CARD",
                updated_at: now,
              },
            ],
            success: true,
          })
        );
      }
      if (url.includes("/transactions?")) {
        return Promise.resolve(
          Response.json({
            items: [
              {
                _account: "acc_a",
                _id: "tx_a",
                amount: -1,
                created_at: now,
                date: now,
                description: "A posted",
                type: "CARD",
                updated_at: now,
              },
              {
                _account: "acc_b",
                _id: "tx_b",
                amount: -2,
                created_at: now,
                date: now,
                description: "B posted",
                type: "CARD",
                updated_at: now,
              },
            ],
            success: true,
          })
        );
      }
      if (url.endsWith("/refresh/conn_a")) {
        return Promise.resolve(Response.json({ success: true }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const snapshot = await Effect.runPromise(
      provider.readSnapshot({ connection: connectionA, start: null })
    );
    await Effect.runPromise(explicitRefresh(provider).request(connectionA));

    expect({
      accounts: snapshot.accounts.map((account) => account.providerAccountId),
      pending: snapshot.pending.map((item) => item.providerAccountId),
      posted: snapshot.posted.map((item) => item.providerAccountId),
      targetedRefresh: requestedUrls.includes(
        "POST https://api.example.test/refresh/conn_a"
      ),
    }).toStrictEqual({
      accounts: ["acc_a"],
      pending: ["acc_a"],
      posted: ["acc_a"],
      targetedRefresh: true,
    });
  });

  it("uses the configured refresh cooldown", () => {
    const provider = makeAkahuProvider({
      appToken: Redacted.make("app"),
      baseUrl: "https://api.example.test",
      refreshCooldownSeconds: 123,
      userToken: Redacted.make("user"),
    });

    expect(explicitRefresh(provider).minimumInterval).toStrictEqual(
      Effect.runSync(Effect.succeed(explicitRefresh(provider).minimumInterval))
    );
  });
});
