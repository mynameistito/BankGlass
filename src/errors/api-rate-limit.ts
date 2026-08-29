import { Data } from "effect";

/** Indicates that a caller exceeded BankGlass's local request quota. */
export class ApiRateLimitError extends Data.TaggedError("ApiRateLimitError")<{
  /** Number of seconds before the caller may retry. */
  readonly retryAfterSeconds: number;
}> {}
