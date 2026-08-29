import { Data } from "effect";

/** Indicates that another synchronization currently owns the store lease. */
export class SyncInProgressError extends Data.TaggedError(
  "SyncInProgressError"
)<Record<string, never>> {}
