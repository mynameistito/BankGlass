import { Effect, Layer, Schema } from "effect";

import { BankStore } from "./bank-store";
import type {
  BankAccount,
  SyncStatus,
  TransactionQuery,
  TransactionRecord,
} from "./domain";
import {
  ApiRateLimitError,
  DatabaseError,
  NotFoundError,
  SyncInProgressError,
} from "./errors";

const dbEffect = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new DatabaseError({ cause, operation }),
    try: run,
  });
const accountSelect = `SELECT id, institution, name, type, status, currency, current_balance AS currentBalance,
available_balance AS availableBalance, formatted_account AS formattedAccount, holder_name AS holderName,
provider_balance_refreshed_at AS providerBalanceRefreshedAt, provider_transactions_refreshed_at AS providerTransactionsRefreshedAt,
data_updated_at AS dataUpdatedAt, synced_at AS syncedAt FROM accounts`;
const transactionSelect = `SELECT id, account_id AS accountId, status, transaction_at AS transactionAt, description, amount, currency,
type, balance, merchant_name AS merchantName, category_name AS categoryName, particulars, code, reference,
other_account AS otherAccount, card_suffix AS cardSuffix, provider_updated_at AS providerUpdatedAt,
data_updated_at AS dataUpdatedAt, synced_at AS syncedAt FROM transactions`;
const CursorSchema = Schema.Struct({ date: Schema.String, id: Schema.String });
const syncLeaseSeconds = 5 * 60;

