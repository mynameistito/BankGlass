import { Schema } from "effect";

import {
  AccountIdSchema,
  ConnectionIdSchema,
  ProviderAccountIdSchema,
  ProviderIdSchema,
  ProviderTransactionIdSchema,
  TransactionIdSchema,
} from "@/domain/identifiers";

const IsoDateTimeSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => !Number.isNaN(Date.parse(value)))
  )
);

const CommonProviderTransactionFields = {
  amount: Schema.Number,
  cardSuffix: Schema.NullOr(Schema.String),
  code: Schema.NullOr(Schema.String),
  currency: Schema.String,
  dataUpdatedAt: IsoDateTimeSchema,
  description: Schema.String,
  otherAccount: Schema.NullOr(Schema.String),
  particulars: Schema.NullOr(Schema.String),
  providerAccountId: ProviderAccountIdSchema,
  providerTransactionId: ProviderTransactionIdSchema,
  providerUpdatedAt: IsoDateTimeSchema,
  reference: Schema.NullOr(Schema.String),
  syncedAt: IsoDateTimeSchema,
  transactionAt: IsoDateTimeSchema,
  type: Schema.String,
} as const;

/** Posted transaction normalized by a provider before local identity is assigned. */
export const ProviderPostedTransactionSchema = Schema.Struct({
  ...CommonProviderTransactionFields,
  balance: Schema.NullOr(Schema.Number),
  categoryName: Schema.NullOr(Schema.String),
  merchantName: Schema.NullOr(Schema.String),
  providerCreatedAt: Schema.NullOr(IsoDateTimeSchema),
  status: Schema.Literal("posted"),
});
/** Posted transaction normalized by a provider before local identity is assigned. */
export type ProviderPostedTransaction =
  typeof ProviderPostedTransactionSchema.Type;

/** Pending transaction normalized by a provider before local identity is assigned. */
export const ProviderPendingTransactionSchema = Schema.Struct({
  ...CommonProviderTransactionFields,
  status: Schema.Literal("pending"),
});
/** Pending transaction normalized by a provider before local identity is assigned. */
export type ProviderPendingTransaction =
  typeof ProviderPendingTransactionSchema.Type;

const PersistedTransactionFields = {
  accountId: AccountIdSchema,
  amount: Schema.Number,
  balance: Schema.NullOr(Schema.Number),
  cardSuffix: Schema.NullOr(Schema.String),
  categoryName: Schema.NullOr(Schema.String),
  code: Schema.NullOr(Schema.String),
  connectionId: ConnectionIdSchema,
  currency: Schema.String,
  dataUpdatedAt: IsoDateTimeSchema,
  description: Schema.String,
  id: TransactionIdSchema,
  merchantName: Schema.NullOr(Schema.String),
  otherAccount: Schema.NullOr(Schema.String),
  particulars: Schema.NullOr(Schema.String),
  providerId: ProviderIdSchema,
  providerTransactionId: ProviderTransactionIdSchema,
  providerUpdatedAt: IsoDateTimeSchema,
  reference: Schema.NullOr(Schema.String),
  syncedAt: IsoDateTimeSchema,
  transactionAt: IsoDateTimeSchema,
  type: Schema.String,
} as const;

/** Posted or pending transaction persisted and exposed by BankGlass. */
export const TransactionRecordSchema = Schema.Struct({
  ...PersistedTransactionFields,
  status: Schema.Literals(["posted", "pending"]),
});
/** Posted or pending transaction persisted and exposed by BankGlass. */
export type TransactionRecord = typeof TransactionRecordSchema.Type;

/** Filters and pagination controls for transaction queries. */
export interface TransactionQuery {
  /** Restrict results to one account, or search all accounts when `null`. */
  readonly accountId: typeof AccountIdSchema.Type | null;
  /** Restrict results to one connection, or search all connections when `null`. */
  readonly connectionId: typeof ConnectionIdSchema.Type | null;
  /** Restrict results to one provider, or search all providers when `null`. */
  readonly providerId: typeof ProviderIdSchema.Type | null;
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

/** One page of persisted transactions and the cursor for the next page. */
export interface TransactionPage {
  /** Transactions ordered newest first. */
  readonly items: readonly TransactionRecord[];
  /** Opaque cursor for the next page, or `null` when no page remains. */
  readonly nextCursor: string | null;
}
