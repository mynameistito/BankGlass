import { Data } from "effect";

/** Indicates that an upstream response did not match the expected contract. */
export class InvalidProviderResponseError extends Data.TaggedError(
  "InvalidProviderResponseError"
)<{
  /** Provider operation that returned the invalid response. */
  readonly operation: string;
  /** Safe description of the decoding or consistency failure. */
  readonly details: string;
}> {}
