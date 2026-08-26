import { Data } from "effect";

export class ProviderUnavailableError extends Data.TaggedError(
  "ProviderUnavailableError"
)<{ readonly operation: string; readonly cause: unknown }> {}
