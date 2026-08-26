import { Schema } from "effect";

const IsoDateTime = Schema.String.pipe(
  Schema.filter((value) => !Number.isNaN(Date.parse(value)))
);

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
  status: Schema.Literal("active", "inactive"),
  syncedAt: IsoDateTime,
  type: Schema.String,
});
export type BankAccount = typeof BankAccountSchema.Type;

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
export type PostedTransaction = typeof PostedTransactionSchema.Type;

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
export type PendingTransaction = typeof PendingTransactionSchema.Type;

export interface TransactionQuery {
  readonly accountId: string | null;
  readonly status: "posted" | "pending" | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly limit: number;
  readonly cursor: string | null;
}
export interface TransactionPage {
  readonly items: readonly Record<string, unknown>[];
  readonly nextCursor: string | null;
}
export interface SyncStatus {
  readonly status: "idle" | "refreshing" | "syncing" | "failed";
  readonly startedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastProviderRefreshRequestedAt: string | null;
  readonly providerRefreshedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}
