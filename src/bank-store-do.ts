import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";

import { BankStore } from "@/bank-store";
import type { ProviderSnapshot } from "@/bank-store";
import { BankAccountSchema, ProviderAccountSchema } from "@/domain/account";
import type { BankAccount } from "@/domain/account";
import { BankConnectionSchema } from "@/domain/connection";
import type { BankConnection } from "@/domain/connection";
import {
  AccountIdSchema,
  ConnectionIdSchema,
  ProviderIdSchema,
} from "@/domain/identifiers";
import { SyncStatusSchema } from "@/domain/sync";
import type { SyncStatus } from "@/domain/sync";
import {
  ProviderPendingTransactionSchema,
  ProviderPostedTransactionSchema,
  TransactionRecordSchema,
} from "@/domain/transaction";
import type { TransactionPage } from "@/domain/transaction";
import {
  ApiRateLimitError,
  DatabaseError,
  NotFoundError,
  SyncInProgressError,
} from "@/errors";

const schemaVersion = 2;
const defaultAkahuConnectionId = "connection_akahu_default";
const akahuProviderId = "akahu";
const syncLeaseSeconds = 5 * 60;
const migrationEpoch = "1970-01-01T00:00:00.000Z";

type SqlStorage = DurableObjectState["storage"]["sql"];
type SqlRow = Record<string, string | number | null>;

type Reply =
  | { readonly ok: true; readonly value?: unknown }
  | {
      readonly ok: false;
      readonly error: string;
      readonly retryAfterSeconds?: number;
    };

interface RpcCommand {
  readonly args: readonly unknown[];
  readonly name: string;
}

const CommandSchema = Schema.Struct({
  args: Schema.Array(Schema.Unknown),
  name: Schema.String,
});
const CursorSchema = Schema.Struct({ date: Schema.String, id: Schema.String });
const AccountQuerySchema = Schema.Struct({
  connectionId: Schema.NullOr(ConnectionIdSchema),
  providerId: Schema.NullOr(ProviderIdSchema),
});
const TransactionQuerySchema = Schema.Struct({
  accountId: Schema.NullOr(AccountIdSchema),
  connectionId: Schema.NullOr(ConnectionIdSchema),
  cursor: Schema.NullOr(Schema.String),
  from: Schema.NullOr(Schema.String),
  limit: Schema.Number,
  providerId: Schema.NullOr(ProviderIdSchema),
  status: Schema.NullOr(Schema.Literals(["posted", "pending"])),
  to: Schema.NullOr(Schema.String),
});
const ProviderSnapshotSchema = Schema.Struct({
  accounts: Schema.Array(ProviderAccountSchema),
  connectionId: ConnectionIdSchema,
  leaseId: Schema.String,
  pending: Schema.Array(ProviderPendingTransactionSchema),
  posted: Schema.Array(ProviderPostedTransactionSchema),
  providerId: ProviderIdSchema,
  reconcilePostedFrom: Schema.String,
  syncedAt: Schema.String,
});
const TransactionPageSchema = Schema.Struct({
  items: Schema.Array(TransactionRecordSchema),
  nextCursor: Schema.NullOr(Schema.String),
});

const currentSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    label TEXT NOT NULL,
    authorization_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_sync_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS connections_provider ON connections(provider_id, enabled, id)`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,
    institution TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    currency TEXT,
    current_balance REAL,
    available_balance REAL,
    formatted_account TEXT,
    holder_name TEXT,
    provider_balance_refreshed_at TEXT,
    provider_transactions_refreshed_at TEXT,
    data_updated_at TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    UNIQUE(connection_id, provider_account_id)
  )`,
  `CREATE INDEX IF NOT EXISTS accounts_source ON accounts(provider_id, connection_id, name, id)`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_transaction_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    status TEXT NOT NULL,
    transaction_at TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    type TEXT NOT NULL,
    balance REAL,
    merchant_name TEXT,
    category_name TEXT,
    particulars TEXT,
    code TEXT,
    reference TEXT,
    other_account TEXT,
    card_suffix TEXT,
    provider_created_at TEXT,
    provider_updated_at TEXT NOT NULL,
    data_updated_at TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    sync_token TEXT NOT NULL,
    UNIQUE(connection_id, provider_transaction_id)
  )`,
  `CREATE INDEX IF NOT EXISTS transactions_account_date ON transactions(account_id, transaction_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS transactions_date ON transactions(transaction_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS transactions_source_date ON transactions(provider_id, connection_id, transaction_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    connection_id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_provider_refresh_requested_at TEXT,
    provider_refreshed_at TEXT,
    error_code TEXT,
    error_message TEXT,
    lease_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
] as const;

const executeCurrentSchema = (sql: SqlStorage) => {
  for (const statement of currentSchemaStatements) {
    sql.exec(statement);
  }
};

const tableExists = (sql: SqlStorage, table: string) =>
  sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      table
    )
    .toArray().length === 1;

const insertDefaultAkahuConnection = (sql: SqlStorage, now: string) => {
  sql.exec(
    `INSERT OR IGNORE INTO connections(
      id,provider_id,enabled,label,authorization_json,metadata_json,created_at,updated_at,last_sync_at
    ) VALUES(?,?,?,?,?,?,?,?,NULL)`,
    defaultAkahuConnectionId,
    akahuProviderId,
    1,
    "Akahu Personal App",
    JSON.stringify({ _tag: "Connected" }),
    JSON.stringify({ credentialMode: "static" }),
    now,
    now
  );
  sql.exec(
    "INSERT OR IGNORE INTO sync_state(connection_id,provider_id,status) VALUES(?,?,'idle')",
    defaultAkahuConnectionId,
    akahuProviderId
  );
};

const migrateLegacySchema = (sql: SqlStorage, now: string) => {
  sql.exec("DROP INDEX IF EXISTS transactions_account_date");
  sql.exec("DROP INDEX IF EXISTS transactions_date");
  sql.exec("ALTER TABLE accounts RENAME TO accounts_legacy");
  sql.exec("ALTER TABLE transactions RENAME TO transactions_legacy");
  sql.exec("ALTER TABLE sync_state RENAME TO sync_state_legacy");
  executeCurrentSchema(sql);
  insertDefaultAkahuConnection(sql, now);

  sql.exec(
    `INSERT INTO accounts(
      id,connection_id,provider_id,provider_account_id,institution,name,type,status,currency,
      current_balance,available_balance,formatted_account,holder_name,
      provider_balance_refreshed_at,provider_transactions_refreshed_at,data_updated_at,synced_at
    )
    SELECT id,?, ?,provider_id,institution,name,type,status,currency,current_balance,available_balance,
      formatted_account,holder_name,provider_balance_refreshed_at,provider_transactions_refreshed_at,
      data_updated_at,synced_at
    FROM accounts_legacy`,
    defaultAkahuConnectionId,
    akahuProviderId
  );
  sql.exec(
    `INSERT INTO transactions(
      id,connection_id,provider_id,provider_transaction_id,account_id,status,transaction_at,
      description,amount,currency,type,balance,merchant_name,category_name,particulars,code,
      reference,other_account,card_suffix,provider_created_at,provider_updated_at,data_updated_at,
      synced_at,sync_token
    )
    SELECT id,?, ?,provider_id,account_id,status,transaction_at,description,amount,currency,type,
      balance,merchant_name,category_name,particulars,code,reference,other_account,card_suffix,
      provider_created_at,provider_updated_at,data_updated_at,synced_at,'legacy-migration'
    FROM transactions_legacy`,
    defaultAkahuConnectionId,
    akahuProviderId
  );
  sql.exec(
    `UPDATE connections SET last_sync_at=(
      SELECT last_success_at FROM sync_state_legacy WHERE singleton=1
    ) WHERE id=?`,
    defaultAkahuConnectionId
  );
  sql.exec(
    `UPDATE sync_state SET
      status=COALESCE((SELECT status FROM sync_state_legacy WHERE singleton=1),'idle'),
      started_at=(SELECT started_at FROM sync_state_legacy WHERE singleton=1),
      last_attempt_at=(SELECT last_attempt_at FROM sync_state_legacy WHERE singleton=1),
      last_success_at=(SELECT last_success_at FROM sync_state_legacy WHERE singleton=1),
      last_provider_refresh_requested_at=(SELECT last_provider_refresh_requested_at FROM sync_state_legacy WHERE singleton=1),
      provider_refreshed_at=(SELECT provider_refreshed_at FROM sync_state_legacy WHERE singleton=1),
      error_code=(SELECT error_code FROM sync_state_legacy WHERE singleton=1),
      error_message=(SELECT error_message FROM sync_state_legacy WHERE singleton=1),
      lease_id=(SELECT lease_id FROM sync_state_legacy WHERE singleton=1)
    WHERE connection_id=?`,
    defaultAkahuConnectionId
  );
  sql.exec("DROP TABLE accounts_legacy");
  sql.exec("DROP TABLE transactions_legacy");
  sql.exec("DROP TABLE sync_state_legacy");
};

/**
 * Upgrade BankGlass Durable Object storage to the current schema.
 *
 * The migration is idempotent and preserves local IDs from the legacy Akahu-only schema.
 *
 * @param sql - SQLite storage attached to the BankGlass Durable Object.
 * @param now - Timestamp recorded for schema and default-connection creation.
 */
export const migrateBankStoreSchema = (
  sql: SqlStorage,
  now = new Date().toISOString()
): void => {
  sql.exec(currentSchemaStatements[0]);
  const applied = sql
    .exec<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"
    )
    .toArray()[0]?.version;
  if (applied !== undefined && applied >= schemaVersion) {
    return;
  }

  const hasLegacyAccounts = tableExists(sql, "accounts");
  const hasCurrentConnections = tableExists(sql, "connections");
  if (hasLegacyAccounts && !hasCurrentConnections) {
    migrateLegacySchema(sql, now);
  } else {
    executeCurrentSchema(sql);
    insertDefaultAkahuConnection(sql, now);
  }
  sql.exec(
    "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)",
    schemaVersion,
    now
  );
};