export const makeD1BankStore = (db: D1Database) =>
  BankStore.of({
    acquireSync: (now) =>
      dbEffect("acquireSync", () =>
        db
          .prepare(
            "UPDATE sync_state SET status='syncing',started_at=?,last_attempt_at=?,error_code=NULL,error_message=NULL WHERE singleton=1 AND (status NOT IN ('syncing','refreshing') OR started_at IS NULL OR julianday(started_at) <= julianday(?) - ? / 86400.0)"
          )
          .bind(now, now, now, syncLeaseSeconds)
          .run()
      ).pipe(
        Effect.flatMap((result) =>
          result.meta.changes === 1
            ? Effect.void
            : Effect.fail(new SyncInProgressError({}))
        )
      ),
    completeSync: (now, refreshedAt) =>
      dbEffect("completeSync", async () => {
        await db
          .prepare(
            "UPDATE sync_state SET status='idle',started_at=NULL,last_success_at=?,provider_refreshed_at=?,error_code=NULL,error_message=NULL WHERE singleton=1"
          )
          .bind(now, refreshedAt)
          .run();
      }),
    consumeRateLimit: (bucket, now, limit) =>
      Effect.tryPromise({
        catch: (cause) =>
          cause instanceof ApiRateLimitError
            ? cause
            : new DatabaseError({ cause, operation: "consumeRateLimit" }),
        try: async () => {
          const expires = now + 60;
          await db
            .prepare(`INSERT INTO rate_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET
      count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END`)
            .bind(bucket, expires, now, now, expires)
            .run();
          const row = await db
            .prepare(
              "SELECT count,expires_at AS expiresAt FROM rate_limits WHERE bucket=?"
            )
            .bind(bucket)
            .first<{ count: number; expiresAt: number }>();
          if (row !== null && row.count > limit) {
            throw new ApiRateLimitError({
              retryAfterSeconds: Math.max(1, row.expiresAt - now),
            });
          }
        },
      }).pipe(Effect.asVoid),
    failSync: (now, code) =>
      dbEffect("failSync", async () => {
        await db
          .prepare(
            "UPDATE sync_state SET status='failed',started_at=NULL,last_attempt_at=?,error_code=?,error_message='Synchronization failed' WHERE singleton=1"
          )
          .bind(now, code)
          .run();
      }),
    getAccount: (id) =>
      dbEffect("getAccount", () =>
        db
          .prepare(`${accountSelect} WHERE id = ?`)
          .bind(id)
          .first<BankAccount>()
      ).pipe(
        Effect.flatMap((item) =>
          item === null
            ? Effect.fail(new NotFoundError({ resource: "account" }))
            : Effect.succeed(item)
        )
      ),
    getSyncStatus: dbEffect("getSyncStatus", async () => {
      const row = await db
        .prepare(`SELECT status, started_at AS startedAt, last_attempt_at AS lastAttemptAt, last_success_at AS lastSuccessAt,
      last_provider_refresh_requested_at AS lastProviderRefreshRequestedAt, provider_refreshed_at AS providerRefreshedAt,
      error_code AS errorCode, error_message AS errorMessage FROM sync_state WHERE singleton=1`)
        .first<SyncStatus>();
      if (row === null) {
        throw new TypeError("Missing sync state");
      }
      return row;
    }),
    listAccounts: dbEffect("listAccounts", async () => {
      const result = await db
        .prepare(`${accountSelect} ORDER BY name`)
        .all<BankAccount>();
      return result.results;
    }),
    listTransactions: (query: TransactionQuery) =>
      dbEffect("listTransactions", async () => {
        const clauses: string[] = [];
        const values: (string | number)[] = [];
        if (query.accountId !== null) {
          clauses.push("account_id = ?");
          values.push(query.accountId);
        }
        if (query.status !== null) {
          clauses.push("status = ?");
          values.push(query.status);
        }
        if (query.from !== null) {
          clauses.push("transaction_at >= ?");
          values.push(query.from);
        }
        if (query.to !== null) {
          clauses.push("transaction_at <= ?");
          values.push(query.to);
        }
        if (query.cursor !== null) {
          const decoded = Schema.decodeUnknownSync(CursorSchema)(
            JSON.parse(atob(query.cursor))
          );
          clauses.push(
            "(transaction_at < ? OR (transaction_at = ? AND id < ?))"
          );
          values.push(decoded.date, decoded.date, decoded.id);
        }
        const where =
          clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
        const result = await db
          .prepare(
            `${transactionSelect}${where} ORDER BY transaction_at DESC, id DESC LIMIT ?`
          )
          .bind(...values, query.limit + 1)
          .all<TransactionRecord>();
        const rows = result.results;
        const hasMore = rows.length > query.limit;
        const items = rows.slice(0, query.limit);
        const last = items.at(-1);
        const nextCursor =
          hasMore && last !== undefined
            ? btoa(
                JSON.stringify({ date: last["transactionAt"], id: last["id"] })
              )
            : null;
        return { items, nextCursor };
      }),
    markRefreshRequested: (now) =>
      dbEffect("markRefreshRequested", async () => {
        await db
          .prepare(
            "UPDATE sync_state SET status='refreshing',last_provider_refresh_requested_at=? WHERE singleton=1"
          )
          .bind(now)
          .run();
      }),
    saveSnapshot: ({
      accounts,
      posted,
      pending,
      reconcilePostedFrom,
      syncedAt,
    }) =>
      dbEffect("saveSnapshot", async () => {
        const statements: D1PreparedStatement[] = [];
        for (const a of accounts) {
          statements.push(
            db
              .prepare(`INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      institution=excluded.institution,name=excluded.name,type=excluded.type,status=excluded.status,currency=excluded.currency,
      current_balance=excluded.current_balance,available_balance=excluded.available_balance,formatted_account=excluded.formatted_account,
      holder_name=excluded.holder_name,provider_balance_refreshed_at=excluded.provider_balance_refreshed_at,
      provider_transactions_refreshed_at=excluded.provider_transactions_refreshed_at,data_updated_at=excluded.data_updated_at,synced_at=excluded.synced_at`)
              .bind(
                a.id,
                a.providerId,
                a.institution,
                a.name,
                a.type,
                a.status,
                a.currency,
                a.currentBalance,
                a.availableBalance,
                a.formattedAccount,
                a.holderName,
                a.providerBalanceRefreshedAt,
                a.providerTransactionsRefreshedAt,
                a.dataUpdatedAt,
                syncedAt
              )
          );
        }
        statements.push(
          db
            .prepare(
              "DELETE FROM transactions WHERE status = 'posted' AND transaction_at > ?"
            )
            .bind(reconcilePostedFrom)
        );
        const upsert = `INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      transaction_at=excluded.transaction_at,description=excluded.description,amount=excluded.amount,type=excluded.type,balance=excluded.balance,
      merchant_name=excluded.merchant_name,category_name=excluded.category_name,particulars=excluded.particulars,code=excluded.code,
      reference=excluded.reference,other_account=excluded.other_account,card_suffix=excluded.card_suffix,provider_updated_at=excluded.provider_updated_at,
      data_updated_at=excluded.data_updated_at,synced_at=excluded.synced_at,status=excluded.status`;
        for (const t of posted) {
          statements.push(
            db
              .prepare(upsert)
              .bind(
                t.id,
                t.providerId,
                t.accountId,
                t.status,
                t.transactionAt,
                t.description,
                t.amount,
                t.currency,
                t.type,
                t.balance,
                t.merchantName,
                t.categoryName,
                t.particulars,
                t.code,
                t.reference,
                t.otherAccount,
                t.cardSuffix,
                t.providerCreatedAt,
                t.providerUpdatedAt,
                t.dataUpdatedAt,
                syncedAt
              )
          );
        }
        statements.push(
          db.prepare("DELETE FROM transactions WHERE status = 'pending'")
        );
        for (const t of pending) {
          statements.push(
            db
              .prepare(upsert)
              .bind(
                t.id,
                t.providerId,
                t.accountId,
                t.status,
                t.transactionAt,
                t.description,
                t.amount,
                t.currency,
                t.type,
                null,
                null,
                null,
                t.particulars,
                t.code,
                t.reference,
                t.otherAccount,
                t.cardSuffix,
                null,
                t.providerUpdatedAt,
                t.dataUpdatedAt,
                syncedAt
              )
          );
        }
        if (statements.length > 0) {
          await db.batch(statements);
        }
      }),
  });

export const d1BankStoreLive = (db: D1Database) =>
  Layer.succeed(BankStore, makeD1BankStore(db));
