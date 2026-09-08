import { Schema } from "effect";

/** Non-empty trimmed string used by persisted identifiers and labels. */
export const NonEmptyStringSchema = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value: string) => value.trim().length > 0))
);

/** Canonical UTC ISO 8601 timestamp suitable for lexicographic persistence ordering. */
export const IsoDateTimeSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
        return false;
      }
      const millis = Date.parse(value);
      return !Number.isNaN(millis) && new Date(millis).toISOString() === value;
    })
  )
);

/** Stable identifier for a BankGlass provider implementation. */
export const ProviderIdSchema = NonEmptyStringSchema.pipe(
  Schema.brand("ProviderId")
);
/** Stable identifier for a BankGlass provider implementation. */
export type ProviderId = typeof ProviderIdSchema.Type;

/** Stable identifier for one configured instance of a provider. */
export const ConnectionIdSchema = NonEmptyStringSchema.pipe(
  Schema.brand("ConnectionId")
);
/** Stable identifier for one configured instance of a provider. */
export type ConnectionId = typeof ConnectionIdSchema.Type;

/** BankGlass-local identifier for an account. */
export const AccountIdSchema = NonEmptyStringSchema.pipe(
  Schema.brand("AccountId")
);
/** BankGlass-local identifier for an account. */
export type AccountId = typeof AccountIdSchema.Type;

/** BankGlass-local identifier for a transaction. */
export const TransactionIdSchema = NonEmptyStringSchema.pipe(
  Schema.brand("TransactionId")
);

/** Account identifier assigned by one upstream provider connection. */
export const ProviderAccountIdSchema = NonEmptyStringSchema.pipe(
  Schema.brand("ProviderAccountId")
);

/** Transaction identifier assigned or derived within one upstream provider connection. */
export const ProviderTransactionIdSchema = NonEmptyStringSchema.pipe(
  Schema.brand("ProviderTransactionId")
);
