import { Schema } from "effect";

import {
  ConnectionIdSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  ProviderIdSchema,
} from "@/domain/identifiers";

const ConnectionAuthorizationSchema = Schema.Union([
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

/** Persisted, non-secret metadata for one configured provider connection. */
export const BankConnectionSchema = Schema.Struct({
  authorization: ConnectionAuthorizationSchema,
  createdAt: IsoDateTimeSchema,
  enabled: Schema.Boolean,
  id: ConnectionIdSchema,
  label: NonEmptyStringSchema,
  lastSyncAt: Schema.NullOr(IsoDateTimeSchema),
  metadata: Schema.Record(Schema.String, Schema.String),
  providerId: ProviderIdSchema,
  updatedAt: IsoDateTimeSchema,
});
/** Persisted, non-secret metadata for one configured provider connection. */
export type BankConnection = typeof BankConnectionSchema.Type;
