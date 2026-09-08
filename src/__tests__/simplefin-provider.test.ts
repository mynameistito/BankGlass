import { Effect, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { BankConnection } from "@/domain/connection";
import { ConnectionIdSchema } from "@/domain/identifiers";
import {
  makeSimpleFinProvider,
  SimpleFinProviderId,
} from "@/providers/simplefin/provider";

const connectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_simplefin_test"
);
const connection: BankConnection = {
  authorization: { _tag: "Connected" },
  createdAt: "2026-09-08T00:00:00.000Z",
  enabled: true,
  id: connectionId,
  label: "SimpleFIN test",
  lastSyncAt: null,
  metadata: {},
  providerId: SimpleFinProviderId,
  updatedAt: "2026-09-08T00:00:00.000Z",
};

const accessUrl = "https://demo:secret@bridge.example.test/simplefin";

const accountSet = {
  accounts: [
    {
      "available-balance": "90.25",
      balance: "100.50",
      "balance-date": 1_725_696_000,
      conn_id: "bank-a",
      currency: "NZD",
      id: "shared-account",
      name: "Everyday",
      transactions: [
        {
          amount: "-5.25",
          description: "Coffee",
          id: "shared-transaction",
          posted: 1_725_695_000,
          transacted_at: 1_725_694_000,
        },
        {
          amount: "-12.00",
          description: "Pending groceries",
          id: "pending-transaction",
          pending: true,
          posted: 0,
        },
      ],
    },
    {
      balance: "42.00",
      "balance-date": 1_725_696_100,
      conn_id: "bank-b",
      currency: "NZD",
      id: "shared-account",
      name: "Savings",
      transactions: [
        {
          amount: "1.00",
          description: "Interest",
          id: "shared-transaction",
          posted: 1_725_696_000,
        },
      ],
    },
  ],
  connections: [
    {
      conn_id: "bank-a",
      name: "Bank A - Personal",
      org_id: "bank-a-org",
      org_name: "Bank A",
      sfin_url: "https://bank-a.example.test/simplefin",
    },
    {
      conn_id: "bank-b",
      name: "Bank B - Personal",
      org_id: "bank-b-org",
      org_name: "Bank B",
      sfin_url: "https://bank-b.example.test/simplefin",
    },
  ],
  errlist: [],
} as const;

const provider = (fetchImplementation: typeof fetch) =>
  makeSimpleFinProvider(
    {
      accessUrls: new Map([[connectionId, Redacted.make(accessUrl)]]),
    },
    fetchImplementation
  );

