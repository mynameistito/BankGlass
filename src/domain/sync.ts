import { Schema } from "effect";

import {
  ConnectionIdSchema,
  IsoDateTimeSchema,
  ProviderIdSchema,
} from "@/domain/identifiers";

/** Synchronization state for one provider connection. */
export const SyncStatusSchema = Schema.Struct({
  connectionId: ConnectionIdSchema,
  errorCode: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  lastAttemptAt: Schema.NullOr(IsoDateTimeSchema),
  lastProviderRefreshRequestedAt: Schema.NullOr(IsoDateTimeSchema),
  lastSuccessAt: Schema.NullOr(IsoDateTimeSchema),
  providerId: ProviderIdSchema,
  providerRefreshedAt: Schema.NullOr(IsoDateTimeSchema),
  startedAt: Schema.NullOr(IsoDateTimeSchema),
  status: Schema.Literals(["idle", "syncing", "refreshing", "failed"]),
});
/** Synchronization state for one provider connection. */
export type SyncStatus = typeof SyncStatusSchema.Type;

/** How an application synchronization should treat upstream freshness. */
export type SyncRefreshMode = "RequestIfSupported" | "ReadAvailable";

/** Successful synchronization result for one connection. */
export interface ConnectionSyncSuccess {
  readonly _tag: "Success";
  readonly accounts: number;
  readonly connectionId: typeof ConnectionIdSchema.Type;
  readonly pendingTransactions: number;
  readonly postedTransactions: number;
  readonly providerId: typeof ProviderIdSchema.Type;
  readonly providerRefreshedAt: string | null;
  readonly syncedAt: string;
}

interface ConnectionSyncFailure {
  readonly _tag: "Failure";
  readonly connectionId: typeof ConnectionIdSchema.Type;
  readonly errorTag: string;
  readonly providerId: typeof ProviderIdSchema.Type;
}

/** Isolated result of synchronizing one enabled connection. */
export type ConnectionSyncOutcome =
  | ConnectionSyncSuccess
  | ConnectionSyncFailure;
