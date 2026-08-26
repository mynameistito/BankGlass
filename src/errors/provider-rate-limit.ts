import { Data } from "effect";

export class ProviderRateLimitError extends Data.TaggedError(
  "ProviderRateLimitError"
)<{ readonly retryAfterSeconds: number | null }> {}
