import { env } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { BankStore } from "../bank-store";
import { doBankStoreLive, isStoreStub } from "../bank-store-do";
import type { BankAccount, PostedTransaction } from "../domain";

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

const getStore = () =>
  Effect.runPromise(
    BankStore.pipe(Effect.provide(doBankStoreLive(env.BANK_STORE)))
  );
const resetStore = async () => {
  const stub = env.BANK_STORE.getByName("bankglass");
  if (!isStoreStub(stub)) {
    throw new TypeError("BANK_STORE does not expose the command RPC");
  }
  await stub.command({ args: [], name: "reset" });
};

describe("Durable Object banking persistence", () => {
  beforeEach(async () => {
    await resetStore();
  });

  it("upserts duplicate posted transactions idempotently", async () => {
    const store = await getStore();
    await Effect.runPromise(store.acquireSync(time, "lease", null));
    const snapshot = {
      accounts: [account],
      leaseId: "lease",
      pending: [],
      posted: [posted],
      reconcilePostedFrom: time,
      syncedAt: time,
    };

    await Effect.runPromise(store.saveSnapshot(snapshot));
    await Effect.runPromise(store.saveSnapshot(snapshot));

    const page = await Effect.runPromise(
      store.listTransactions({
        accountId: account.id,
        cursor: null,
        from: null,
        limit: 100,
        status: "posted",
        to: null,
      })
    );
    expect(page.items).toHaveLength(1);
  });

  it("returns stored accounts and paginates transactions", async () => {
    const store = await getStore();
    await Effect.runPromise(store.acquireSync(time, "lease", null));
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account],
        leaseId: "lease",
        pending: [],
        posted: [posted, { ...posted, id: "transaction_u", providerId: "u" }],
        reconcilePostedFrom: time,
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
    const second = await Effect.runPromise(
      store.listTransactions({
        accountId: null,
        cursor: first.nextCursor,
        from: null,
        limit: 1,
        status: "posted",
        to: null,
      })
    );

    await expect(
      Effect.runPromise(store.getAccount(account.id))
    ).resolves.toStrictEqual(account);
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
  });

  it("enforces request rate limits", async () => {
    const store = await getStore();
    await Effect.runPromise(store.consumeRateLimit("test", 100, 1));
    const error = await Effect.runPromise(
      Effect.flip(store.consumeRateLimit("test", 100, 1))
    );
    expect(error._tag).toBe("ApiRateLimitError");
  });

  it("rejects stale synchronization leases", async () => {
    const store = await getStore();
    await Effect.runPromise(store.acquireSync(time, "first", null));
    const error = await Effect.runPromise(
      Effect.flip(store.acquireSync(time, "second", null))
    );
    expect(error._tag).toBe("SyncInProgressError");
  });

  it("preserves lease conflicts when saving a snapshot", async () => {
    const store = await getStore();
    await Effect.runPromise(store.acquireSync(time, "first", null));

    const error = await Effect.runPromise(
      Effect.flip(
        store.saveSnapshot({
          accounts: [account],
          leaseId: "second",
          pending: [],
          posted: [],
          reconcilePostedFrom: time,
          syncedAt: time,
        })
      )
    );

    expect(error._tag).toBe("SyncInProgressError");
  });
});
