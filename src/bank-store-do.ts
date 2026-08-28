import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";

import { BankStore } from "./bank-store";
import type {
  BankAccount,
  SyncStatus,
  TransactionPage,
  TransactionRecord,
} from "./domain";
import {
  BankAccountSchema,
  PendingTransactionSchema,
  PostedTransactionSchema,
} from "./domain";
import {
  ApiRateLimitError,
  DatabaseError,
  NotFoundError,
  SyncInProgressError,
} from "./errors";

type Reply =
  | { readonly ok: true; readonly value?: unknown }
  | {
      readonly ok: false;
      readonly error: string;
      readonly retryAfterSeconds?: number;
    };
const schema = `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL UNIQUE, institution TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, currency TEXT, current_balance REAL, available_balance REAL, formatted_account TEXT, holder_name TEXT, provider_balance_refreshed_at TEXT, provider_transactions_refreshed_at TEXT, data_updated_at TEXT NOT NULL, synced_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, status TEXT NOT NULL, transaction_at TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL, type TEXT NOT NULL, balance REAL, merchant_name TEXT, category_name TEXT, particulars TEXT, code TEXT, reference TEXT, other_account TEXT, card_suffix TEXT, provider_created_at TEXT, provider_updated_at TEXT NOT NULL, data_updated_at TEXT NOT NULL, synced_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS transactions_account_date ON transactions(account_id, transaction_at DESC, id DESC); CREATE INDEX IF NOT EXISTS transactions_date ON transactions(transaction_at DESC, id DESC); CREATE TABLE IF NOT EXISTS sync_state (singleton INTEGER PRIMARY KEY, status TEXT NOT NULL, started_at TEXT, last_attempt_at TEXT, last_success_at TEXT, last_provider_refresh_requested_at TEXT, provider_refreshed_at TEXT, error_code TEXT, error_message TEXT, lease_id TEXT); INSERT OR IGNORE INTO sync_state(singleton,status) VALUES (1,'idle'); CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);`;
interface RpcCommand {
  readonly args: readonly unknown[];
  readonly name: string;
}
const CommandSchema = Schema.Struct({
  args: Schema.Array(Schema.Unknown),
  name: Schema.String,
});
const CursorSchema = Schema.Struct({ date: Schema.String, id: Schema.String });
const QuerySchema = Schema.Struct({
  accountId: Schema.NullOr(Schema.String),
  cursor: Schema.NullOr(Schema.String),
  from: Schema.NullOr(Schema.String),
  limit: Schema.Number,
  status: Schema.NullOr(Schema.Literals(["posted", "pending"])),
  to: Schema.NullOr(Schema.String),
});
const SnapshotSchema = Schema.Struct({
  accounts: Schema.Array(BankAccountSchema),
  leaseId: Schema.String,
  pending: Schema.Array(PendingTransactionSchema),
  posted: Schema.Array(PostedTransactionSchema),
  reconcilePostedFrom: Schema.String,
  syncedAt: Schema.String,
});
const AccountSchema = Schema.Struct({
  availableBalance: Schema.NullOr(Schema.Number),
  currency: Schema.NullOr(Schema.String),
  currentBalance: Schema.NullOr(Schema.Number),
  dataUpdatedAt: Schema.String,
  formattedAccount: Schema.NullOr(Schema.String),
  holderName: Schema.NullOr(Schema.String),
  id: Schema.String,
  institution: Schema.String,
  name: Schema.String,
  providerBalanceRefreshedAt: Schema.NullOr(Schema.String),
  providerId: Schema.String,
  providerTransactionsRefreshedAt: Schema.NullOr(Schema.String),
  status: Schema.Literals(["active", "inactive"]),
  syncedAt: Schema.String,
  type: Schema.String,
});
const SyncSchema = Schema.Struct({
  errorCode: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  lastAttemptAt: Schema.NullOr(Schema.String),
  lastProviderRefreshRequestedAt: Schema.NullOr(Schema.String),
  lastSuccessAt: Schema.NullOr(Schema.String),
  providerRefreshedAt: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  status: Schema.String,
});
const syncLeaseSeconds = 5 * 60;
const accountSelect =
  "SELECT id, provider_id AS providerId, institution, name, type, status, currency, current_balance AS currentBalance, available_balance AS availableBalance, formatted_account AS formattedAccount, holder_name AS holderName, provider_balance_refreshed_at AS providerBalanceRefreshedAt, provider_transactions_refreshed_at AS providerTransactionsRefreshedAt, data_updated_at AS dataUpdatedAt, synced_at AS syncedAt FROM accounts";