describe("SimpleFIN provider boundary", () => {
  it("uses Basic Auth without exposing credentials in the request URL", async () => {
    let capturedUrl = "";
    let capturedAuthorization = "";
    const adapter = provider((input, init) => {
      capturedUrl = String(input);
      capturedAuthorization =
        new Headers(init?.headers).get("Authorization") ?? "";
      return Promise.resolve(Response.json(accountSet));
    });

    const snapshot = await Effect.runPromise(
      adapter.readSnapshot({
        connection,
        start: "2026-08-25T12:34:56.000Z",
      })
    );
    const url = new URL(capturedUrl);

    expect({
      accountCount: snapshot.accounts.length,
      authorization: capturedAuthorization,
      password: url.password,
      pathname: url.pathname,
      pending: url.searchParams.get("pending"),
      startDate: url.searchParams.get("start-date"),
      username: url.username,
      version: url.searchParams.get("version"),
    }).toStrictEqual({
      accountCount: 2,
      authorization: `Basic ${btoa("demo:secret")}`,
      password: "",
      pathname: "/simplefin/accounts",
      pending: "1",
      startDate: String(
        Math.floor(Date.parse("2026-08-25T12:34:56.000Z") / 1000)
      ),
      username: "",
      version: "2",
    });
  });

  it("normalizes balances and separates posted from pending transactions", async () => {
    const adapter = provider(() => Promise.resolve(Response.json(accountSet)));

    const snapshot = await Effect.runPromise(
      adapter.readSnapshot({ connection, start: null })
    );
    const everyday = snapshot.accounts.find(
      (account) => account.name === "Everyday"
    );
    const savings = snapshot.accounts.find(
      (account) => account.name === "Savings"
    );

    expect({
      everyday,
      pending: snapshot.pending,
      pendingCount: snapshot.pending.length,
      postedCount: snapshot.posted.length,
      savings,
    }).toMatchObject({
      everyday: {
        availableBalance: 90.25,
        currentBalance: 100.5,
        institution: "Bank A",
      },
      pending: [
        {
          amount: -12,
          description: "Pending groceries",
          status: "pending",
        },
      ],
      pendingCount: 1,
      postedCount: 2,
      savings: {
        availableBalance: 42,
        currentBalance: 42,
        institution: "Bank B",
      },
    });
  });

  it("namespaces duplicate upstream account and transaction IDs", async () => {
    const adapter = provider(() => Promise.resolve(Response.json(accountSet)));

    const snapshot = await Effect.runPromise(
      adapter.readSnapshot({ connection, start: null })
    );

    expect({
      accountIds: new Set(
        snapshot.accounts.map((account) => account.providerAccountId)
      ).size,
      transactionIds: new Set(
        snapshot.posted.map((transaction) => transaction.providerTransactionId)
      ).size,
    }).toStrictEqual({ accountIds: 2, transactionIds: 2 });
  });

  it("fails closed when the account set reports authentication errors", async () => {
    const adapter = provider(() =>
      Promise.resolve(
        Response.json({
          ...accountSet,
          errlist: [
            {
              code: "con.auth",
              conn_id: "bank-a",
              msg: "credentials expired",
            },
          ],
        })
      )
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect(error._tag).toBe("AuthenticationError");
  });

  it("fails closed for incomplete account data", async () => {
    const adapter = provider(() =>
      Promise.resolve(
        Response.json({
          ...accountSet,
          errlist: [
            {
              account_id: "shared-account",
              code: "act.missingdata",
              msg: "transactions incomplete",
            },
          ],
        })
      )
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect(error._tag).toBe("ProviderUnavailableError");
  });

  it("maps HTTP authentication and rate-limit responses to typed errors", async () => {
    const unauthorized = provider(() =>
      Promise.resolve(new Response(null, { status: 403 }))
    );
    const authenticationError = await Effect.runPromise(
      Effect.flip(unauthorized.readSnapshot({ connection, start: null }))
    );

    const throttled = provider(() =>
      Promise.resolve(
        new Response(null, { headers: { "Retry-After": "30" }, status: 429 })
      )
    );
    const rateLimitError = await Effect.runPromise(
      Effect.flip(throttled.readSnapshot({ connection, start: null }))
    );

    expect({ authenticationError, rateLimitError }).toMatchObject({
      authenticationError: { _tag: "AuthenticationError" },
      rateLimitError: {
        _tag: "ProviderRateLimitError",
        retryAfterSeconds: 30,
      },
    });
  });

  it("parses HTTP-date Retry-After responses", async () => {
    const retryAt = new Date(Date.now() + 60_000).toUTCString();
    const throttled = provider(() =>
      Promise.resolve(
        new Response(null, { headers: { "Retry-After": retryAt }, status: 429 })
      )
    );

    const error = await Effect.runPromise(
      Effect.flip(throttled.readSnapshot({ connection, start: null }))
    );
    const retryAfterSeconds =
      error._tag === "ProviderRateLimitError" ? error.retryAfterSeconds : null;

    expect({
      parsed:
        retryAfterSeconds !== null &&
        retryAfterSeconds >= 0 &&
        retryAfterSeconds <= 60,
      tag: error._tag,
    }).toStrictEqual({ parsed: true, tag: "ProviderRateLimitError" });
  });

  it("rejects empty protocol identifiers without exposing rejected data", async () => {
    const adapter = provider(() =>
      Promise.resolve(
        Response.json({
          ...accountSet,
          accounts: [
            {
              ...accountSet.accounts[0],
              transactions: [
                {
                  ...accountSet.accounts[0].transactions[0],
                  description: "private rejected payload",
                  id: "",
                },
              ],
            },
          ],
        })
      )
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect(error).toMatchObject({
      _tag: "InvalidProviderResponseError",
      details: "Response did not match the SimpleFIN v2 schema",
    });
    const serializedError = JSON.stringify(error);
    expect(serializedError).not.toContain("private rejected payload");
    expect(serializedError).not.toContain("shared-account");
  });

  it("rejects duplicate connection identities", async () => {
    const adapter = provider(() =>
      Promise.resolve(
        Response.json({
          ...accountSet,
          connections: [...accountSet.connections, accountSet.connections[0]],
        })
      )
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect(error._tag).toBe("InvalidProviderResponseError");
  });

  it("rejects duplicate account identities", async () => {
    const adapter = provider(() =>
      Promise.resolve(
        Response.json({
          ...accountSet,
          accounts: [...accountSet.accounts, accountSet.accounts[0]],
        })
      )
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect(error._tag).toBe("InvalidProviderResponseError");
  });

  it("rejects duplicate transaction identities", async () => {
    const adapter = provider(() =>
      Promise.resolve(
        Response.json({
          ...accountSet,
          accounts: [
            {
              ...accountSet.accounts[0],
              transactions: [
                ...accountSet.accounts[0].transactions,
                accountSet.accounts[0].transactions[0],
              ],
            },
            accountSet.accounts[1],
          ],
        })
      )
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect(error._tag).toBe("InvalidProviderResponseError");
  });

  it("rejects malformed numeric strings", async () => {
    const adapter = provider(() =>
      Promise.resolve(
        Response.json({
          ...accountSet,
          accounts: [{ ...accountSet.accounts[0], balance: "0x10" }],
        })
      )
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect(error._tag).toBe("InvalidProviderResponseError");
  });

  it("rejects a zero balance-date while allowing pending posted zero", async () => {
    const adapter = provider(() =>
      Promise.resolve(
        Response.json({
          ...accountSet,
          accounts: [{ ...accountSet.accounts[0], "balance-date": 0 }],
        })
      )
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect(error._tag).toBe("InvalidProviderResponseError");
  });

  it("maps HTTP 401 responses to authentication errors", async () => {
    const adapter = provider(() =>
      Promise.resolve(new Response(null, { status: 401 }))
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect(error._tag).toBe("AuthenticationError");
  });

  it("rejects epoch values outside the JavaScript date range", async () => {
    const adapter = provider(() =>
      Promise.resolve(
        Response.json({
          ...accountSet,
          accounts: [
            {
              ...accountSet.accounts[0],
              "balance-date": Number.MAX_VALUE,
            },
          ],
        })
      )
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect(error).toMatchObject({
      _tag: "InvalidProviderResponseError",
      details: "Response did not match the SimpleFIN v2 schema",
    });
  });

  it("requires a configured connection-specific Access URL", async () => {
    const adapter = makeSimpleFinProvider({ accessUrls: new Map() });

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect(error._tag).toBe("AuthenticationError");
  });
});
