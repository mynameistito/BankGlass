import { Data } from "effect";

/** Indicates that an upstream provider throttled a request. */
export class ProviderRateLimitError extends Data.TaggedError(
  "ProviderRateLimitError"
)<{
  /** Provider-supplied retry delay, when available. */
  readonly retryAfterSeconds: number | null;
}> {}