const transactionSelect =
  "SELECT id, account_id AS accountId, status, transaction_at AS transactionAt, description, amount, currency, type, balance, merchant_name AS merchantName, category_name AS categoryName, particulars, code, reference, other_account AS otherAccount, card_suffix AS cardSuffix, provider_created_at AS providerCreatedAt, provider_updated_at AS providerUpdatedAt, data_updated_at AS dataUpdatedAt, synced_at AS syncedAt FROM transactions";
const TransactionPageSchema = Schema.declare<TransactionPage>(
  (_value): _value is TransactionPage => true
);
interface TransactionRow extends TransactionRecord {
  readonly [key: string]: string | number | null;
}
type SqlStorage = DurableObjectState["storage"]["sql"];
type CommandHandler = (sql: SqlStorage, args: readonly unknown[]) => Reply;
const rowAccount = (row: typeof AccountSchema.Type): BankAccount => row;
const rowSync = (row: typeof SyncSchema.Type): SyncStatus => row;
const reset: CommandHandler = (sql) => {
  sql.exec("DELETE FROM transactions");
  sql.exec("DELETE FROM accounts");
  sql.exec("DELETE FROM rate_limits");
  sql.exec(
    "UPDATE sync_state SET status='idle',started_at=NULL,lease_id=NULL,last_provider_refresh_requested_at=NULL"
  );
  return { ok: true };
};
const updateSync = (
  sql: SqlStorage,
  args: readonly unknown[],
  query: string
): Reply => {
  const a = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(args);
  const result = sql.exec(query, ...a);
  return result.rowsWritten === 1 ? { ok: true } : { error: "sync", ok: false };
};
const acquireSync: CommandHandler = (sql, args) =>
  (() => {
    const [now, leaseId, providerRefreshAllowedBefore] =
      Schema.decodeUnknownSync(
        Schema.Tuple([
          Schema.String,
          Schema.String,
          Schema.NullOr(Schema.String),
        ])
      )(args);
    const result = sql.exec(
      "UPDATE sync_state SET status='syncing',started_at=?,last_attempt_at=?,lease_id=?,error_code=NULL,error_message=NULL WHERE singleton=1 AND (status NOT IN ('syncing','refreshing') OR started_at IS NULL OR julianday(started_at) <= julianday(?) - ? / 86400.0) AND (? IS NULL OR last_provider_refresh_requested_at IS NULL OR julianday(last_provider_refresh_requested_at) <= julianday(?))",
      now,
      now,
      leaseId,
      now,
      syncLeaseSeconds,
      providerRefreshAllowedBefore,
      providerRefreshAllowedBefore
    );
    return result.rowsWritten === 1
      ? { ok: true }
      : { error: "sync", ok: false };
  })();
const completeSync: CommandHandler = (sql, args) =>
  updateSync(
    sql,
    args,
    "UPDATE sync_state SET status='idle',started_at=NULL,lease_id=NULL,last_success_at=?,provider_refreshed_at=?,error_code=NULL,error_message=NULL WHERE singleton=1 AND lease_id=?"
  );
const markRefreshRequested: CommandHandler = (sql, args) =>
  updateSync(
    sql,
    args,
    "UPDATE sync_state SET status='refreshing',last_provider_refresh_requested_at=? WHERE singleton=1 AND lease_id=?"
  );
