import { Schema } from "effect";

import {
  AccountIdSchema,
  ConnectionIdSchema,
  IsoDateTimeSchema,
  ProviderAccountIdSchema,
  ProviderIdSchema,
} from "@/domain/identifiers";

const ProviderAccountFields = {
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
  type: Schema.String,
} as const;

/** Account normalized by a provider before BankGlass assigns local identity. */
export const ProviderAccountSchema = Schema.Struct({
  ...ProviderAccountFields,
  providerAccountId: ProviderAccountIdSchema,
});
/** Account normalized by a provider before BankGlass assigns local identity. */
export type ProviderAccount = typeof ProviderAccountSchema.Type;

/** Account persisted and exposed by BankGlass. */
export const BankAccountSchema = Schema.Struct({
  ...ProviderAccountFields,
  connectionId: ConnectionIdSchema,
  id: AccountIdSchema,
  providerAccountId: ProviderAccountIdSchema,
  providerId: ProviderIdSchema,
  syncedAt: IsoDateTimeSchema,
});
/** Account persisted and exposed by BankGlass. */
export type BankAccount = typeof BankAccountSchema.Type;

/** Filters for aggregate account reads. */
export interface AccountQuery {
  /** Restrict results to one connection, or include all when `null`. */
  readonly connectionId: typeof ConnectionIdSchema.Type | null;
  /** Restrict results to one provider, or include all when `null`. */
  readonly providerId: typeof ProviderIdSchema.Type | null;
}