const rowConnection = (row: SqlRow): BankConnection =>
  Schema.decodeUnknownSync(BankConnectionSchema)({
    authorization: JSON.parse(String(row["authorizationJson"])),
    createdAt: row["createdAt"],
    enabled: row["enabled"] === 1,
    id: row["id"],
    label: row["label"],
    lastSyncAt: row["lastSyncAt"],
    metadata: JSON.parse(String(row["metadataJson"])),
    providerId: row["providerId"],
    updatedAt: row["updatedAt"],
  });

const connectionSelect = `SELECT
  id,provider_id AS providerId,enabled,label,authorization_json AS authorizationJson,
  metadata_json AS metadataJson,created_at AS createdAt,updated_at AS updatedAt,last_sync_at AS lastSyncAt
  FROM connections`;
const accountSelect = `SELECT
  id,connection_id AS connectionId,provider_id AS providerId,provider_account_id AS providerAccountId,
  institution,name,type,status,currency,current_balance AS currentBalance,available_balance AS availableBalance,
  formatted_account AS formattedAccount,holder_name AS holderName,
  provider_balance_refreshed_at AS providerBalanceRefreshedAt,
  provider_transactions_refreshed_at AS providerTransactionsRefreshedAt,
  data_updated_at AS dataUpdatedAt,synced_at AS syncedAt
  FROM accounts`;
const transactionSelect = `SELECT
  id,connection_id AS connectionId,provider_id AS providerId,
  provider_transaction_id AS providerTransactionId,account_id AS accountId,status,
  transaction_at AS transactionAt,description,amount,currency,type,balance,
  merchant_name AS merchantName,category_name AS categoryName,particulars,code,reference,
  other_account AS otherAccount,card_suffix AS cardSuffix,provider_created_at AS providerCreatedAt,
  provider_updated_at AS providerUpdatedAt,data_updated_at AS dataUpdatedAt,synced_at AS syncedAt
  FROM transactions`;
const syncSelect = `SELECT
  connection_id AS connectionId,provider_id AS providerId,status,started_at AS startedAt,
  last_attempt_at AS lastAttemptAt,last_success_at AS lastSuccessAt,
  last_provider_refresh_requested_at AS lastProviderRefreshRequestedAt,
  provider_refreshed_at AS providerRefreshedAt,error_code AS errorCode,error_message AS errorMessage
  FROM sync_state`;

const rowAccount = (row: SqlRow): BankAccount =>
  Schema.decodeUnknownSync(BankAccountSchema)(row);
const rowSync = (row: SqlRow): SyncStatus =>
  Schema.decodeUnknownSync(SyncStatusSchema)(row);

const saveConnectionRow = (sql: SqlStorage, connection: BankConnection) => {
  sql.exec(
    `INSERT INTO connections(
      id,provider_id,enabled,label,authorization_json,metadata_json,created_at,updated_at,last_sync_at
    ) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      provider_id=excluded.provider_id,enabled=excluded.enabled,label=excluded.label,
      authorization_json=excluded.authorization_json,metadata_json=excluded.metadata_json,
      updated_at=excluded.updated_at`,
    connection.id,
    connection.providerId,
    connection.enabled ? 1 : 0,
    connection.label,
    JSON.stringify(connection.authorization),
    JSON.stringify(connection.metadata),
    connection.createdAt,
    connection.updatedAt,
    connection.lastSyncAt
  );
  sql.exec(
    `INSERT INTO sync_state(connection_id,provider_id,status) VALUES(?,?,'idle')
     ON CONFLICT(connection_id) DO UPDATE SET provider_id=excluded.provider_id`,
    connection.id,
    connection.providerId
  );
};

const localAccountId = (
  sql: SqlStorage,
  connectionId: string,
  providerAccountId: string
) => {
  const [row] = sql
    .exec<{ id: string }>(
      "SELECT id FROM accounts WHERE connection_id=? AND provider_account_id=?",
      connectionId,
      providerAccountId
    )
    .toArray();
  return row?.id ?? `account_${crypto.randomUUID()}`;
};