const failSync: CommandHandler = (sql, args) => {
  sql.exec(
    "UPDATE sync_state SET status='failed',started_at=NULL,lease_id=NULL,last_attempt_at=?,error_code=?,error_message='Synchronization failed' WHERE singleton=1 AND lease_id=?",
    ...args
  );
  return { ok: true };
};
const getSyncStatus: CommandHandler = (sql) => ({
  ok: true,
  value: rowSync(
    sql
      .exec<typeof SyncSchema.Type>(
        "SELECT status, started_at AS startedAt, last_attempt_at AS lastAttemptAt, last_success_at AS lastSuccessAt, last_provider_refresh_requested_at AS lastProviderRefreshRequestedAt, provider_refreshed_at AS providerRefreshedAt, error_code AS errorCode, error_message AS errorMessage FROM sync_state WHERE singleton=1"
      )
      .one()
  ),
});
const listAccounts: CommandHandler = (sql) => ({
  ok: true,
  value: sql
    .exec<typeof AccountSchema.Type>(`${accountSelect} ORDER BY name`)
    .toArray()
    .map(rowAccount),
});
const getAccount: CommandHandler = (sql, args) => {
  const [id] = Schema.decodeUnknownSync(Schema.Tuple([Schema.String]))(args);
  const [row] = sql
    .exec<typeof AccountSchema.Type>(`${accountSelect} WHERE id=?`, id)
    .toArray();
  return row
    ? { ok: true, value: rowAccount(row) }
    : { error: "not-found", ok: false };
};
const listTransactions: CommandHandler = (sql, args) => {
  const [q] = Schema.decodeUnknownSync(Schema.Tuple([QuerySchema]))(args);
  const where: string[] = [];
  const values: unknown[] = [];
  for (const [key, clause] of [
    [q.accountId, "account_id=?"],
    [q.status, "status=?"],
    [q.from, "transaction_at>=?"],
    [q.to, "transaction_at<=?"],
  ] as const) {
    if (key !== null) {
      where.push(clause);
      values.push(key);
    }
  }
  if (q.cursor !== null) {
    const cursor = Schema.decodeUnknownSync(CursorSchema)(
      JSON.parse(atob(q.cursor))
    );
    where.push("(transaction_at<? OR (transaction_at=? AND id<?))");
    values.push(cursor.date, cursor.date, cursor.id);
  }
  const rows = sql
    .exec<TransactionRow>(
      `${
        transactionSelect +
        (where.length ? " WHERE " + where.join(" AND ") : "")
      } ORDER BY transaction_at DESC,id DESC LIMIT ?`,
      ...values,
      q.limit + 1
    )
    .toArray();
  const items = rows.slice(0, q.limit);
  const last = items.at(-1);
  return {
    ok: true,
    value: {
      items,
      nextCursor:
        rows.length > q.limit && last
          ? btoa(JSON.stringify({ date: last.transactionAt, id: last.id }))
          : null,
    },
  };
};
const consumeRateLimit: CommandHandler = (sql, args) => {
  const [bucket, now, limit] = Schema.decodeUnknownSync(
    Schema.Tuple([Schema.String, Schema.Number, Schema.Number])
  )(args);
  sql.exec("DELETE FROM rate_limits WHERE expires_at<=?", now);
  const expires = now + 60;
  sql.exec(
    "INSERT INTO rate_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1",
    bucket,
    expires
  );
  const row = sql
    .exec<{ count: number; expiresAt: number }>(
      "SELECT count,expires_at AS expiresAt FROM rate_limits WHERE bucket=?",
      bucket
    )
    .one();
  return row.count > limit
    ? {
        error: "rate",
        ok: false,
        retryAfterSeconds: Math.max(1, row.expiresAt - now),
      }
    : { ok: true };
};
const saveSnapshot: CommandHandler = (sql, args) => {
  const [snapshot] = Schema.decodeUnknownSync(Schema.Tuple([SnapshotSchema]))(
    args
  );
  if (
    sql
      .exec(
        "SELECT 1 FROM sync_state WHERE singleton=1 AND lease_id=?",
        snapshot.leaseId
      )
      .toArray().length !== 1
  ) {
    return { error: "sync", ok: false };
  }
  for (const account of snapshot.accounts) {
    sql.exec(
      "INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET institution=excluded.institution,name=excluded.name,type=excluded.type,status=excluded.status,currency=excluded.currency,current_balance=excluded.current_balance,available_balance=excluded.available_balance,formatted_account=excluded.formatted_account,holder_name=excluded.holder_name,provider_balance_refreshed_at=excluded.provider_balance_refreshed_at,provider_transactions_refreshed_at=excluded.provider_transactions_refreshed_at,data_updated_at=excluded.data_updated_at,synced_at=excluded.synced_at",
      account.id,
      account.providerId,
      account.institution,
      account.name,
      account.type,
      account.status,
      account.currency,
      account.currentBalance,
      account.availableBalance,
      account.formattedAccount,
      account.holderName,
      account.providerBalanceRefreshedAt,
      account.providerTransactionsRefreshedAt,
      account.dataUpdatedAt,
      snapshot.syncedAt
    );
  }
  sql.exec(
    "DELETE FROM transactions WHERE status='posted' AND transaction_at>? AND EXISTS (SELECT 1 FROM sync_state WHERE singleton=1 AND lease_id=?)",
    snapshot.reconcilePostedFrom,
    snapshot.leaseId
  );
  const transactionSql =
    "INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET transaction_at=excluded.transaction_at,description=excluded.description,amount=excluded.amount,type=excluded.type,balance=excluded.balance,merchant_name=excluded.merchant_name,category_name=excluded.category_name,particulars=excluded.particulars,code=excluded.code,reference=excluded.reference,other_account=excluded.other_account,card_suffix=excluded.card_suffix,provider_created_at=excluded.provider_created_at,provider_updated_at=excluded.provider_updated_at,data_updated_at=excluded.data_updated_at,synced_at=excluded.synced_at,status=excluded.status";
  for (const transaction of snapshot.posted) {
    sql.exec(
      transactionSql,
      transaction.id,
      transaction.providerId,
      transaction.accountId,
      transaction.status,
      transaction.transactionAt,
      transaction.description,
      transaction.amount,
      transaction.currency,
      transaction.type,
      transaction.balance,
      transaction.merchantName,
      transaction.categoryName,
      transaction.particulars,
      transaction.code,
      transaction.reference,
      transaction.otherAccount,
      transaction.cardSuffix,
      transaction.providerCreatedAt,
      transaction.providerUpdatedAt,
      transaction.dataUpdatedAt,
      snapshot.syncedAt
    );
  }
  sql.exec(
    "DELETE FROM transactions WHERE status='pending' AND EXISTS (SELECT 1 FROM sync_state WHERE singleton=1 AND lease_id=?)",
    snapshot.leaseId
  );
  for (const transaction of snapshot.pending) {
    sql.exec(
      transactionSql,
      transaction.id,
      transaction.providerId,
      transaction.accountId,
      transaction.status,
      transaction.transactionAt,
      transaction.description,
      transaction.amount,
      transaction.currency,
      transaction.type,
      null,
      null,
      null,
      transaction.particulars,
      transaction.code,
      transaction.reference,
      transaction.otherAccount,
      transaction.cardSuffix,
      null,
      transaction.providerUpdatedAt,
      transaction.dataUpdatedAt,
      snapshot.syncedAt
    );
  }
  sql.exec(
    "UPDATE sync_state SET lease_id=lease_id WHERE singleton=1 AND lease_id=?",
    snapshot.leaseId
  );
  return { ok: true };
};
interface CommandHandlers {
  readonly [name: string]: CommandHandler;
}
const commandHandlers: CommandHandlers = {
  acquireSync,
  completeSync,
  consumeRateLimit,
  failSync,
  getAccount,
  getSyncStatus,
  listAccounts,
  listTransactions,
  markRefreshRequested,
  reset,
  saveSnapshot,
} satisfies CommandHandlers;

