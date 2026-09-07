import { env } from "cloudflare:test";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { BankStore } from "@/bank-store";
import { doBankStoreLive, isStoreStub } from "@/bank-store-do";
import type { ProviderAccount } from "@/domain/account";
import type { BankConnection } from "@/domain/connection";
import {
  ConnectionIdSchema,
  ProviderAccountIdSchema,
  ProviderIdSchema,
  ProviderTransactionIdSchema,
} from "@/domain/identifiers";
import type { ProviderPostedTransaction } from "@/domain/transaction";

const time = "2026-08-26T00:00:00.000Z";
const later = "2026-08-26T00:01:00.000Z";
const akahuProviderId = Schema.decodeUnknownSync(ProviderIdSchema)("akahu");
const simplefinProviderId = Schema.decodeUnknownSync(ProviderIdSchema)("simplefin");
const akahuConnectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_akahu_default"
);
const simplefinConnectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_simplefin_test"
);
const sharedAccountId = Schema.decodeUnknownSync(ProviderAccountIdSchema)(
  "shared-account"
);
const sharedTransactionId = Schema.decodeUnknownSync(
  ProviderTransactionIdSchema
)("shared-transaction");

const account = (providerAccountId = sharedAccountId): ProviderAccount => ({
  availableBalance: 8,
  currency: "NZD",
  currentBalance: 10,
  dataUpdatedAt: time,
  formattedAccount: null,
  holderName: null,
  institution: "Test Bank",
  name: "Main",
  providerAccountId,
  providerBalanceRefreshedAt: time,
  providerTransactionsRefreshedAt: time,
  status: "active",
  type: "checking",
});

const posted = (
  providerTransactionId = sharedTransactionId
): ProviderPostedTransaction => ({
  amount: -5,
  balance: 10,
  cardSuffix: null,
  categoryName: null,
  code: null,
  currency: "NZD",
  dataUpdatedAt: time,
  description: "Coffee",
  merchantName: null,
  otherAccount: null,
  particulars: null,
  providerAccountId: sharedAccountId,
  providerCreatedAt: time,
  providerTransactionId,
  providerUpdatedAt: time,
  reference: null,
  status: "posted",
  transactionAt: time,
  type: "EFTPOS",
});

const pending = (providerTransactionId: string) => ({
  amount: -3,
  cardSuffix: null,
  code: null,
  currency: "NZD",
  dataUpdatedAt: time,
  description: "Pending coffee",
  otherAccount: null,
  particulars: null,
  providerAccountId: sharedAccountId,
  providerTransactionId: Schema.decodeUnknownSync(ProviderTransactionIdSchema)(
    providerTransactionId
  ),
  providerUpdatedAt: time,
  reference: null,
  status: "pending" as const,
  transactionAt: time,
  type: "EFTPOS",
});

