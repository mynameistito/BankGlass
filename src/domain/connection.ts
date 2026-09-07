import { Schema } from "effect";

import { ConnectionIdSchema, ProviderIdSchema } from "@/domain/identifiers";

const IsoDateTimeSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => !Number.isNaN(Date.parse(value)))
  )
);

/** Authorization lifecycle for a configured provider connection. */
export const ConnectionAuthorizationSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("PendingAuthorization") }),
  Schema.Struct({ _tag: Schema.Literal("Connected") }),
  Schema.Struct({
    _tag: Schema.Literal("ConsentExpiring"),
    expiresAt: IsoDateTimeSchema,
  }),
  Schema.Struct({ _tag: Schema.Literal("ReauthorizationRequired") }),
  Schema.Struct({ _tag: Schema.Literal("Revoked") }),
  Schema.Struct({ _tag: Schema.Literal("Failed") }),
]);
/** Authorization lifecycle for a configured provider connection. */
export type ConnectionAuthorization = typeof ConnectionAuthorizationSchema.Type;

/** Persisted, non-secret metadata for one configured provider connection. */
export const BankConnectionSchema = Schema.Struct({
  authorization: ConnectionAuthorizationSchema,
  createdAt: IsoDateTimeSchema,
  enabled: Schema.Boolean,
  id: ConnectionIdSchema,
  label: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  lastSyncAt: Schema.NullOr(IsoDateTimeSchema),
  metadata: Schema.Record({ key: Schema.String, value: Schema.String }),
  providerId: ProviderIdSchema,
  updatedAt: IsoDateTimeSchema,
});
/** Persisted, non-secret metadata for one configured provider connection. */
export type BankConnection = typeof BankConnectionSchema.Type;