export class BankStoreDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => {
      for (const statement of schema.split(";")) {
        if (statement.trim()) {
          ctx.storage.sql.exec(statement);
        }
      }
      return Promise.resolve();
    });
  }
  command(input: RpcCommand): Reply {
    try {
      const command = Schema.decodeUnknownSync(CommandSchema)(input);
      const handler = commandHandlers[command.name];
      if (!handler) {
        throw new Error(`Unknown bank store command: ${command.name}`);
      }
      const execute = () => handler(this.ctx.storage.sql, command.args);
      return command.name === "saveSnapshot"
        ? this.ctx.storage.transactionSync(execute)
        : execute();
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "database",
        ok: false,
      };
    }
  }
}
export interface StoreStub {
  readonly command: BankStoreDO["command"];
}
export const isStoreStub = <T>(value: T): value is T & StoreStub =>
  typeof value === "object" &&
  value !== null &&
  "command" in value &&
  typeof value.command === "function";
const isDomainError = (cause: unknown) =>
  cause instanceof ApiRateLimitError ||
  cause instanceof DatabaseError ||
  cause instanceof NotFoundError ||
  cause instanceof SyncInProgressError;
const toDatabaseError = (cause: unknown, operation: string): DatabaseError => {
  if (isDomainError(cause)) {
    // SAFETY: isDomainError confirms this is an Effect domain error; the cast
    // keeps the adapter's declared database error surface narrow.
    return cause as DatabaseError;
  }
  return new DatabaseError({ cause, operation });
};
const run = <A>(
  stub: StoreStub,
  name: string,
  args: readonly unknown[],
  operation: string,
  resultSchema: Schema.Codec<A, unknown, never, never>
) =>
  Effect.tryPromise({
    catch: (cause) => toDatabaseError(cause, operation),
    try: async () => {
      const reply = await stub.command({ args, name });
      if (reply.ok) {
        return Schema.decodeUnknownSync(resultSchema)(reply.value);
      }
      if (reply.error === "not-found") {
        throw new NotFoundError({ resource: "account" });
      }
      if (reply.error === "sync") {
        throw new SyncInProgressError({});
      }
      if (reply.error === "rate") {
        throw new ApiRateLimitError({
          retryAfterSeconds: reply.retryAfterSeconds ?? 1,
        });
      }
      throw new DatabaseError({ cause: reply.error, operation });
    },
  });