const simplefinConnection: BankConnection = {
  authorization: { _tag: "Connected" },
  createdAt: time,
  enabled: true,
  id: simplefinConnectionId,
  label: "SimpleFIN test",
  lastSyncAt: null,
  metadata: {},
  providerId: simplefinProviderId,
  updatedAt: time,
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

const transactionQuery = (status: "posted" | "pending" | null = null) => ({
  accountId: null,
  connectionId: null,
  cursor: null,
  from: null,
  limit: 100,
  providerId: null,
  status,
  to: null,
});

describe("Durable Object banking persistence", () => {
  beforeEach(resetStore);

  it("keeps local IDs stable when a provider snapshot is replayed", async () => {
    const store = await getStore();
    await Effect.runPromise(
      store.acquireSync(akahuConnectionId, time, "lease", null)
    );
    const snapshot = {
      accounts: [account()],
      connectionId: akahuConnectionId,
      leaseId: "lease",
      pending: [],
      posted: [posted()],
      providerId: akahuProviderId,
      reconcilePostedFrom: time,
      syncedAt: time,
    };

    await Effect.runPromise(store.saveSnapshot(snapshot));
    const firstAccounts = await Effect.runPromise(
      store.listAccounts({ connectionId: null, providerId: null })
    );
    const firstTransactions = await Effect.runPromise(
      store.listTransactions(transactionQuery("posted"))
    );
    await Effect.runPromise(store.saveSnapshot(snapshot));
    const secondAccounts = await Effect.runPromise(
      store.listAccounts({ connectionId: null, providerId: null })
    );
    const secondTransactions = await Effect.runPromise(
      store.listTransactions(transactionQuery("posted"))
    );

    expect(secondAccounts[0]?.id).toBe(firstAccounts[0]?.id);
    expect(secondTransactions.items[0]?.id).toBe(firstTransactions.items[0]?.id);
  });

  it("allows identical upstream IDs in different provider connections", async () => {
    const store = await getStore();
    await Effect.runPromise(store.saveConnection(simplefinConnection));
    await Effect.runPromise(
      Effect.all([
        store.acquireSync(akahuConnectionId, time, "akahu-lease", null),
        store.acquireSync(simplefinConnectionId, time, "simplefin-lease", null),
      ])
    );

    await Effect.runPromise(
      Effect.all([
        store.saveSnapshot({
          accounts: [account()],
          connectionId: akahuConnectionId,
          leaseId: "akahu-lease",
          pending: [],
          posted: [posted()],
          providerId: akahuProviderId,
          reconcilePostedFrom: time,
          syncedAt: time,
        }),
        store.saveSnapshot({
          accounts: [account()],
          connectionId: simplefinConnectionId,
          leaseId: "simplefin-lease",
          pending: [],
          posted: [posted()],
          providerId: simplefinProviderId,
          reconcilePostedFrom: time,
          syncedAt: time,
        }),
      ])
    );

    const accounts = await Effect.runPromise(
      store.listAccounts({ connectionId: null, providerId: null })
    );
    const transactions = await Effect.runPromise(
      store.listTransactions(transactionQuery("posted"))
    );
    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map((item) => item.id)).size).toBe(2);
    expect(transactions.items).toHaveLength(2);
    expect(new Set(transactions.items.map((item) => item.id)).size).toBe(2);
  });

  it("reconciles posted and pending rows only inside the synchronized connection", async () => {
    const store = await getStore();
    await Effect.runPromise(store.saveConnection(simplefinConnection));
    await Effect.runPromise(
      Effect.all([
        store.acquireSync(akahuConnectionId, time, "akahu-1", null),
        store.acquireSync(simplefinConnectionId, time, "simplefin-1", null),
      ])
    );
    await Effect.runPromise(
      Effect.all([
        store.saveSnapshot({
          accounts: [account()],
          connectionId: akahuConnectionId,
          leaseId: "akahu-1",
          pending: [pending("pending-a")],
          posted: [posted()],
          providerId: akahuProviderId,
          reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
          syncedAt: time,
        }),
        store.saveSnapshot({
          accounts: [account()],
          connectionId: simplefinConnectionId,
          leaseId: "simplefin-1",
          pending: [pending("pending-b")],
          posted: [posted()],
          providerId: simplefinProviderId,
          reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
          syncedAt: time,
        }),
      ])
    );
    await Effect.runPromise(
      store.completeSync(akahuConnectionId, time, time, "akahu-1")
    );
    await Effect.runPromise(
      store.acquireSync(akahuConnectionId, later, "akahu-2", null)
    );
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account()],
        connectionId: akahuConnectionId,
        leaseId: "akahu-2",
        pending: [],
        posted: [],
        providerId: akahuProviderId,
        reconcilePostedFrom: "2026-08-25T00:00:00.000Z",
        syncedAt: later,
      })
    );

    const remaining = await Effect.runPromise(
      store.listTransactions(transactionQuery())
    );
    expect(remaining.items).toHaveLength(2);
    expect(
      remaining.items.every(
        (item) => item.connectionId === simplefinConnectionId
      )
    ).toBeTruthy();
  });

  it("uses independent synchronization leases per connection", async () => {
    const store = await getStore();
    await Effect.runPromise(store.saveConnection(simplefinConnection));
    await Effect.runPromise(
      store.acquireSync(akahuConnectionId, time, "akahu-lease", null)
    );
    await expect(
      Effect.runPromise(
        store.acquireSync(simplefinConnectionId, time, "simplefin-lease", null)
      )
    ).resolves.toBeUndefined();
    const error = await Effect.runPromise(
      Effect.flip(
        store.acquireSync(akahuConnectionId, time, "second-akahu", null)
      )
    );
    expect(error._tag).toBe("SyncInProgressError");
  });

  it("records one connection failure without corrupting another sync state", async () => {
    const store = await getStore();
    await Effect.runPromise(store.saveConnection(simplefinConnection));
    await Effect.runPromise(
      Effect.all([
        store.acquireSync(akahuConnectionId, time, "akahu-lease", null),
        store.acquireSync(simplefinConnectionId, time, "simplefin-lease", null),
      ])
    );
    await Effect.runPromise(
      store.failSync(
        akahuConnectionId,
        later,
        "ProviderUnavailableError",
        "akahu-lease"
      )
    );

    const akahu = await Effect.runPromise(
      store.getSyncStatus(akahuConnectionId)
    );
    const simplefin = await Effect.runPromise(
      store.getSyncStatus(simplefinConnectionId)
    );
    expect(akahu.status).toBe("failed");
    expect(simplefin.status).toBe("syncing");
    expect(simplefin.errorCode).toBeNull();
  });

  it("enforces request rate limits", async () => {
    const store = await getStore();
    await Effect.runPromise(store.consumeRateLimit("test", 100, 1));
    const error = await Effect.runPromise(
      Effect.flip(store.consumeRateLimit("test", 100, 1))
    );
    expect(error._tag).toBe("ApiRateLimitError");
  });
});
