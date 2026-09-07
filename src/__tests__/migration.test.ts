import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { isStoreStub, migrateBankStoreSchema } from "@/bank-store-do";

const time = "2026-08-26T00:00:00.000Z";

const legacySchema = [
  `CREATE TABLE accounts (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL UNIQUE, institution TEXT NOT NULL,
    name TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, currency TEXT,
    current_balance REAL, available_balance REAL, formatted_account TEXT, holder_name TEXT,
    provider_balance_refreshed_at TEXT, provider_transactions_refreshed_at TEXT,
    data_updated_at TEXT NOT NULL, synced_at TEXT NOT NULL
  )`,
  `CREATE TABLE transactions (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL,
    status TEXT NOT NULL, transaction_at TEXT NOT NULL, description TEXT NOT NULL,
    amount REAL NOT NULL, currency TEXT NOT NULL, type TEXT NOT NULL, balance REAL,
    merchant_name TEXT, category_name TEXT, particulars TEXT, code TEXT, reference TEXT,
    other_account TEXT, card_suffix TEXT, provider_created_at TEXT,
    provider_updated_at TEXT NOT NULL, data_updated_at TEXT NOT NULL, synced_at TEXT NOT NULL
  )`,
  `CREATE INDEX transactions_account_date ON transactions(account_id, transaction_at DESC, id DESC)`,
  `CREATE INDEX transactions_date ON transactions(transaction_at DESC, id DESC)`,
  `CREATE TABLE sync_state (
    singleton INTEGER PRIMARY KEY, status TEXT NOT NULL, started_at TEXT, last_attempt_at TEXT,
    last_success_at TEXT, last_provider_refresh_requested_at TEXT, provider_refreshed_at TEXT,
    error_code TEXT, error_message TEXT, lease_id TEXT
  )`,
  `CREATE TABLE rate_limits (
    bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`,
] as const;

describe("bank store schema migration", () => {
  it("upgrades the pre-multi-provider Akahu schema without data loss", async () => {
    const stub = env.BANK_STORE.getByName("bankglass");
    if (!isStoreStub(stub)) {
      throw new TypeError("BANK_STORE does not expose the command RPC");
    }

    await runInDurableObject(stub, (_instance, state) => {
      const { sql } = state.storage;
      for (const table of [
        "transactions",
        "accounts",
        "sync_state",
        "connections",
        "rate_limits",
        "schema_migrations",
      ]) {
        sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      sql.exec("DROP INDEX IF EXISTS transactions_account_date");
      sql.exec("DROP INDEX IF EXISTS transactions_date");
      sql.exec("DROP INDEX IF EXISTS transactions_source_date");
      sql.exec("DROP INDEX IF EXISTS accounts_source");
      sql.exec("DROP INDEX IF EXISTS connections_provider");
      for (const statement of legacySchema) {
        sql.exec(statement);
      }

      sql.exec(
        `INSERT INTO accounts VALUES(
          'account_acc_1','acc_1','BNZ','Everyday','checking','active','NZD',100,80,NULL,NULL,?,?,?,?
        )`,
        time,
        time,
        time,
        time
      );
      sql.exec(
        `INSERT INTO transactions VALUES(
          'transaction_tx_1','tx_1','account_acc_1','posted',?,'Coffee',-5,'NZD','EFTPOS',95,
          NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?,?,?
        )`,
        time,
        time,
        time,
        time,
        time
      );
      sql.exec(
        `INSERT INTO sync_state(
          singleton,status,started_at,last_attempt_at,last_success_at,
          last_provider_refresh_requested_at,provider_refreshed_at,error_code,error_message,lease_id
        ) VALUES(1,'idle',NULL,?,?,?,?,NULL,NULL,NULL)`,
        time,
        time,
        time,
        time
      );

      migrateBankStoreSchema(sql, time);

      const connection = sql
        .exec<{
          id: string;
          lastSyncAt: string | null;
          providerId: string;
        }>(
          "SELECT id,provider_id AS providerId,last_sync_at AS lastSyncAt FROM connections"
        )
        .one();
      const migratedAccount = sql
        .exec<{
          connectionId: string;
          id: string;
          providerAccountId: string;
        }>(
          "SELECT id,connection_id AS connectionId,provider_account_id AS providerAccountId FROM accounts"
        )
        .one();
      const migratedTransaction = sql
        .exec<{
          connectionId: string;
          id: string;
          providerTransactionId: string;
        }>(
          "SELECT id,connection_id AS connectionId,provider_transaction_id AS providerTransactionId FROM transactions"
        )
        .one();
      const sync = sql
        .exec<{ lastSuccessAt: string | null }>(
          "SELECT last_success_at AS lastSuccessAt FROM sync_state WHERE connection_id='connection_akahu_default'"
        )
        .one();

      expect({ connection, migratedAccount, migratedTransaction, sync }).toStrictEqual({
        connection: {
          id: "connection_akahu_default",
          lastSyncAt: time,
          providerId: "akahu",
        },
        migratedAccount: {
          connectionId: "connection_akahu_default",
          id: "account_acc_1",
          providerAccountId: "acc_1",
        },
        migratedTransaction: {
          connectionId: "connection_akahu_default",
          id: "transaction_tx_1",
          providerTransactionId: "tx_1",
        },
        sync: { lastSuccessAt: time },
      });

      migrateBankStoreSchema(sql, "2026-08-27T00:00:00.000Z");
      const accountCount = sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM accounts")
        .one().count;
      const transactionCount = sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM transactions")
        .one().count;
      const migrationCount = sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE version=2"
        )
        .one().count;
      expect({ accountCount, migrationCount, transactionCount }).toStrictEqual({
        accountCount: 1,
        migrationCount: 1,
        transactionCount: 1,
      });
    });
  });
});
