import { env } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { makeD1BankStore } from "../d1-bank-store";
import type {
  BankAccount,
  PendingTransaction,
  PostedTransaction,
} from "../domain";

const time = "2026-08-26T00:00:00.000Z";
const account: BankAccount = {
  availableBalance: 8,
  currency: "NZD",
  currentBalance: 10,
  dataUpdatedAt: time,
  formattedAccount: null,
  holderName: null,
  id: "account_a",
  institution: "BNZ",
  name: "Main",
  providerBalanceRefreshedAt: time,
  providerId: "a",
  providerTransactionsRefreshedAt: time,
  status: "active",
  syncedAt: time,
  type: "checking",
};
const posted: PostedTransaction = {
  accountId: account.id,
  amount: -5,
  balance: 10,
  cardSuffix: null,
  categoryName: null,
  code: null,
  currency: "NZD",
  dataUpdatedAt: time,
  description: "Coffee",
  id: "transaction_t",
  merchantName: null,
  otherAccount: null,
  particulars: null,
  providerCreatedAt: time,
  providerId: "t",
  providerUpdatedAt: time,
  reference: null,
  status: "posted",
  syncedAt: time,
  transactionAt: time,
  type: "EFTPOS",
};
const pending: PendingTransaction = {
  accountId: account.id,
  amount: -5,
  cardSuffix: null,
  code: null,
  currency: "NZD",
  dataUpdatedAt: time,
  description: "Coffee",
  id: "pending_p",
  otherAccount: null,
  particulars: null,
  providerId: "pending_p",
  providerUpdatedAt: time,
  reference: null,
  status: "pending",
  syncedAt: time,
  transactionAt: time,
  type: "EFTPOS",
};

describe("D1 banking persistence", () => {
  const store = makeD1BankStore(env.DB);
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM transactions"),
      env.DB.prepare("DELETE FROM accounts"),
      env.DB.prepare("DELETE FROM rate_limits"),
      env.DB.prepare(
        "UPDATE sync_state SET status='idle',last_provider_refresh_requested_at=NULL"
      ),
    ]);
  });

  it("upserts duplicate posted transactions idempotently", async () => {
    const snapshot = {
      accounts: [account],
      pending: [],
      posted: [posted],
      reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
      syncedAt: time,
    };
    await Effect.runPromise(store.saveSnapshot(snapshot));
    await Effect.runPromise(store.saveSnapshot(snapshot));
    const result = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM transactions"
    ).first<{ count: number }>();
    expect(result?.count).toBe(1);
  });

  it("rebuilds pending data when a transaction settles", async () => {
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account],
        pending: [pending],
        posted: [],
        reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
        syncedAt: time,
      })
    );
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account],
        pending: [],
        posted: [posted],
        reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
        syncedAt: time,
      })
    );
    const rows = await env.DB.prepare("SELECT status FROM transactions").all<{
      status: string;
    }>();
    expect(rows.results).toStrictEqual([{ status: "posted" }]);
  });

  it("uses stable cursor pagination without overlap", async () => {
    const second = {
      ...posted,
      id: "transaction_u",
      providerId: "u",
      transactionAt: "2026-08-25T00:00:00.000Z",
    };
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account],
        pending: [],
        posted: [posted, second],
        reconcilePostedFrom: "2026-08-24T00:00:00.000Z",
        syncedAt: time,
      })
    );
    const first = await Effect.runPromise(
      store.listTransactions({
        accountId: null,
        cursor: null,
        from: null,
        limit: 1,
        status: "posted",
        to: null,
      })
    );
    const next = await Effect.runPromise(
      store.listTransactions({
        accountId: null,
        cursor: first.nextCursor,
        from: null,
        limit: 1,
        status: "posted",
        to: null,
      })
    );
    expect(first.items[0]?.["id"]).not.toBe(next.items[0]?.["id"]);
  });

  it("enforces the request rate limit", async () => {
    await Effect.runPromise(store.consumeRateLimit("test", 100, 1));
    const error = await Effect.runPromise(
      Effect.flip(store.consumeRateLimit("test", 100, 1))
    );
    expect(error._tag).toBe("ApiRateLimitError");
  });
});
