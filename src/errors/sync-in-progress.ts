import { Data } from "effect";

export class SyncInProgressError extends Data.TaggedError(
  "SyncInProgressError"
)<Record<string, never>> {}
