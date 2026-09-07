import { Schema } from "effect";

const NonEmptyIdentifier = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value: string) => value.trim().length > 0))
);

/** Stable identifier for a BankGlass provider implementation. */
export const ProviderIdSchema = NonEmptyIdentifier.pipe(
  Schema.brand("ProviderId")
);
/** Stable identifier for a BankGlass provider implementation. */
export type ProviderId = typeof ProviderIdSchema.Type;

/** Stable identifier for one configured instance of a provider. */
export const ConnectionIdSchema = NonEmptyIdentifier.pipe(
  Schema.brand("ConnectionId")
);
/** Stable identifier for one configured instance of a provider. */
export type ConnectionId = typeof ConnectionIdSchema.Type;

/** BankGlass-local identifier for an account. */
export const AccountIdSchema = NonEmptyIdentifier.pipe(
  Schema.brand("AccountId")
);
/** BankGlass-local identifier for an account. */
export type AccountId = typeof AccountIdSchema.Type;

/** BankGlass-local identifier for a transaction. */
export const TransactionIdSchema = NonEmptyIdentifier.pipe(
  Schema.brand("TransactionId")
);

/** Account identifier assigned by one upstream provider connection. */
export const ProviderAccountIdSchema = NonEmptyIdentifier.pipe(
  Schema.brand("ProviderAccountId")
);

/** Transaction identifier assigned or derived within one upstream provider connection. */
export const ProviderTransactionIdSchema = NonEmptyIdentifier.pipe(
  Schema.brand("ProviderTransactionId")
);
