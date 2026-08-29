import { Data } from "effect";

/** Indicates that an upstream refresh was requested too recently. */
export class RefreshCooldownError extends Data.TaggedError(
  "RefreshCooldownError"
)<{
  /** ISO timestamp at which another refresh may be requested. */
  readonly retryAt: string;
}> {}