const runVoid = (
  stub: StoreStub,
  name: string,
  args: readonly unknown[],
  operation: string
) => run(stub, name, args, operation, Schema.Void).pipe(Effect.asVoid);
export const doBankStoreLive = (namespace: Cloudflare.Env["BANK_STORE"]) => {
  const candidate = namespace.getByName("bankglass");
  if (!isStoreStub(candidate)) {
    throw new TypeError("BANK_STORE does not expose the command RPC");
  }
  const stub = candidate;
  return Layer.succeed(
    BankStore,
    BankStore.of({
      acquireSync: (now, leaseId, before) =>
        runVoid(stub, "acquireSync", [now, leaseId, before], "acquireSync"),
      completeSync: (now, refreshedAt, leaseId) =>
        runVoid(
          stub,
          "completeSync",
          [now, refreshedAt, leaseId],
          "completeSync"
        ),
      consumeRateLimit: (bucket, now, limit) =>
        runVoid(
          stub,
          "consumeRateLimit",
          [bucket, now, limit],
          "consumeRateLimit"
        ),
      failSync: (now, code, leaseId) =>
        runVoid(stub, "failSync", [now, code, leaseId], "failSync"),
      getAccount: (id) =>
        run(stub, "getAccount", [id], "getAccount", BankAccountSchema),
      getSyncStatus: run(
        stub,
        "getSyncStatus",
        [],
        "getSyncStatus",
        SyncSchema
      ),
      listAccounts: run(
        stub,
        "listAccounts",
        [],
        "listAccounts",
        Schema.Array(BankAccountSchema)
      ),
      listTransactions: (query) =>
        run(
          stub,
          "listTransactions",
          [query],
          "listTransactions",
          TransactionPageSchema
        ),
      markRefreshRequested: (now, leaseId) =>
        runVoid(
          stub,
          "markRefreshRequested",
          [now, leaseId],
          "markRefreshRequested"
        ),
      saveSnapshot: (snapshot) =>
        runVoid(stub, "saveSnapshot", [snapshot], "saveSnapshot"),
    })
  );
};
