import { Schema } from "effect";

import {
  AccountIdSchema,
  ConnectionIdSchema,
  ProviderAccountIdSchema,
  ProviderIdSchema,
} from "@/domain/identifiers";

const IsoDateTimeSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => !Number.isNaN(Date.parse(value)))
  )
);

const AccountFields = {
  availableBalance: Schema.NullOr(Schema.Number),
  currency: Schema.NullOr(Schema.String),
  currentBalance: Schema.NullOr(Schema.Number),
  dataUpdatedAt: IsoDateTimeSchema,
  formattedAccount: Schema.NullOr(Schema.String),
  holderName: Schema.NullOr(Schema.String),
  institution: Schema.String,
  name: Schema.String,
  providerBalanceRefreshedAt: Schema.NullOr(IsoDateTimeSchema),
  providerTransactionsRefreshedAt: Schema.NullOr(IsoDateTimeSchema),
  status: Schema.Literals(["active", "inactive"]),
  syncedAt: IsoDateTimeSchema,
  type: Schema.String,
} as const;

/** Account normalized by a provider before BankGlass assigns local identity. */
export const ProviderAccountSchema = Schema.Struct({
  ...AccountFields,
  providerAccountId: ProviderAccountIdSchema,
});
/** Account normalized by a provider before BankGlass assigns local identity. */
export type ProviderAccount = typeof ProviderAccountSchema.Type;

/** Account persisted and exposed by BankGlass. */
export const BankAccountSchema = Schema.Struct({
  ...AccountFields,
  connectionId: ConnectionIdSchema,
  id: AccountIdSchema,
  providerAccountId: ProviderAccountIdSchema,
  providerId: ProviderIdSchema,
});
/** Account persisted and exposed by BankGlass. */
export type BankAccount = typeof BankAccountSchema.Type;