const localTransactionId = (
  sql: SqlStorage,
  connectionId: string,
  providerTransactionId: string
) => {
  const [row] = sql
    .exec<{ id: string }>(
      "SELECT id FROM transactions WHERE connection_id=? AND provider_transaction_id=?",
      connectionId,
      providerTransactionId
    )
    .toArray();
  return row?.id ?? `transaction_${crypto.randomUUID()}`;
};

const accountIdForProviderAccount = (
  sql: SqlStorage,
  connectionId: string,
  providerAccountId: string
) => {
  const [row] = sql
    .exec<{ id: string }>(
      "SELECT id FROM accounts WHERE connection_id=? AND provider_account_id=?",
      connectionId,
      providerAccountId
    )
    .toArray();
  const id = row?.id;
  if (id === undefined) {
    throw new Error("Provider transaction references an unknown account");
  }
  return id;
};

const saveSnapshotRows = (sql: SqlStorage, snapshot: ProviderSnapshot) => {
  const [connection] = sql
    .exec<{ providerId: string }>(
      "SELECT provider_id AS providerId FROM connections WHERE id=?",
      snapshot.connectionId
    )
    .toArray();
  if (connection?.providerId !== snapshot.providerId) {
    throw new Error("Snapshot provider does not match the configured connection");
  }
  const hasLease =
    sql
      .exec(
        "SELECT 1 FROM sync_state WHERE connection_id=? AND lease_id=?",
        snapshot.connectionId,
        snapshot.leaseId
      )
      .toArray().length === 1;
  if (!hasLease) {
    return { error: "sync", ok: false } as const;
  }

  for (const account of snapshot.accounts) {
    const id = localAccountId(
      sql,
      snapshot.connectionId,
      account.providerAccountId
    );
    sql.exec(
      `INSERT INTO accounts(
        id,connection_id,provider_id,provider_account_id,institution,name,type,status,currency,
        current_balance,available_balance,formatted_account,holder_name,
        provider_balance_refreshed_at,provider_transactions_refreshed_at,data_updated_at,synced_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(connection_id,provider_account_id) DO UPDATE SET
        provider_id=excluded.provider_id,institution=excluded.institution,name=excluded.name,
        type=excluded.type,status=excluded.status,currency=excluded.currency,
        current_balance=excluded.current_balance,available_balance=excluded.available_balance,
        formatted_account=excluded.formatted_account,holder_name=excluded.holder_name,
        provider_balance_refreshed_at=excluded.provider_balance_refreshed_at,
        provider_transactions_refreshed_at=excluded.provider_transactions_refreshed_at,
        data_updated_at=excluded.data_updated_at,synced_at=excluded.synced_at`,
      id,
      snapshot.connectionId,
      snapshot.providerId,
      account.providerAccountId,
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

  const upsertTransaction = (
    transaction:
      | ProviderSnapshot["posted"][number]
      | ProviderSnapshot["pending"][number]
  ) => {
    const id = localTransactionId(
      sql,
      snapshot.connectionId,
      transaction.providerTransactionId
    );
    const accountId = accountIdForProviderAccount(
      sql,
      snapshot.connectionId,
      transaction.providerAccountId
    );
    const posted = transaction.status === "posted" ? transaction : null;
    sql.exec(
      `INSERT INTO transactions(
        id,connection_id,provider_id,provider_transaction_id,account_id,status,transaction_at,
        description,amount,currency,type,balance,merchant_name,category_name,particulars,code,
        reference,other_account,card_suffix,provider_created_at,provider_updated_at,data_updated_at,
        synced_at,sync_token
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(connection_id,provider_transaction_id) DO UPDATE SET
        provider_id=excluded.provider_id,account_id=excluded.account_id,status=excluded.status,
        transaction_at=excluded.transaction_at,description=excluded.description,amount=excluded.amount,
        currency=excluded.currency,type=excluded.type,balance=excluded.balance,
        merchant_name=excluded.merchant_name,category_name=excluded.category_name,
        particulars=excluded.particulars,code=excluded.code,reference=excluded.reference,
        other_account=excluded.other_account,card_suffix=excluded.card_suffix,
        provider_created_at=excluded.provider_created_at,provider_updated_at=excluded.provider_updated_at,
        data_updated_at=excluded.data_updated_at,synced_at=excluded.synced_at,sync_token=excluded.sync_token`,
      id,
      snapshot.connectionId,
      snapshot.providerId,
      transaction.providerTransactionId,
      accountId,
      transaction.status,
      transaction.transactionAt,
      transaction.description,
      transaction.amount,
      transaction.currency,
      transaction.type,
      posted?.balance ?? null,
      posted?.merchantName ?? null,
      posted?.categoryName ?? null,
      transaction.particulars,
      transaction.code,
      transaction.reference,
      transaction.otherAccount,
      transaction.cardSuffix,
      posted?.providerCreatedAt ?? null,
      transaction.providerUpdatedAt,
      transaction.dataUpdatedAt,
      snapshot.syncedAt,
      snapshot.leaseId
    );
  };

  for (const transaction of snapshot.posted) {
    upsertTransaction(transaction);
  }
  sql.exec(
    `DELETE FROM transactions
     WHERE connection_id=? AND status='posted' AND transaction_at>? AND sync_token<>?`,
    snapshot.connectionId,
    snapshot.reconcilePostedFrom,
    snapshot.leaseId
  );
  for (const transaction of snapshot.pending) {
    upsertTransaction(transaction);
  }
  sql.exec(
    `DELETE FROM transactions
     WHERE connection_id=? AND status='pending' AND sync_token<>?`,
    snapshot.connectionId,
    snapshot.leaseId
  );
  return { ok: true } as const;
};

type CommandHandler = (sql: SqlStorage, args: readonly unknown[]) => Reply;

const reset: CommandHandler = (sql) => {
  sql.exec("DELETE FROM transactions");
  sql.exec("DELETE FROM accounts");
  sql.exec("DELETE FROM sync_state");
  sql.exec("DELETE FROM connections");
  sql.exec("DELETE FROM rate_limits");
  insertDefaultAkahuConnection(sql, migrationEpoch);
  return { ok: true };
};

const listConnections: CommandHandler = (sql) => ({
  ok: true,
  value: sql
    .exec<SqlRow>(`${connectionSelect} ORDER BY provider_id,label,id`)
    .toArray()
    .map(rowConnection),
});

const getConnection: CommandHandler = (sql, args) => {
  const [connectionId] = Schema.decodeUnknownSync(
    Schema.Tuple([ConnectionIdSchema])
  )(args);
  const [row] = sql
    .exec<SqlRow>(`${connectionSelect} WHERE id=?`, connectionId)
    .toArray();
  return row === undefined
    ? { error: "not-found", ok: false }
    : { ok: true, value: rowConnection(row) };
};

const saveConnection: CommandHandler = (sql, args) => {
  const [connection] = Schema.decodeUnknownSync(
    Schema.Tuple([BankConnectionSchema])
  )(args);
  saveConnectionRow(sql, connection);
  return { ok: true };
};

const deleteConnection: CommandHandler = (sql, args) => {
  const [connectionId] = Schema.decodeUnknownSync(
    Schema.Tuple([ConnectionIdSchema])
  )(args);
  if (
    sql.exec("SELECT 1 FROM connections WHERE id=?", connectionId).toArray()
      .length === 0
  ) {
    return { error: "not-found", ok: false };
  }
  sql.exec("DELETE FROM transactions WHERE connection_id=?", connectionId);
  sql.exec("DELETE FROM accounts WHERE connection_id=?", connectionId);
  sql.exec("DELETE FROM sync_state WHERE connection_id=?", connectionId);
  sql.exec("DELETE FROM connections WHERE id=?", connectionId);
  return { ok: true };
};

const listAccounts: CommandHandler = (sql, args) => {
  const [query] = Schema.decodeUnknownSync(
    Schema.Tuple([AccountQuerySchema])
  )(args);
  const where: string[] = [];
  const values: unknown[] = [];
  if (query.connectionId !== null) {
    where.push("connection_id=?");
    values.push(query.connectionId);
  }
  if (query.providerId !== null) {
    where.push("provider_id=?");
    values.push(query.providerId);
  }
  const clause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
  return {
    ok: true,
    value: sql
      .exec<SqlRow>(`${accountSelect}${clause} ORDER BY name,id`, ...values)
      .toArray()
      .map(rowAccount),
  };
};

const getAccount: CommandHandler = (sql, args) => {
  const [id] = Schema.decodeUnknownSync(Schema.Tuple([AccountIdSchema]))(args);
  const [row] = sql
    .exec<SqlRow>(`${accountSelect} WHERE id=?`, id)
    .toArray();
  return row === undefined
    ? { error: "not-found", ok: false }
    : { ok: true, value: rowAccount(row) };
};

const listTransactions: CommandHandler = (sql, args) => {
  const [query] = Schema.decodeUnknownSync(
    Schema.Tuple([TransactionQuerySchema])
  )(args);
  const where: string[] = [];
  const values: unknown[] = [];
  for (const [value, clause] of [
    [query.accountId, "account_id=?"],
    [query.connectionId, "connection_id=?"],
    [query.providerId, "provider_id=?"],
    [query.status, "status=?"],
    [query.from, "transaction_at>=?"],
    [query.to, "transaction_at<=?"],
  ] as const) {
    if (value !== null) {
      where.push(clause);
      values.push(value);
    }
  }
  if (query.cursor !== null) {
    const cursor = Schema.decodeUnknownSync(CursorSchema)(
      JSON.parse(atob(query.cursor))
    );
    where.push("(transaction_at<? OR (transaction_at=? AND id<?))");
    values.push(cursor.date, cursor.date, cursor.id);
  }
  const clause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
  const rows = sql
    .exec<SqlRow>(
      `${transactionSelect}${clause} ORDER BY transaction_at DESC,id DESC LIMIT ?`,
      ...values,
      query.limit + 1
    )
    .toArray();
  const decoded = rows.map((row) =>
    Schema.decodeUnknownSync(TransactionRecordSchema)(row)
  );
  const items = decoded.slice(0, query.limit);
  const last = items.at(-1);
  const page: TransactionPage = {
    items,
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? btoa(JSON.stringify({ date: last.transactionAt, id: last.id }))
        : null,
  };
  return { ok: true, value: page };
};

const getSyncStatus: CommandHandler = (sql, args) => {
  const [connectionId] = Schema.decodeUnknownSync(
    Schema.Tuple([ConnectionIdSchema])
  )(args);
  const [row] = sql
    .exec<SqlRow>(`${syncSelect} WHERE connection_id=?`, connectionId)
    .toArray();
  return row === undefined
    ? { error: "not-found", ok: false }
    : { ok: true, value: rowSync(row) };
};

const listSyncStatuses: CommandHandler = (sql) => ({
  ok: true,
  value: sql
    .exec<SqlRow>(`${syncSelect} ORDER BY provider_id,connection_id`)
    .toArray()
    .map(rowSync),
});

const acquireSync: CommandHandler = (sql, args) => {
  const [connectionId, now, leaseId, providerRefreshAllowedBefore] =
    Schema.decodeUnknownSync(
      Schema.Tuple([
        ConnectionIdSchema,
        Schema.String,
        Schema.String,
        Schema.NullOr(Schema.String),
      ])
    )(args);
  const result = sql.exec(
    `UPDATE sync_state SET
      status='syncing',started_at=?,last_attempt_at=?,lease_id=?,error_code=NULL,error_message=NULL
     WHERE connection_id=?
       AND (status NOT IN ('syncing','refreshing') OR started_at IS NULL OR julianday(started_at) <= julianday(?) - ? / 86400.0)
       AND (? IS NULL OR last_provider_refresh_requested_at IS NULL OR julianday(last_provider_refresh_requested_at) <= julianday(?))`,
    now,
    now,
    leaseId,
    connectionId,
    now,
    syncLeaseSeconds,
    providerRefreshAllowedBefore,
    providerRefreshAllowedBefore
  );
  return result.rowsWritten === 1
    ? { ok: true }
    : { error: "sync", ok: false };
};

const updateLease = (
  sql: SqlStorage,
  query: string,
  args: readonly unknown[]
): Reply => {
  const result = sql.exec(query, ...args);
  return result.rowsWritten === 1
    ? { ok: true }
    : { error: "sync", ok: false };
};

const markRefreshRequested: CommandHandler = (sql, args) => {
  const [connectionId, now, leaseId] = Schema.decodeUnknownSync(
    Schema.Tuple([ConnectionIdSchema, Schema.String, Schema.String])
  )(args);
  return updateLease(
    sql,
    `UPDATE sync_state SET status='refreshing',last_provider_refresh_requested_at=?
     WHERE connection_id=? AND lease_id=?`,
    [now, connectionId, leaseId]
  );
};

const completeSync: CommandHandler = (sql, args) => {
  const [connectionId, now, providerRefreshedAt, leaseId] =
    Schema.decodeUnknownSync(
      Schema.Tuple([
        ConnectionIdSchema,
        Schema.String,
        Schema.NullOr(Schema.String),
        Schema.String,
      ])
    )(args);
  const reply = updateLease(
    sql,
    `UPDATE sync_state SET
      status='idle',started_at=NULL,lease_id=NULL,last_success_at=?,provider_refreshed_at=?,
      error_code=NULL,error_message=NULL
     WHERE connection_id=? AND lease_id=?`,
    [now, providerRefreshedAt, connectionId, leaseId]
  );
  if (reply.ok) {
    sql.exec(
      "UPDATE connections SET last_sync_at=? WHERE id=?",
      now,
      connectionId
    );
  }
  return reply;
};

const failSync: CommandHandler = (sql, args) => {
  const [connectionId, now, code, leaseId] = Schema.decodeUnknownSync(
    Schema.Tuple([
      ConnectionIdSchema,
      Schema.String,
      Schema.String,
      Schema.String,
    ])
  )(args);
  sql.exec(
    `UPDATE sync_state SET
      status='failed',started_at=NULL,lease_id=NULL,last_attempt_at=?,error_code=?,
      error_message='Synchronization failed'
     WHERE connection_id=? AND lease_id=?`,
    now,
    code,
    connectionId,
    leaseId
  );
  return { ok: true };
};

const consumeRateLimit: CommandHandler = (sql, args) => {
  const [bucket, now, limit] = Schema.decodeUnknownSync(
    Schema.Tuple([Schema.String, Schema.Number, Schema.Number])
  )(args);
  sql.exec("DELETE FROM rate_limits WHERE expires_at<=?", now);
  const expires = now + 60;
  sql.exec(
    `INSERT INTO rate_limits(bucket,count,expires_at) VALUES(?,1,?)
     ON CONFLICT(bucket) DO UPDATE SET count=count+1`,
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
  const [snapshot] = Schema.decodeUnknownSync(
    Schema.Tuple([ProviderSnapshotSchema])
  )(args);
  return saveSnapshotRows(sql, snapshot);
};

const commandHandlers: Record<string, CommandHandler> = {
  acquireSync,
  completeSync,
  consumeRateLimit,
  deleteConnection,
  failSync,
  getAccount,
  getConnection,
  getSyncStatus,
  listAccounts,
  listConnections,
  listSyncStatuses,
  listTransactions,
  markRefreshRequested,
  reset,
  saveConnection,
  saveSnapshot,
};

/** Durable Object implementation of the SQLite-backed BankGlass store. */
export class BankStoreDO extends DurableObject {
  /** Initialize and migrate the SQLite schema before accepting store commands. */
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => {
      ctx.storage.transactionSync(() => migrateBankStoreSchema(ctx.storage.sql));
      return Promise.resolve();
    });
  }

  /** Execute one validated store command, transactionally for state-changing operations. */
  command(input: RpcCommand): Reply {
    try {
      const command = Schema.decodeUnknownSync(CommandSchema)(input);
      const handler = commandHandlers[command.name];
      if (handler === undefined) {
        throw new Error(`Unknown bank store command: ${command.name}`);
      }
      const execute = () => handler(this.ctx.storage.sql, command.args);
      return ["deleteConnection", "saveConnection", "saveSnapshot"].includes(
        command.name
      )
        ? this.ctx.storage.transactionSync(execute)
        : execute();
    } catch (error) {
      const databaseError = new DatabaseError({
        cause: error,
        operation: "command",
      });
      return { error: databaseError._tag, ok: false };
    }
  }
}

/** RPC surface required from the Bank Store Durable Object namespace stub. */
export interface StoreStub {
  /** Execute a serialized store command. */
  readonly command: BankStoreDO["command"];
}

/** Determine whether a namespace result exposes the Bank Store RPC method. */
export const isStoreStub = <T>(value: T): value is T & StoreStub =>
  typeof value === "object" &&
  value !== null &&
  "command" in value &&
  typeof value.command === "function";

type ExpectedError = ApiRateLimitError | NotFoundError | SyncInProgressError;
type ErrorMapper<E extends ExpectedError> = (cause: unknown) => E | undefined;

const toStoreError = <E extends ExpectedError>(
  cause: unknown,
  operation: string,
  mapExpectedError?: ErrorMapper<E>
): DatabaseError | E =>
  mapExpectedError?.(cause) ?? new DatabaseError({ cause, operation });
const preserveApiRateLimit = (cause: unknown) =>
  cause instanceof ApiRateLimitError ? cause : undefined;
const preserveNotFound = (cause: unknown) =>
  cause instanceof NotFoundError ? cause : undefined;
const preserveSyncInProgress = (cause: unknown) =>
  cause instanceof SyncInProgressError ? cause : undefined;

function run<A>(
  stub: StoreStub,
  name: string,
  args: readonly unknown[],
  operation: string,
  resultSchema: Schema.Codec<A, unknown, never, never>
): Effect.Effect<A, DatabaseError>;
function run<A, E extends ExpectedError>(
  stub: StoreStub,
  name: string,
  args: readonly unknown[],
  operation: string,
  resultSchema: Schema.Codec<A, unknown, never, never>,
  mapExpectedError: ErrorMapper<E>
): Effect.Effect<A, DatabaseError | E>;
function run<A, E extends ExpectedError>(
  stub: StoreStub,
  name: string,
  args: readonly unknown[],
  operation: string,
  resultSchema: Schema.Codec<A, unknown, never, never>,
  mapExpectedError?: ErrorMapper<E>
) {
  return Effect.tryPromise({
    catch: (cause) => toStoreError(cause, operation, mapExpectedError),
    try: async () => {
      const reply = await stub.command({ args, name });
      if (reply.ok) {
        return Schema.decodeUnknownSync(resultSchema)(reply.value);
      }
      if (reply.error === "not-found") {
        throw new NotFoundError({ resource: operation });
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
}

function runVoid(
  stub: StoreStub,
  name: string,
  args: readonly unknown[],
  operation: string
): Effect.Effect<void, DatabaseError>;
function runVoid<E extends ExpectedError>(
  stub: StoreStub,
  name: string,
  args: readonly unknown[],
  operation: string,
  mapExpectedError: ErrorMapper<E>
): Effect.Effect<void, DatabaseError | E>;
function runVoid<E extends ExpectedError>(
  stub: StoreStub,
  name: string,
  args: readonly unknown[],
  operation: string,
  mapExpectedError?: ErrorMapper<E>
) {
  return (
    mapExpectedError === undefined
      ? run(stub, name, args, operation, Schema.Void)
      : run(stub, name, args, operation, Schema.Void, mapExpectedError)
  ).pipe(Effect.asVoid);
}

/**
 * Provide the application store backed by the named Bank Store Durable Object.
 *
 * @param namespace - Durable Object namespace binding from the Worker runtime.
 * @returns A Layer implementing connection-scoped `BankStore` persistence.
 * @throws {TypeError} When the namespace does not expose the expected RPC surface.
 */
export const doBankStoreLive = (namespace: Cloudflare.Env["BANK_STORE"]) => {
  const candidate = namespace.getByName("bankglass");
  if (!isStoreStub(candidate)) {
    throw new TypeError("BANK_STORE does not expose the command RPC");
  }
  const stub = candidate;
  return Layer.succeed(
    BankStore,
    BankStore.of({
      acquireSync: (connectionId, now, leaseId, before) =>
        runVoid(
          stub,
          "acquireSync",
          [connectionId, now, leaseId, before],
          "acquireSync",
          preserveSyncInProgress
        ),
      completeSync: (connectionId, now, refreshedAt, leaseId) =>
        runVoid(
          stub,
          "completeSync",
          [connectionId, now, refreshedAt, leaseId],
          "completeSync",
          preserveSyncInProgress
        ),
      consumeRateLimit: (bucket, now, limit) =>
        runVoid(
          stub,
          "consumeRateLimit",
          [bucket, now, limit],
          "consumeRateLimit",
          preserveApiRateLimit
        ),
      deleteConnection: (connectionId) =>
        runVoid(
          stub,
          "deleteConnection",
          [connectionId],
          "connection",
          preserveNotFound
        ),
      failSync: (connectionId, now, code, leaseId) =>
        runVoid(
          stub,
          "failSync",
          [connectionId, now, code, leaseId],
          "failSync"
        ),
      getAccount: (id) =>
        run(
          stub,
          "getAccount",
          [id],
          "account",
          BankAccountSchema,
          preserveNotFound
        ),
      getConnection: (connectionId) =>
        run(
          stub,
          "getConnection",
          [connectionId],
          "connection",
          BankConnectionSchema,
          preserveNotFound
        ),
      getSyncStatus: (connectionId) =>
        run(
          stub,
          "getSyncStatus",
          [connectionId],
          "sync-status",
          SyncStatusSchema,
          preserveNotFound
        ),
      listAccounts: (query) =>
        run(
          stub,
          "listAccounts",
          [query],
          "listAccounts",
          Schema.Array(BankAccountSchema)
        ),
      listConnections: run(
        stub,
        "listConnections",
        [],
        "listConnections",
        Schema.Array(BankConnectionSchema)
      ),
      listSyncStatuses: run(
        stub,
        "listSyncStatuses",
        [],
        "listSyncStatuses",
        Schema.Array(SyncStatusSchema)
      ),
      listTransactions: (query) =>
        run(
          stub,
          "listTransactions",
          [query],
          "listTransactions",
          TransactionPageSchema
        ),
      markRefreshRequested: (connectionId, now, leaseId) =>
        runVoid(
          stub,
          "markRefreshRequested",
          [connectionId, now, leaseId],
          "markRefreshRequested",
          preserveSyncInProgress
        ),
      saveConnection: (connection) =>
        runVoid(stub, "saveConnection", [connection], "saveConnection"),
      saveSnapshot: (snapshot) =>
        runVoid(
          stub,
          "saveSnapshot",
          [snapshot],
          "saveSnapshot",
          preserveSyncInProgress
        ),
    })
  );
};
