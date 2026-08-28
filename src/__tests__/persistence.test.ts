import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { BankStore } from "../bank-store";
import { doBankStoreLive, isStoreStub } from "../bank-store-do";
import { makeD1BankStore } from "../d1-bank-store";
import type {
  BankAccount,
  PendingTransaction,
  PostedTransaction,
} from "../domain";

const time = "2026-08-26T00:00:00.000Z";
const leaseId = "lease-test";
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
        "UPDATE sync_state SET status='idle',started_at=NULL,lease_id=NULL,last_provider_refresh_requested_at=NULL"
      ),
    ]);
  });

  it("upserts duplicate posted transactions idempotently", async () => {
    await Effect.runPromise(store.acquireSync(time, leaseId, null));
    const snapshot = {
      accounts: [account],
      leaseId,
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
    await Effect.runPromise(store.acquireSync(time, leaseId, null));
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account],
        leaseId,
        pending: [pending],
        posted: [],
        reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
        syncedAt: time,
      })
    );
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account],
        leaseId,
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
    await Effect.runPromise(store.acquireSync(time, leaseId, null));
    const second = {
      ...posted,
      id: "transaction_u",
      providerId: "u",
      transactionAt: "2026-08-25T00:00:00.000Z",
    };
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account],
        leaseId,
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

  it("removes expired request rate-limit buckets", async () => {
    await Effect.runPromise(store.consumeRateLimit("old", 100, 10));
    await Effect.runPromise(store.consumeRateLimit("current", 160, 10));

    const result = await env.DB.prepare(
      "SELECT bucket FROM rate_limits ORDER BY bucket"
    ).all<{ bucket: string }>();

    expect(result.results).toStrictEqual([{ bucket: "current" }]);
  });

  it("returns the provider ID with stored accounts", async () => {
    await Effect.runPromise(store.acquireSync(time, leaseId, null));
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account],
        leaseId,
        pending: [],
        posted: [],
        reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
        syncedAt: time,
      })
    );

    const result = await Effect.runPromise(store.getAccount(account.id));

    expect(result.providerId).toBe(account.providerId);
  });

  it("maps malformed account rows to a database error", async () => {
    await Effect.runPromise(store.acquireSync(time, leaseId, null));
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account],
        leaseId,
        pending: [],
        posted: [],
        reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
        syncedAt: time,
      })
    );
    await env.DB.prepare("UPDATE accounts SET current_balance=? WHERE id=?")
      .bind("not-a-number", account.id)
      .run();

    const error = await Effect.runPromise(
      Effect.flip(store.getAccount(account.id))
    );

    expect(error._tag).toBe("DatabaseError");
  });

  it("maps malformed transaction rows to a database error", async () => {
    await Effect.runPromise(store.acquireSync(time, leaseId, null));
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account],
        leaseId,
        pending: [],
        posted: [posted],
        reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
        syncedAt: time,
      })
    );
    await env.DB.prepare("UPDATE transactions SET amount=? WHERE id=?")
      .bind("not-a-number", posted.id)
      .run();

    const error = await Effect.runPromise(
      Effect.flip(
        store.listTransactions({
          accountId: null,
          cursor: null,
          from: null,
          limit: 10,
          status: null,
          to: null,
        })
      )
    );

    expect(error._tag).toBe("DatabaseError");
  });

  it("maps malformed sync-status rows to a database error", async () => {
    await env.DB.prepare(
      "UPDATE sync_state SET error_message=CAST(X'01' AS BLOB) WHERE singleton=1"
    ).run();

    const error = await Effect.runPromise(Effect.flip(store.getSyncStatus));

    expect(error._tag).toBe("DatabaseError");
  });

  it("recovers a stale synchronization lock", async () => {
    await env.DB.prepare("UPDATE sync_state SET status='syncing',started_at=?")
      .bind("2026-08-25T00:00:00.000Z")
      .run();

    await Effect.runPromise(store.acquireSync(time, leaseId, null));

    const status = await Effect.runPromise(store.getSyncStatus);
    expect(status.status).toBe("syncing");
    expect(status.startedAt).toBe(time);
  });

  it("atomically rejects a lease inside the provider refresh cooldown", async () => {
    await env.DB.prepare(
      "UPDATE sync_state SET last_provider_refresh_requested_at=?"
    )
      .bind(time)
      .run();

    const error = await Effect.runPromise(
      Effect.flip(
        store.acquireSync(
          "2026-08-26T00:30:00.000Z",
          "cooldown-lease",
          "2026-08-25T23:30:00.000Z"
        )
      )
    );

    const status = await Effect.runPromise(store.getSyncStatus);
    expect(error._tag).toBe("SyncInProgressError");
    expect(status.status).toBe("idle");
    expect(status.startedAt).toBeNull();
  });

  it("rejects an active synchronization lock", async () => {
    await env.DB.prepare("UPDATE sync_state SET status='syncing',started_at=?")
      .bind("2026-08-26T00:00:00.000Z")
      .run();

    const error = await Effect.runPromise(
      Effect.flip(
        store.acquireSync("2026-08-26T00:01:00.000Z", "second-lease", null)
      )
    );
    expect(error._tag).toBe("SyncInProgressError");
  });

  it("prevents a stale lease from writing or completing a newer sync", async () => {
    await Effect.runPromise(store.acquireSync(time, "stale-lease", null));
    await Effect.runPromise(
      store.acquireSync("2026-08-26T00:06:00.000Z", "current-lease", null)
    );

    const saveError = await Effect.runPromise(
      Effect.flip(
        store.saveSnapshot({
          accounts: [account],
          leaseId: "stale-lease",
          pending: [],
          posted: [],
          reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
          syncedAt: time,
        })
      )
    );
    const completeError = await Effect.runPromise(
      Effect.flip(store.completeSync(time, time, "stale-lease"))
    );

    const accounts = await Effect.runPromise(store.listAccounts);
    const status = await Effect.runPromise(store.getSyncStatus);
    expect(saveError._tag).toBe("SyncInProgressError");
    expect(completeError._tag).toBe("SyncInProgressError");
    expect(accounts).toStrictEqual([]);
    expect(status.status).toBe("syncing");
    expect(status.startedAt).toBe("2026-08-26T00:06:00.000Z");
  });
});

