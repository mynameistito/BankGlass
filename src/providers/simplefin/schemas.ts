import { Schema } from "effect";

import { NonEmptyStringSchema } from "@/domain/identifiers";

const DecimalStringPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

const NumericString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) =>
        DecimalStringPattern.test(value) && Number.isFinite(Number(value))
    )
  )
);
const EpochSeconds = Schema.Number.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: number) =>
        Number.isFinite(value) &&
        value >= 0 &&
        Number.isFinite(new Date(value * 1000).getTime())
    )
  )
);
const PositiveEpochSeconds = EpochSeconds.pipe(
  Schema.check(Schema.makeFilter((value: number) => value > 0))
);

const SimpleFinErrorSchema = Schema.Struct({
  account_id: Schema.optional(NonEmptyStringSchema),
  code: NonEmptyStringSchema,
  conn_id: Schema.optional(NonEmptyStringSchema),
  msg: Schema.String,
});

const SimpleFinConnectionSchema = Schema.Struct({
  conn_id: NonEmptyStringSchema,
  name: Schema.String,
  org_id: NonEmptyStringSchema,
  org_name: Schema.optional(Schema.String),
  org_url: Schema.optional(Schema.String),
  sfin_url: Schema.String,
});

const SimpleFinTransactionSchema = Schema.Struct({
  amount: NumericString,
  description: Schema.String,
  id: NonEmptyStringSchema,
  pending: Schema.optional(Schema.Boolean),
  posted: EpochSeconds,
  transacted_at: Schema.optional(EpochSeconds),
});

const SimpleFinAccountSchema = Schema.Struct({
  "available-balance": Schema.optional(NumericString),
  balance: NumericString,
  "balance-date": PositiveEpochSeconds,
  conn_id: NonEmptyStringSchema,
  currency: Schema.String,
  id: NonEmptyStringSchema,
  name: Schema.String,
  transactions: Schema.optional(Schema.Array(SimpleFinTransactionSchema)),
});

const SimpleFinAccountSetBaseSchema = Schema.Struct({
  accounts: Schema.Array(SimpleFinAccountSchema),
  connections: Schema.Array(SimpleFinConnectionSchema),
  errlist: Schema.Array(SimpleFinErrorSchema),
});

const hasUniqueIdentities = (
  value: typeof SimpleFinAccountSetBaseSchema.Type
) => {
  const connectionIds = new Set<string>();
  for (const connection of value.connections) {
    if (connectionIds.has(connection.conn_id)) {
      return false;
    }
    connectionIds.add(connection.conn_id);
  }

  const accountIds = new Set<string>();
  const transactionIds = new Set<string>();
  for (const account of value.accounts) {
    const accountKey = JSON.stringify([account.conn_id, account.id]);
    if (accountIds.has(accountKey)) {
      return false;
    }
    accountIds.add(accountKey);

    for (const transaction of account.transactions ?? []) {
      const transactionKey = JSON.stringify([
        account.conn_id,
        account.id,
        transaction.id,
      ]);
      if (transactionIds.has(transactionKey)) {
        return false;
      }
      transactionIds.add(transactionKey);
    }
  }

  return true;
};

/** SimpleFIN Protocol v2 account-set response accepted at the adapter boundary. */
export const SimpleFinAccountSetSchema = SimpleFinAccountSetBaseSchema.pipe(
  Schema.check(Schema.makeFilter(hasUniqueIdentities))
);
