PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL UNIQUE,
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
  synced_at TEXT NOT NULL
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('posted', 'pending')),
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
  synced_at TEXT NOT NULL
);

CREATE INDEX transactions_account_date ON transactions(account_id, transaction_at DESC, id DESC);
CREATE INDEX transactions_date ON transactions(transaction_at DESC, id DESC);

CREATE TABLE sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  status TEXT NOT NULL CHECK (status IN ('idle', 'refreshing', 'syncing', 'failed')),
  started_at TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_provider_refresh_requested_at TEXT,
  provider_refreshed_at TEXT,
  error_code TEXT,
  error_message TEXT
);
INSERT INTO sync_state(singleton, status) VALUES (1, 'idle');

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