describe("Durable Object banking persistence", () => {
  it("preserves the prior snapshot when a write fails mid-snapshot", async () => {
    const store = await Effect.runPromise(
      BankStore.pipe(Effect.provide(doBankStoreLive(env.BANK_STORE)))
    );
    const doAccount = { ...account, id: "do_account_a", providerId: "do-a" };
    const doPosted = {
      ...posted,
      accountId: doAccount.id,
      id: "do_transaction_t",
      providerId: "do-t",
    };

    await Effect.runPromise(store.acquireSync(time, "do-lease", null));
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [doAccount],
        leaseId: "do-lease",
        pending: [],
        posted: [doPosted],
        reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
        syncedAt: time,
      })
    );

    const reply = await runInDurableObject(
      env.BANK_STORE.getByName("bankglass"),
      (instance) => {
        if (!isStoreStub(instance)) {
          throw new TypeError("BANK_STORE does not expose the command RPC");
        }
        return instance.command({
          args: [
            {
              accounts: [
                { ...doAccount, name: "Changed" },
                { ...doAccount, id: "do_account_conflict" },
              ],
              leaseId: "do-lease",
              pending: [],
              posted: [doPosted],
              reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
              syncedAt: "2026-08-27T00:00:00.000Z",
            },
          ],
          name: "saveSnapshot",
        });
      }
    );

    const savedAccount = await Effect.runPromise(
      store.getAccount(doAccount.id)
    );
    const savedTransactions = await Effect.runPromise(
      store.listTransactions({
        accountId: doAccount.id,
        cursor: null,
        from: null,
        limit: 100,
        status: null,
        to: null,
      })
    );
    expect(reply.ok).toBeFalsy();
    expect(savedAccount.name).toBe(doAccount.name);
    expect(savedTransactions.items.map((item) => item["id"])).toStrictEqual([
      doPosted.id,
    ]);
  });
});
