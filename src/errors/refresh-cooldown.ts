import { Data } from "effect";

export class RefreshCooldownError extends Data.TaggedError(
  "RefreshCooldownError"
)<{ readonly retryAt: string }> {}
