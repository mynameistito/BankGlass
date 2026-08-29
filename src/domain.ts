import { Schema } from "effect";

const IsoDateTime = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => !Number.isNaN(Date.parse(value)))
  )
);

/** Runtime schema for normalized bank account records. */
export const BankAccountSchema = Schema.Struct({
  availableBalance: Schema.NullOr(Schema.Number),
  currency: Schema.NullOr(Schema.String),
  currentBalance: Schema.NullOr(Schema.Number),
  dataUpdatedAt: IsoDateTime,
  formattedAccount: Schema.NullOr(Schema.String),
  holderName: Schema.NullOr(Schema.String),
  id: Schema.String,
  institution: Schema.String,
  name: Schema.String,
  providerBalanceRefreshedAt: Schema.NullOr(IsoDateTime),
  providerId: Schema.String,
  providerTransactionsRefreshedAt: Schema.NullOr(IsoDateTime),
  status: Schema.Literals(["active", "inactive"]),
  syncedAt: IsoDateTime,
  type: Schema.String,
});
/** A normalized bank account and its cached balance metadata. */
export type BankAccount = typeof BankAccountSchema.Type;

/** Runtime schema for normalized posted transaction records. */
export const PostedTransactionSchema = Schema.Struct({
  accountId: Schema.String,
  amount: Schema.Number,
  balance: Schema.NullOr(Schema.Number),
  cardSuffix: Schema.NullOr(Schema.String),
  categoryName: Schema.NullOr(Schema.String),
  code: Schema.NullOr(Schema.String),
  currency: Schema.String,
  dataUpdatedAt: IsoDateTime,
  description: Schema.String,
  id: Schema.String,
  merchantName: Schema.NullOr(Schema.String),
  otherAccount: Schema.NullOr(Schema.String),
  particulars: Schema.NullOr(Schema.String),
  providerCreatedAt: Schema.NullOr(IsoDateTime),
  providerId: Schema.String,
  providerUpdatedAt: IsoDateTime,
  reference: Schema.NullOr(Schema.String),
  status: Schema.Literal("posted"),
  syncedAt: IsoDateTime,
  transactionAt: IsoDateTime,
  type: Schema.String,
});
/** A normalized transaction that has been posted by the provider. */
export type PostedTransaction = typeof PostedTransactionSchema.Type;

/** Runtime schema for normalized pending transaction records. */
export const PendingTransactionSchema = Schema.Struct({
  accountId: Schema.String,
  amount: Schema.Number,
  cardSuffix: Schema.NullOr(Schema.String),
  code: Schema.NullOr(Schema.String),
  currency: Schema.String,
  dataUpdatedAt: IsoDateTime,
  description: Schema.String,
  id: Schema.String,
  otherAccount: Schema.NullOr(Schema.String),
  particulars: Schema.NullOr(Schema.String),
  providerId: Schema.String,
  providerUpdatedAt: IsoDateTime,
  reference: Schema.NullOr(Schema.String),
  status: Schema.Literal("pending"),
  syncedAt: IsoDateTime,
  transactionAt: IsoDateTime,
  type: Schema.String,
});
/** A normalized transaction that is still pending at the provider. */
export type PendingTransaction = typeof PendingTransactionSchema.Type;

/** A transaction row returned by the local store. */
export interface TransactionRecord {
  /** The normalized account identifier. */
  readonly accountId: string;
  /** The transaction amount in the account currency. */
  readonly amount: number;
  /** Balance after the transaction, when supplied by the provider. */
  readonly balance: number | null;
  /** Last four digits of the payment card, when available. */
  readonly cardSuffix: string | null;
  /** Provider category, when available. */
  readonly categoryName: string | null;
  /** Provider transaction code, when available. */
  readonly code: string | null;
  /** ISO currency code. */
  readonly currency: string;
  /** Timestamp at which the provider data was read. */
  readonly dataUpdatedAt: string;
  /** Human-readable transaction description. */
  readonly description: string;
  /** Stable normalized transaction identifier. */
  readonly id: string;
  /** Provider merchant name, when available. */
  readonly merchantName: string | null;
  /** Counterparty account, when available. */
  readonly otherAccount: string | null;
  /** Provider particulars, when available. */
  readonly particulars: string | null;
  /** Provider update timestamp. */
  readonly providerUpdatedAt: string;
  /** Provider reference, when available. */
  readonly reference: string | null;
  /** Whether the transaction is posted or pending. */
  readonly status: "posted" | "pending";
  /** Timestamp at which the local store synchronized the record. */
  readonly syncedAt: string;
  /** Transaction occurrence timestamp. */
  readonly transactionAt: string;
  /** Provider-specific transaction type. */
  readonly type: string;
}

/** Filters and pagination controls for transaction queries. */
export interface TransactionQuery {
  /** Restrict results to one account, or search all accounts when `null`. */
  readonly accountId: string | null;
  /** Restrict results by lifecycle status, or include both when `null`. */
  readonly status: "posted" | "pending" | null;
  /** Inclusive lower transaction date-time bound. */
  readonly from: string | null;
  /** Inclusive upper transaction date-time bound. */
  readonly to: string | null;
  /** Maximum number of records to return. */
  readonly limit: number;
  /** Opaque cursor returned by a previous page, or `null` for the first page. */
  readonly cursor: string | null;
}
/** One page of transactions and the cursor for the next page. */
export interface TransactionPage {
  /** Transactions ordered newest first. */
  readonly items: readonly TransactionRecord[];
  /** Opaque cursor for the next page, or `null` when no page remains. */
  readonly nextCursor: string | null;
}
/** Current synchronization state and provider freshness information. */
export interface SyncStatus {
  /** Current store state, such as `idle`, `syncing`, or `failed`. */
  readonly status: string & { readonly __syncStatus?: never };
  /** Start timestamp of the active synchronization, if any. */
  readonly startedAt: string | null;
  /** Timestamp of the most recent synchronization attempt. */
  readonly lastAttemptAt: string | null;
  /** Timestamp of the most recent successful synchronization. */
  readonly lastSuccessAt: string | null;
  /** Timestamp of the most recent upstream refresh request. */
  readonly lastProviderRefreshRequestedAt: string | null;
  /** Provider freshness timestamp represented by the stored snapshot. */
  readonly providerRefreshedAt: string | null;
  /** Stable error code from the most recent failed synchronization. */
  readonly errorCode: string | null;
  /** Safe error message from the most recent failed synchronization. */
  readonly errorMessage: string | null;
}
