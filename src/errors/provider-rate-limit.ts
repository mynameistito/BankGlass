import { Data } from "effect";

/** Indicates that Akahu throttled a provider request. */
export class ProviderRateLimitError extends Data.TaggedError(
  "ProviderRateLimitError"
)<{
  /** Provider-supplied retry delay, when available. */
  readonly retryAfterSeconds: number | null;
}> {}
