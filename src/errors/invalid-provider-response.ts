import { Data } from "effect";

export class InvalidProviderResponseError extends Data.TaggedError(
  "InvalidProviderResponseError"
)<{ readonly operation: string; readonly details: string }> {}
