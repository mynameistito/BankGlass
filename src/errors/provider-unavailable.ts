import { Data } from "effect";

/** Indicates a transient or transport-level provider failure. */
export class ProviderUnavailableError extends Data.TaggedError(
  "ProviderUnavailableError"
)<{
  /** Provider operation that failed. */
  readonly operation: string;
  /** Underlying failure, retained for diagnostics. */
  readonly cause: unknown;
}> {}
